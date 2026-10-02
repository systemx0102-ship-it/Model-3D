// Guide-strand hair simulation (position-based, no three.js dependency; shared by the build-time
// groom draping and the runtime). Each guide is a chain of particles: particle 0 is the root,
// attached to the head; the rest are integrated with Verlet and projected onto constraints:
//
//   * follow-the-leader inextensibility with velocity correction (Müller et al. 2012, "DFTL") —
//     unconditionally stable, no stretching
//   * global shape stiffness: pull toward the groomed rest shape carried by the head transform
//     (strong at roots, weak at tips — roots almost fixed, tips free)
//   * local bending stiffness: preserve the rest angle relative to the parent segment, so waves
//     and the styled fall survive motion instead of collapsing into a rope
//   * sphere / capsule collisions with friction (head, neck, shoulders, chest, back, arms)
//   * guide-guide repulsion to keep volume, air drag + wind turbulence
//   * per-guide random variation of every parameter so neighbouring locks never move in sync
//
// Stability: fixed time step, velocity clamp, stretch clamp and teleport detection.

export const ZONE_DEFAULTS = {
  // profile values are [root, mid, tip]; interpolated along normalised arc length
  global: [0.9, 0.06, 0.004], // pull toward rest shape (per substep fraction)
  bend: [0.85, 0.35, 0.14], // keep rest angle w.r.t. parent segment
  damping: [0.12, 0.035, 0.02], // velocity loss per substep (air + internal friction)
  drag: 1.1, // aerodynamic drag coefficient (1/s) relative to the air (wind)
  gravity: 1.0,
  radius: 0.004, // collision thickness of the lock (m)
  inertia: 0.82, // fraction of head linear motion the hair "feels" (UE-style inertia scale)
  angularInertia: 0.85,
};

const lerp3 = (p, t) => (t < 0.5 ? p[0] + (p[1] - p[0]) * (t / 0.5) : p[1] + (p[2] - p[1]) * ((t - 0.5) / 0.5));

export class StrandSim {
  /**
   * @param guides  [{ rest: Float32Array (n*3, head-local), zone: string, seed: number }]
   * @param zones   { name: partial ZONE_DEFAULTS }
   */
  constructor(guides, zones = {}, { dt = 1 / 120, iterations = 3 } = {}) {
    this.dt = dt;
    this.iterations = iterations;
    this.G = guides.length;
    this.N = guides[0].rest.length / 3; // particles per guide (uniform)
    const G = this.G, N = this.N;
    this.restLocal = new Float32Array(G * N * 3);
    this.pos = new Float32Array(G * N * 3);
    this.prev = new Float32Array(G * N * 3);
    this.restLen = new Float32Array(G * N);
    this.restDirLocal = new Float32Array(G * N * 3); // segment direction in parent-segment frame
    this.params = []; // per guide, per particle stiffness tables
    this.k = { global: new Float32Array(G * N), bend: new Float32Array(G * N), damp: new Float32Array(G * N) };
    this.guideDrag = new Float32Array(G);
    this.guideGravity = new Float32Array(G);
    this.guideRadius = new Float32Array(G);
    this.guideInertia = new Float32Array(G * 2);
    this.phase = new Float32Array(G);
    this.colliders = [];
    this.wind = [0, 0, 0];
    this.turbulence = 0.35;
    this.time = 0;
    this.stiffnessScale = 1;
    this.dampingScale = 1;

    guides.forEach((g, gi) => {
      const z = { ...ZONE_DEFAULTS, ...(zones[g.zone] ?? {}) };
      // deterministic per-guide variation (±15 %) so locks desynchronise
      const r = mulberry(g.seed ?? gi + 1);
      const vary = () => 1 + (r() * 2 - 1) * 0.15;
      const vg = vary(), vb = vary(), vd = vary();
      this.guideDrag[gi] = z.drag * vary();
      this.guideGravity[gi] = z.gravity * (1 + (r() * 2 - 1) * 0.05);
      this.guideRadius[gi] = z.radius;
      this.guideInertia[gi * 2] = Math.min(1, z.inertia * (1 + (r() * 2 - 1) * 0.04));
      this.guideInertia[gi * 2 + 1] = Math.min(1, z.angularInertia * (1 + (r() * 2 - 1) * 0.04));
      this.phase[gi] = r() * 1000;
      let total = 0;
      for (let i = 1; i < N; i++) {
        const o = i * 3, p = o - 3; // g.rest is this guide's own array
        const len = Math.hypot(g.rest[o] - g.rest[p], g.rest[o + 1] - g.rest[p + 1], g.rest[o + 2] - g.rest[p + 2]);
        this.restLen[gi * N + i] = len;
        total += len;
      }
      let acc = 0;
      for (let i = 0; i < N; i++) {
        acc += this.restLen[gi * N + i];
        const t = total > 0 ? acc / total : 0;
        this.k.global[gi * N + i] = lerp3(z.global, t) * vg;
        this.k.bend[gi * N + i] = lerp3(z.bend, t) * vb;
        this.k.damp[gi * N + i] = lerp3(z.damping, t) * vd;
      }
      this.restLocal.set(g.rest, gi * N * 3);
    });
    this.computeRestFrames();
    // stiffness / damping are authored as per-step fractions at 120 Hz; keep the originals so the
    // solver can run at another fixed rate with equivalent behaviour (see setDt)
    this.k120 = { global: this.k.global.slice(), bend: this.k.bend.slice(), damp: this.k.damp.slice() };
    this.setDt(dt);
  }

  /** Changes the fixed step, converting per-step fractions: k' = 1 - (1 - k)^(dt * 120). */
  setDt(dt) {
    this.dt = dt;
    const e = dt * 120;
    for (const key of ['global', 'bend', 'damp']) {
      const src = this.k120[key], dst = this.k[key];
      for (let i = 0; i < src.length; i++) dst[i] = 1 - Math.pow(Math.max(0, 1 - Math.min(1, src[i])), e);
    }
  }

  /** Rest direction of each segment expressed in its parent segment's frame. */
  computeRestFrames() {
    const { G, N, restLocal } = this;
    const q = [0, 0, 0, 1];
    for (let g = 0; g < G; g++)
      for (let i = 1; i < N; i++) {
        const o = (g * N + i) * 3, p = o - 3;
        const d = norm([restLocal[o] - restLocal[p], restLocal[o + 1] - restLocal[p + 1], restLocal[o + 2] - restLocal[p + 2]]);
        let parent;
        if (i === 1) parent = [0, 1, 0]; // root segment is measured against the head's up axis
        else parent = norm([restLocal[p] - restLocal[p - 3], restLocal[p + 1] - restLocal[p - 2], restLocal[p + 2] - restLocal[p - 1]]);
        // rotation taking parent -> +Y, applied to d
        arcQuat(parent, [0, 1, 0], q);
        const v = qrot(q, d);
        this.restDirLocal.set(v, o);
      }
  }

  /** Place every particle at its rest pose under the given head transform (reset/teleport). */
  reset(head) {
    const { G, N } = this;
    for (let i = 0; i < G * N; i++) {
      const v = xform(head, this.restLocal[i * 3], this.restLocal[i * 3 + 1], this.restLocal[i * 3 + 2]);
      this.pos.set(v, i * 3);
      this.prev.set(v, i * 3);
    }
    this.lastHead = head.slice();
  }

  /**
   * Advance one fixed step. Allocation-free inner loops: rest positions are transformed once per
   * step, colliders are flattened and culled per guide against the guide's bounding box.
   * @param head   head transform at the END of this step: 16-float column-major matrix
   * @param colliders [{type:'sphere', c:[x,y,z], r} | {type:'capsule', a, b, r}] at the end of the step
   */
  step(head, colliders) {
    const { G, N, dt, pos, prev } = this;
    if (!this.lastHead) this.reset(head);
    const lastHead = this.lastHead;
    // teleport / root-motion snap detection
    const jump = Math.hypot(head[12] - lastHead[12], head[13] - lastHead[13], head[14] - lastHead[14]);
    if (jump > 0.35) {
      this.reset(head);
      return;
    }
    this.time += dt;
    const wind = this.wind;
    const M = head;
    // rest pose in world, once per step
    const rw = (this._restWorld ??= new Float32Array(G * N * 3));
    const rl = this.restLocal;
    for (let i = 0, n = G * N * 3; i < n; i += 3) {
      const x = rl[i], y = rl[i + 1], z = rl[i + 2];
      rw[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
      rw[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      rw[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
    }
    // inertia scale: move particles with a fraction (1 - inertia) of the head's rigid motion,
    // which tames whip-cracking on violent turns while keeping natural lag
    const D = mulMat(head, invRigid(lastHead));
    const KD = this.k.damp, ds = this.dampingScale;
    for (let g = 0; g < G; g++) {
      const li = this.guideInertia[g * 2], ai = this.guideInertia[g * 2 + 1];
      const carry = 1 - Math.min(li, ai);
      const drag = this.guideDrag[g];
      const grav = -9.81 * this.guideGravity[g];
      const ph = this.phase[g];
      // gusty wind: smooth noise in time, phase-shifted per guide (different timing/amplitude)
      const gust = 1 + this.turbulence * (Math.sin(this.time * 1.7 + ph) * 0.6 + Math.sin(this.time * 4.3 + ph * 1.3) * 0.4);
      const wx = wind[0] * gust, wy = wind[1] * gust, wz = wind[2] * gust;
      for (let i = 1; i < N; i++) {
        const o = (g * N + i) * 3;
        if (carry > 0) {
          let x = pos[o], y = pos[o + 1], z = pos[o + 2];
          pos[o] += (D[0] * x + D[4] * y + D[8] * z + D[12] - x) * carry;
          pos[o + 1] += (D[1] * x + D[5] * y + D[9] * z + D[13] - y) * carry;
          pos[o + 2] += (D[2] * x + D[6] * y + D[10] * z + D[14] - z) * carry;
          x = prev[o]; y = prev[o + 1]; z = prev[o + 2];
          prev[o] += (D[0] * x + D[4] * y + D[8] * z + D[12] - x) * carry;
          prev[o + 1] += (D[1] * x + D[5] * y + D[9] * z + D[13] - y) * carry;
          prev[o + 2] += (D[2] * x + D[6] * y + D[10] * z + D[14] - z) * carry;
        }
        const damp = 1 - Math.min(0.95, KD[g * N + i] * ds);
        let vx = ((pos[o] - prev[o]) / dt) * damp + drag * (wx - (pos[o] - prev[o]) / dt) * dt;
        let vy = ((pos[o + 1] - prev[o + 1]) / dt) * damp + (drag * (wy - (pos[o + 1] - prev[o + 1]) / dt) + grav) * dt;
        let vz = ((pos[o + 2] - prev[o + 2]) / dt) * damp + drag * (wz - (pos[o + 2] - prev[o + 2]) / dt) * dt;
        // m/s clamp: prevents explosions from bad frames
        vx = vx > 12 ? 12 : vx < -12 ? -12 : vx;
        vy = vy > 12 ? 12 : vy < -12 ? -12 : vy;
        vz = vz > 12 ? 12 : vz < -12 ? -12 : vz;
        prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
        pos[o] += vx * dt; pos[o + 1] += vy * dt; pos[o + 2] += vz * dt;
      }
      // root follows the head exactly
      const o = g * N * 3;
      pos[o] = prev[o] = rw[o]; pos[o + 1] = prev[o + 1] = rw[o + 1]; pos[o + 2] = prev[o + 2] = rw[o + 2];
    }
    // flattened colliders and per-guide candidate lists (bounding box test)
    const C = colliders.length;
    const cf = (this._cf = this._cf?.length >= C * 9 ? this._cf : new Float32Array(Math.max(16, C) * 9));
    for (let j = 0; j < C; j++) {
      const c = colliders[j], q = j * 9;
      if (c.type === 'sphere') (cf[q] = 0), (cf[q + 1] = c.c[0]), (cf[q + 2] = c.c[1]), (cf[q + 3] = c.c[2]), (cf[q + 4] = c.c[0]), (cf[q + 5] = c.c[1]), (cf[q + 6] = c.c[2]);
      else (cf[q] = 1), (cf[q + 1] = c.a[0]), (cf[q + 2] = c.a[1]), (cf[q + 3] = c.a[2]), (cf[q + 4] = c.b[0]), (cf[q + 5] = c.b[1]), (cf[q + 6] = c.b[2]);
      cf[q + 7] = c.r;
      cf[q + 8] = c.friction ?? 0.3;
    }
    // candidates per chunk of CH particles along each guide (tight boxes -> few colliders each)
    const CH = 8, nCh = Math.ceil(N / CH);
    const cand = (this._cand = this._cand?.length >= G * nCh * C ? this._cand : new Int32Array(Math.max(1, G * nCh * C)));
    const candN = (this._candN = this._candN?.length >= G * nCh ? this._candN : new Int32Array(G * nCh));
    for (let g = 0; g < G; g++) {
      const m = this.guideRadius[g] + 0.025; // margin: constraint moves within the step
      for (let ch = 0; ch < nCh; ch++) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        const i1 = Math.min(N, (ch + 1) * CH);
        for (let i = ch * CH; i < i1; i++) {
          const o = (g * N + i) * 3;
          const x = pos[o], y = pos[o + 1], z = pos[o + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        let k = 0;
        const base = (g * nCh + ch) * C;
        for (let j = 0; j < C; j++) {
          const q = j * 9, r = cf[q + 7] + m;
          if (Math.min(cf[q + 1], cf[q + 4]) - r > x1 || Math.max(cf[q + 1], cf[q + 4]) + r < x0) continue;
          if (Math.min(cf[q + 2], cf[q + 5]) - r > y1 || Math.max(cf[q + 2], cf[q + 5]) + r < y0) continue;
          if (Math.min(cf[q + 3], cf[q + 6]) - r > z1 || Math.max(cf[q + 3], cf[q + 6]) + r < z0) continue;
          cand[base + k++] = j;
        }
        candN[g * nCh + ch] = k;
      }
    }
    // head rotation as a quaternion (root segment bending reference = head +Y)
    const hq = rotOf(head);
    const hux = 2 * (hq[0] * hq[1] - hq[3] * hq[2]), huy = 1 - 2 * (hq[0] * hq[0] + hq[2] * hq[2]), huz = 2 * (hq[1] * hq[2] + hq[3] * hq[0]);
    const iters = this.iterations;
    const rd = this.restDirLocal;
    const KG = this.k.global, KB = this.k.bend, RL = this.restLen, GR = this.guideRadius, ss = this.stiffnessScale;
    for (let it = 0; it < iters; it++) {
      for (let g = 0; g < G; g++) {
        for (let i = 1; i < N; i++) {
          const o = (g * N + i) * 3, p = o - 3;
          const gi = g * N + i;
          // global shape: attraction toward the rest pose (in world via the head transform)
          const kg = Math.min(1, KG[gi] * ss) / iters;
          if (kg > 0) {
            pos[o] += (rw[o] - pos[o]) * kg; pos[o + 1] += (rw[o + 1] - pos[o + 1]) * kg; pos[o + 2] += (rw[o + 2] - pos[o + 2]) * kg;
          }
          // local bending: rest direction relative to the current parent segment
          const kb = Math.min(1, KB[gi] * ss) / iters;
          if (kb > 0) {
            let px, py, pz;
            if (i === 1) (px = hux), (py = huy), (pz = huz);
            else {
              px = pos[p] - pos[p - 3]; py = pos[p + 1] - pos[p - 2]; pz = pos[p + 2] - pos[p - 1];
              const l = Math.sqrt(px * px + py * py + pz * pz) || 1;
              px /= l; py /= l; pz /= l;
            }
            // shortest rotation +Y -> parent applied to the rest direction (Rodrigues form of the
            // half-way quaternion: no normalisation needed; k = Y x p, c = Y . p)
            const vx = rd[o], vy = rd[o + 1], vz = rd[o + 2];
            let dx, dy, dz;
            if (py > -0.9999) {
              const f = (pz * vx - px * vz) / (1 + py);
              dx = vx * py + px * vy + pz * f;
              dy = vy * py - px * vx - pz * vz;
              dz = vz * py + pz * vy - px * f;
            } else (dx = -vx), (dy = -vy), (dz = vz);
            const L = RL[gi];
            pos[o] += (pos[p] + dx * L - pos[o]) * kb;
            pos[o + 1] += (pos[p + 1] + dy * L - pos[o + 1]) * kb;
            pos[o + 2] += (pos[p + 2] + dz * L - pos[o + 2]) * kb;
          }
        }
        // collisions (with friction against the previous position), culled candidates only,
        const rad = GR[g];
        // (resolved on the final pass: earlier passes only shape the strand)
        if (it === iters - 1) for (let i = 1; i < N; i++) {
          const ci = g * nCh + ((i / CH) | 0), nc = candN[ci], base = ci * C;
          const o = (g * N + i) * 3;
          for (let k = 0; k < nc; k++) collideFlat(cf, cand[base + k] * 9, pos, prev, o, rad);
        }
        // follow-the-leader inextensibility with velocity correction
        for (let i = 1; i < N; i++) {
          const o = (g * N + i) * 3, p = o - 3;
          const L = RL[g * N + i];
          const dx = pos[o] - pos[p], dy = pos[o + 1] - pos[p + 1], dz = pos[o + 2] - pos[p + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
          const s = L / d;
          const nx = pos[p] + dx * s, ny = pos[p + 1] + dy * s, nz = pos[p + 2] + dz * s;
          const cx = nx - pos[o], cy = ny - pos[o + 1], cz = nz - pos[o + 2];
          pos[o] = nx; pos[o + 1] = ny; pos[o + 2] = nz;
          // DFTL: feed the correction back to the parent's velocity to cancel ghost momentum
          if (i > 1) {
            prev[p] += cx * 0.45; prev[p + 1] += cy * 0.45; prev[p + 2] += cz * 0.45;
          }
        }
      }
      if (it === iters - 1) this.repel();
    }
    this.lastHead = head.slice();
  }

  /** Guide pairs [a, b, minDistance] for volume preservation (stored flat for speed). */
  set neighbors(list) {
    this._nbA = Int32Array.from(list.map((x) => x[0]));
    this._nbB = Int32Array.from(list.map((x) => x[1]));
    this._nbD = Float32Array.from(list.map((x) => x[2]));
    this._nb = list;
  }
  get neighbors() {
    return this._nb ?? [];
  }

  /** Cheap volume preservation: neighbouring guides keep a minimum spacing at the same index. */
  repel() {
    const { pos, N } = this;
    const A = this._nbA, B = this._nbB, Dm = this._nbD;
    if (!A) return;
    for (let k = 0; k < A.length; k++) {
      const a = A[k], b = B[k], minD = Dm[k], md2 = minD * minD;
      for (let i = 4; i < N; i += 2) {
        const oa = (a * N + i) * 3, ob = (b * N + i) * 3;
        const dx = pos[ob] - pos[oa], dy = pos[ob + 1] - pos[oa + 1], dz = pos[ob + 2] - pos[oa + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= md2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const f = ((minD - d) / d) * 0.15;
        pos[oa] -= dx * f; pos[oa + 1] -= dy * f; pos[oa + 2] -= dz * f;
        pos[ob] += dx * f; pos[ob + 1] += dy * f; pos[ob + 2] += dz * f;
      }
    }
  }
}

function collideFlat(cf, q, pos, prev, o, rad) {
  let cx, cy, cz;
  if (cf[q] === 0) (cx = cf[q + 1]), (cy = cf[q + 2]), (cz = cf[q + 3]);
  else {
    const ax = cf[q + 1], ay = cf[q + 2], az = cf[q + 3];
    const bx = cf[q + 4] - ax, by = cf[q + 5] - ay, bz = cf[q + 6] - az;
    const t = Math.max(0, Math.min(1, ((pos[o] - ax) * bx + (pos[o + 1] - ay) * by + (pos[o + 2] - az) * bz) / (bx * bx + by * by + bz * bz)));
    cx = ax + bx * t; cy = ay + by * t; cz = az + bz * t;
  }
  const dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
  const R = cf[q + 7] + rad;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= R * R) return;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = dx / d, ny = dy / d, nz = dz / d;
  pos[o] = cx + nx * R; pos[o + 1] = cy + ny * R; pos[o + 2] = cz + nz * R;
  const vx = pos[o] - prev[o], vy = pos[o + 1] - prev[o + 1], vz = pos[o + 2] - prev[o + 2];
  const vn = vx * nx + vy * ny + vz * nz;
  const f = cf[q + 8];
  prev[o] += (vx - vn * nx) * f; prev[o + 1] += (vy - vn * ny) * f; prev[o + 2] += (vz - vn * nz) * f;
}

function collide(c, pos, prev, o, rad) {
  let cx, cy, cz;
  if (c.type === 'sphere') {
    cx = c.c[0]; cy = c.c[1]; cz = c.c[2];
  } else {
    const ax = c.a[0], ay = c.a[1], az = c.a[2];
    const bx = c.b[0] - ax, by = c.b[1] - ay, bz = c.b[2] - az;
    const t = Math.max(0, Math.min(1, ((pos[o] - ax) * bx + (pos[o + 1] - ay) * by + (pos[o + 2] - az) * bz) / (bx * bx + by * by + bz * bz)));
    cx = ax + bx * t; cy = ay + by * t; cz = az + bz * t;
  }
  const dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
  const R = c.r + rad;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= R * R) return;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = dx / d, ny = dy / d, nz = dz / d;
  pos[o] = cx + nx * R; pos[o + 1] = cy + ny * R; pos[o + 2] = cz + nz * R;
  // friction: remove part of the tangential velocity
  const vx = pos[o] - prev[o], vy = pos[o + 1] - prev[o + 1], vz = pos[o + 2] - prev[o + 2];
  const vn = vx * nx + vy * ny + vz * nz;
  const f = c.friction ?? 0.3;
  prev[o] += (vx - vn * nx) * f; prev[o + 1] += (vy - vn * ny) * f; prev[o + 2] += (vz - vn * nz) * f;
}

// ---- small math helpers (column-major 4x4, quaternions xyzw) --------------------------------
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
export function xform(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
export function mulMat(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
export function invRigid(m) {
  // inverse of a rotation+translation (uniform scale assumed 1)
  const o = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]);
  o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]);
  o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
  return o;
}
function rotOf(m) {
  // rotation matrix -> quaternion
  const m11 = m[0], m12 = m[4], m13 = m[8], m21 = m[1], m22 = m[5], m23 = m[9], m31 = m[2], m32 = m[6], m33 = m[10];
  const tr = m11 + m22 + m33;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}
function arcQuat(a, b, out) {
  // shortest rotation taking unit vector a to unit vector b
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    const ax = Math.abs(a[0]) < 0.9 ? norm([0, -a[2], a[1]]) : norm([-a[2], 0, a[0]]);
    out[0] = ax[0]; out[1] = ax[1]; out[2] = ax[2]; out[3] = 0;
    return out;
  }
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
  const w = 1 + d;
  const l = Math.hypot(cx, cy, cz, w);
  out[0] = cx / l; out[1] = cy / l; out[2] = cz / l; out[3] = w / l;
  return out;
}
function qrot(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
