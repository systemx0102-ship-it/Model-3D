// Position-based cloth (XPBD) for garments hanging from the body: a particle grid plus optional
// rope chains, no three.js dependency (runs identically in the browser, in tests and in Node).
//
//   * XPBD distance constraints: stretch, shear and bending (skip-one) with physical compliance,
//     so stiffness does not depend on the iteration count or the time step
//   * long-range attachments (tethers) to the pinned row: no rubbery stretching under gravity
//   * pins carried by an anchor bone (rigid transform), interpolated per substep by the caller
//   * per-triangle aerodynamics (pressure drag + lift along the normal, light skin friction)
//     against gusty wind; particle drag for rope chains
//   * sphere / capsule collisions with friction and a ground plane
//   * inertia scale (fraction of the anchor's rigid motion the cloth "feels"), velocity clamp and
//     teleport detection
// The caller advances it on a fixed clock (FixedStep, 120 Hz) so results are frame-rate independent.
import { xform, mulMat, invRigid, mulberry } from './strands.js';

export const CLOTH_DEFAULTS = {
  dt: 1 / 120,
  iterations: 8,
  gravity: -9.81,
  stretchCompliance: 1e-6, // m/N: nearly inextensible woven cotton (k ~ 1e6 N/m)
  shearCompliance: 1e-3,
  bendCompliance: 0.6, // soft (k ~ 1.7 N/m): flannel drapes and buckles under its own weight
  ropeBendCompliance: 0.05, // rolled sleeves are stiffer than flat cloth
  damping: 0.012, // velocity loss per step (internal friction)
  areaDensity: 0.22, // kg/m2 (flannel ~ 200 g/m2)
  drag: 0.9, // normal pressure drag coefficient
  lift: 0.25,
  skin: 0.04, // tangential skin-friction coefficient
  radius: 0.005, // cloth thickness for collisions (m)
  friction: 0.45,
  inertia: 0.85,
  maxSpeed: 9,
  turbulence: 0.4,
};

export class ClothSim {
  /**
   * @param restLocal  Float32Array(n*3) particle rest positions in the anchor's local space
   * @param grid       { W, H, dx, lengths[W] } particle grid occupying indices [0, W*H)
   * @param chains     [{ start, count, seg }] rope chains (first particle of each is pinned)
   * @param pins       particle indices that follow the anchor exactly
   */
  constructor({ restLocal, grid, chains = [], pins = [], params = {} }) {
    this.p = { ...CLOTH_DEFAULTS, ...params };
    const n = restLocal.length / 3;
    this.n = n;
    this.restLocal = Float32Array.from(restLocal);
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.w = new Float32Array(n).fill(1); // inverse mass (scaled below)
    this.pinned = new Uint8Array(n);
    for (const i of pins) (this.pinned[i] = 1), (this.w[i] = 0);
    this.grid = grid;
    this.chains = chains;
    const cons = []; // [a, b, rest, compliance]
    const tethers = []; // [i, anchorParticle, maxLen]
    const { W, H, dx, lengths } = grid;
    const id = (r, c) => r * W + c;
    const dyOf = (c) => lengths[c] / (H - 1);
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        if (c + 1 < W) cons.push([id(r, c), id(r, c + 1), dx, 's']);
        if (r + 1 < H) cons.push([id(r, c), id(r + 1, c), dyOf(c), 's']);
        if (r + 1 < H && c + 1 < W) {
          const d = Math.hypot(dx, (dyOf(c) + dyOf(c + 1)) / 2);
          cons.push([id(r, c), id(r + 1, c + 1), d, 'h'], [id(r, c + 1), id(r + 1, c), d, 'h']);
        }
        if (c + 2 < W) cons.push([id(r, c), id(r, c + 2), 2 * dx, 'b']);
        if (r + 2 < H) cons.push([id(r, c), id(r + 2, c), 2 * dyOf(c), 'b']);
        if (r > 0) tethers.push([id(r, c), id(0, c), r * dyOf(c) * 1.02]);
      }
    for (const ch of chains) {
      for (let i = 0; i + 1 < ch.count; i++) cons.push([ch.start + i, ch.start + i + 1, ch.seg, 's']);
      for (let i = 0; i + 2 < ch.count; i++) cons.push([ch.start + i, ch.start + i + 2, ch.seg * 2, 'r']);
      for (let i = 1; i < ch.count; i++) tethers.push([ch.start + i, ch.start, i * ch.seg * 1.02]);
    }
    const comp = { s: this.p.stretchCompliance, h: this.p.shearCompliance, b: this.p.bendCompliance, r: this.p.ropeBendCompliance };
    this.cA = Int32Array.from(cons.map((c) => c[0]));
    this.cB = Int32Array.from(cons.map((c) => c[1]));
    this.cL = Float32Array.from(cons.map((c) => c[2]));
    this.cC = Float32Array.from(cons.map((c) => comp[c[3]]));
    this.cLambda = new Float32Array(cons.length);
    this.tI = Int32Array.from(tethers.map((t) => t[0]));
    this.tA = Int32Array.from(tethers.map((t) => t[1]));
    this.tL = Float32Array.from(tethers.map((t) => t[2]));
    // particle masses from the fabric's area density (grid) / a nominal mass (rope)
    const cell = dx * (lengths.reduce((a, b) => a + b, 0) / W / (H - 1));
    const mGrid = this.p.areaDensity * cell;
    for (let i = 0; i < W * H; i++) if (!this.pinned[i]) this.w[i] = 1 / mGrid;
    for (const ch of chains) for (let i = 1; i < ch.count; i++) this.w[ch.start + i] = 1 / 0.012;
    this.mass = Float32Array.from(this.w, (w) => (w > 0 ? 1 / w : 0));
    // triangles for aerodynamics
    const tris = [];
    for (let r = 0; r + 1 < H; r++)
      for (let c = 0; c + 1 < W; c++) tris.push(id(r, c), id(r, c + 1), id(r + 1, c), id(r, c + 1), id(r + 1, c + 1), id(r + 1, c));
    this.tris = Int32Array.from(tris);
    this.force = new Float32Array(n * 3);
    this.wind = [0, 0, 0];
    this.time = 0;
    this.phase = mulberry(91)() * 100;
    this.lastAnchor = null;
    this.groundY = -Infinity;
  }

  /** Places every particle at its rest pose under the anchor and clears velocities. */
  reset(anchor) {
    for (let i = 0; i < this.n; i++) {
      const r = xform(anchor, this.restLocal[i * 3], this.restLocal[i * 3 + 1], this.restLocal[i * 3 + 2]);
      this.pos.set(r, i * 3);
      this.prev.set(r, i * 3);
    }
    this.lastAnchor = anchor.slice();
  }

  /**
   * One fixed step.
   * @param anchor     anchor bone world matrix at the end of the step (16 floats, column-major)
   * @param colliders  [{type:'sphere', c, r, friction?} | {type:'capsule', a, b, r, friction?}]
   */
  step(anchor, colliders) {
    const P = this.p, dt = P.dt, n = this.n;
    const { pos, prev, w } = this;
    if (!this.lastAnchor) this.reset(anchor);
    const last = this.lastAnchor;
    if (Math.hypot(anchor[12] - last[12], anchor[13] - last[13], anchor[14] - last[14]) > 0.5) {
      this.reset(anchor);
      return;
    }
    this.time += dt;
    // inertia scale: carry part of the anchor's rigid motion
    const carry = 1 - P.inertia;
    if (carry > 0) {
      const delta = mulMat(anchor, invRigid(last));
      for (let i = 0; i < n; i++) {
        if (this.pinned[i]) continue;
        const o = i * 3;
        const a = xform(delta, pos[o], pos[o + 1], pos[o + 2]);
        const b = xform(delta, prev[o], prev[o + 1], prev[o + 2]);
        for (let k = 0; k < 3; k++) {
          pos[o + k] += (a[k] - pos[o + k]) * carry;
          prev[o + k] += (b[k] - prev[o + k]) * carry;
        }
      }
    }
    this.aero(dt);
    // integrate (symplectic Euler on positions)
    const damp = 1 - P.damping, vmax = P.maxSpeed;
    for (let i = 0; i < n; i++) {
      if (this.pinned[i]) continue;
      const o = i * 3, inv = w[i];
      for (let k = 0; k < 3; k++) {
        let v = ((pos[o + k] - prev[o + k]) / dt) * damp + this.force[o + k] * inv * dt;
        if (k === 1) v += P.gravity * dt;
        if (v > vmax) v = vmax; else if (v < -vmax) v = -vmax;
        prev[o + k] = pos[o + k];
        pos[o + k] += v * dt;
      }
    }
    // pins follow the anchor
    for (let i = 0; i < n; i++) {
      if (!this.pinned[i]) continue;
      const o = i * 3;
      const r = xform(anchor, this.restLocal[o], this.restLocal[o + 1], this.restLocal[o + 2]);
      prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
      pos[o] = r[0]; pos[o + 1] = r[1]; pos[o + 2] = r[2];
    }
    // XPBD solve
    this.cLambda.fill(0);
    const dt2 = dt * dt;
    const { cA, cB, cL, cC, cLambda, tI, tA, tL } = this;
    for (let it = 0; it < P.iterations; it++) {
      for (let c = 0; c < cA.length; c++) {
        const a = cA[c], b = cB[c];
        const wa = w[a], wb = w[b];
        const ws = wa + wb;
        if (ws === 0) continue;
        const oa = a * 3, ob = b * 3;
        const dx = pos[oa] - pos[ob], dy = pos[oa + 1] - pos[ob + 1], dz = pos[oa + 2] - pos[ob + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-9) continue;
        const alpha = cC[c] / dt2;
        const C = d - cL[c];
        const dl = (-C - alpha * cLambda[c]) / (ws + alpha);
        cLambda[c] += dl;
        const s = dl / d;
        pos[oa] += dx * s * wa; pos[oa + 1] += dy * s * wa; pos[oa + 2] += dz * s * wa;
        pos[ob] -= dx * s * wb; pos[ob + 1] -= dy * s * wb; pos[ob + 2] -= dz * s * wb;
      }
      // tethers (inequality: only pull back when too far from the pinned row)
      for (let t = 0; t < tI.length; t++) {
        const i = tI[t], a = tA[t];
        const oi = i * 3, oa = a * 3;
        const dx = pos[oi] - pos[oa], dy = pos[oi + 1] - pos[oa + 1], dz = pos[oi + 2] - pos[oa + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= tL[t]) continue;
        const s = tL[t] / d;
        pos[oi] = pos[oa] + dx * s; pos[oi + 1] = pos[oa + 1] + dy * s; pos[oi + 2] = pos[oa + 2] + dz * s;
      }
      if (it >= P.iterations - 3) this.collide(colliders);
    }
  }

  /** Pressure drag / lift per triangle against gusty wind; plain drag for rope particles. */
  aero(dt) {
    const P = this.p, { pos, prev, tris, force } = this;
    force.fill(0);
    const t = this.time + this.phase;
    const gust = 1 + P.turbulence * (Math.sin(t * 1.3) * 0.6 + Math.sin(t * 3.7 + 1.1) * 0.4);
    const wx = this.wind[0] * gust, wy = this.wind[1] * gust, wz = this.wind[2] * gust;
    const rho = 1.2;
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k] * 3, b = tris[k + 1] * 3, c = tris[k + 2] * 3;
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const twoA = Math.hypot(nx, ny, nz);
      if (twoA < 1e-12) continue;
      nx /= twoA; ny /= twoA; nz /= twoA;
      const area = twoA / 2;
      // relative air velocity at the triangle
      let vx = 0, vy = 0, vz = 0;
      for (const o of [a, b, c]) (vx += pos[o] - prev[o]), (vy += pos[o + 1] - prev[o + 1]), (vz += pos[o + 2] - prev[o + 2]);
      vx = vx / (3 * dt) - wx; vy = vy / (3 * dt) - wy; vz = vz / (3 * dt) - wz;
      const vn = vx * nx + vy * ny + vz * nz;
      const sp = Math.hypot(vx, vy, vz);
      // pressure (normal) + a little lift and skin friction
      const fn = -0.5 * rho * area * (P.drag * vn * Math.abs(vn) + P.lift * vn * sp * 0.2);
      const ft = -0.5 * rho * area * P.skin * sp;
      const fx = (fn * nx + ft * vx) / 3, fy = (fn * ny + ft * vy) / 3, fz = (fn * nz + ft * vz) / 3;
      for (const o of [a, b, c]) (force[o] += fx), (force[o + 1] += fy), (force[o + 2] += fz);
    }
    for (const ch of this.chains)
      for (let i = 1; i < ch.count; i++) {
        const o = (ch.start + i) * 3;
        const k = 0.5 * rho * 0.9 * 0.04 * ch.seg; // ~4 cm wide rolled sleeve
        for (let j = 0; j < 3; j++) {
          const v = (pos[o + j] - prev[o + j]) / dt - [wx, wy, wz][j];
          force[o + j] -= k * v * Math.abs(v);
        }
      }
  }

  collide(colliders) {
    const P = this.p, { pos, prev } = this;
    const rad = P.radius, gy = this.groundY + rad;
    for (let i = 0; i < this.n; i++) {
      if (this.pinned[i]) continue;
      const o = i * 3;
      for (let j = 0; j < colliders.length; j++) {
        const c = colliders[j];
        let cx, cy, cz;
        if (c.type === 'sphere') (cx = c.c[0]), (cy = c.c[1]), (cz = c.c[2]);
        else {
          const ax = c.a[0], ay = c.a[1], az = c.a[2];
          const bx = c.b[0] - ax, by = c.b[1] - ay, bz = c.b[2] - az;
          const t = Math.max(0, Math.min(1, ((pos[o] - ax) * bx + (pos[o + 1] - ay) * by + (pos[o + 2] - az) * bz) / (bx * bx + by * by + bz * bz)));
          cx = ax + bx * t; cy = ay + by * t; cz = az + bz * t;
        }
        const dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
        const R = c.r + rad;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        pos[o] = cx + nx * R; pos[o + 1] = cy + ny * R; pos[o + 2] = cz + nz * R;
        const vx = pos[o] - prev[o], vy = pos[o + 1] - prev[o + 1], vz = pos[o + 2] - prev[o + 2];
        const vn = vx * nx + vy * ny + vz * nz;
        const f = c.friction ?? P.friction;
        prev[o] += (vx - vn * nx) * f; prev[o + 1] += (vy - vn * ny) * f; prev[o + 2] += (vz - vn * nz) * f;
      }
      if (pos[o + 1] < gy) {
        pos[o + 1] = gy;
        prev[o] += (pos[o] - prev[o]) * 0.6; prev[o + 2] += (pos[o + 2] - prev[o + 2]) * 0.6;
      }
    }
  }

  /** Largest relative stretch of the structural constraints (diagnostics / tests). */
  maxStrain() {
    let m = 0;
    for (let c = 0; c < this.cA.length; c++) {
      if (this.cC[c] !== this.p.stretchCompliance) continue;
      const a = this.cA[c] * 3, b = this.cB[c] * 3;
      const d = Math.hypot(this.pos[a] - this.pos[b], this.pos[a + 1] - this.pos[b + 1], this.pos[a + 2] - this.pos[b + 2]);
      m = Math.max(m, d / this.cL[c] - 1);
    }
    return m;
  }
}
