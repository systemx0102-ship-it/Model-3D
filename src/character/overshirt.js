// Runtime for the waist-tied flannel shirt: drives the cloth solver from the pelvis on the fixed
// 120 Hz clock (anchor and colliders interpolated per substep), interpolates the render state
// between the last two steps and rebuilds smooth render meshes (Catmull-Rom upsampled grid with
// real thickness, tubes for the hanging sleeve ends).
import * as THREE from 'three';
import { ClothSim } from '../physics/cloth.js';
import { FixedStep, lerpRigid } from '../core/fixedstep.js';

// collider names the cloth reacts to, and the extra radius covering the trousers / belt layer
const CLOTH_COLLIDERS = [
  [/^pelvis_/, 0.02],
  [/^(thigh|calf)_/, 0.016],
  [/^back_[34]_/, 0.006],
  [/^(forearm|upperarm)_/, 0.004],
];

export class Overshirt {
  constructor(character, meta, material) {
    this.meta = meta;
    this.bone = character.bone(meta.bone);
    const boneIndex = character.skeleton.bones.indexOf(this.bone);
    const inv = character.skeleton.boneInverses[boneIndex];
    const v = new THREE.Vector3();
    const restLocal = new Float32Array(meta.rest.length);
    for (let i = 0; i < meta.rest.length; i += 3) {
      v.fromArray(meta.rest, i).applyMatrix4(inv);
      restLocal[i] = v.x; restLocal[i + 1] = v.y; restLocal[i + 2] = v.z;
    }
    this.sim = new ClothSim({
      restLocal,
      grid: { W: meta.W, H: meta.H, dx: meta.dx, lengths: meta.lengths },
      chains: meta.tails,
      pins: meta.pins,
    });
    this.clock = new FixedStep(this.sim.p.dt);
    // obstacles on other bones (pouch): bone-local centres
    this.obstacles = (meta.obstacles ?? []).map((o) => {
      const b = character.bone(o.bone);
      const bi = character.skeleton.boneInverses[character.skeleton.bones.indexOf(b)];
      return { bone: b, local: new THREE.Vector3(...o.c).applyMatrix4(bi), r: o.r, name: `obstacle_${o.bone}` };
    });
    this.prevPos = new Float32Array(this.sim.pos.length);
    this.renderPos = new Float32Array(this.sim.pos.length);
    this.prevAnchor = null;
    this.prevColliders = null;
    this.enabled = true;
    this.group = new THREE.Group();
    this.group.name = 'Overshirt_Sim';
    this.panel = new ClothPanel(meta, material);
    this.tails = meta.tails.map((t) => new SleeveTail(t, material));
    this.group.add(this.panel.mesh, ...this.tails.map((t) => t.mesh));
  }

  setRate(hz) {
    this.sim.setDt(1 / hz);
    const acc = this.clock.acc;
    this.clock = new FixedStep(1 / hz);
    this.clock.acc = Math.min(acc, 1 / hz);
  }

  /** Bind-space collider filter: pelvis / legs / lower back / arms, inflated by the outer layers. */
  colliders(all) {
    const out = this.obstacles.map((o) => ({ type: 'sphere', c: o.local.clone().applyMatrix4(o.bone.matrixWorld).toArray(), r: o.r, name: o.name }));
    for (const c of all)
      for (const [re, extra] of CLOTH_COLLIDERS)
        if (re.test(c.name)) {
          out.push({ ...c, r: c.r + extra });
          break;
        }
    return out;
  }

  reset(anchor, settle = 1.2) {
    this.sim.reset(anchor);
    // settle the drape (static anchor) so the first frame is already hanging naturally
    for (let t = 0; t < settle; t += this.sim.p.dt) this.sim.step(anchor, this.lastColliders ?? []);
    this.prevPos.set(this.sim.pos);
    this.prevAnchor = anchor.slice();
  }

  update(frameDt, allColliders, groundY, wind) {
    const anchor = this.bone.matrixWorld.elements.slice();
    const cols = this.colliders(allColliders);
    this.lastColliders = cols;
    this.sim.groundY = groundY;
    this.sim.wind = wind;
    if (!this.prevAnchor) this.reset(anchor);
    const prevA = this.prevAnchor, prevC = this.prevColliders ?? cols;
    const m = new Array(16);
    let alpha = 1;
    if (this.enabled)
      alpha = this.clock.advance(frameDt, (t) => {
        this.prevPos.set(this.sim.pos);
        lerpRigid(prevA, anchor, t, m);
        this.sim.step(m, cols.map((c, i) => lerpCollider(prevC[i] ?? c, c, t)));
      });
    this.prevAnchor = anchor;
    this.prevColliders = cols.map((c) => ({ ...c, c: c.c?.slice(), a: c.a?.slice(), b: c.b?.slice() }));
    const { pos } = this.sim, prev = this.prevPos, out = this.renderPos;
    for (let i = 0; i < pos.length; i++) out[i] = prev[i] + (pos[i] - prev[i]) * alpha;
    this.panel.update(out);
    this.tails.forEach((t) => t.update(out));
  }
}

function lerpCollider(a, b, t) {
  const L = (x, y) => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  return b.type === 'sphere' ? { type: 'sphere', c: L(a.c, b.c), r: b.r } : { type: 'capsule', a: L(a.a, b.a), b: L(a.b, b.b), r: b.r };
}

// Catmull-Rom weights for sub-sample f in [0,1) between p1 and p2
function crWeights(f) {
  const f2 = f * f, f3 = f2 * f;
  return [-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1, -1.5 * f3 + 2 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2];
}

/** The hanging shirt body: upsampled grid, front and back surfaces offset by the fabric thickness. */
class ClothPanel {
  constructor(meta, material, up = 3) {
    const { W, H } = meta;
    this.W = W; this.H = H; this.up = up;
    const RW = (W - 1) * up + 1, RH = (H - 1) * up + 1;
    this.RW = RW; this.RH = RH;
    this.thick = 0.0016;
    const n = RW * RH;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3);
    this.nrm = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    for (let r = 0; r < RH; r++)
      for (let c = 0; c < RW; c++) {
        const i = r * RW + c;
        // interpolate the particle UVs (tile units)
        const gr = Math.min(H - 2, Math.floor(r / up)), gc = Math.min(W - 2, Math.floor(c / up));
        const fr = r / up - gr, fc = c / up - gc;
        const U = (rr, cc) => meta.uv[(rr * W + cc) * 2], V = (rr, cc) => meta.uv[(rr * W + cc) * 2 + 1];
        const u = (U(gr, gc) * (1 - fc) + U(gr, gc + 1) * fc) * (1 - fr) + (U(gr + 1, gc) * (1 - fc) + U(gr + 1, gc + 1) * fc) * fr;
        const vv = (V(gr, gc) * (1 - fc) + V(gr, gc + 1) * fc) * (1 - fr) + (V(gr + 1, gc) * (1 - fc) + V(gr + 1, gc + 1) * fc) * fr;
        uv[i * 2] = u; uv[i * 2 + 1] = vv;
        uv[(n + i) * 2] = u; uv[(n + i) * 2 + 1] = vv;
      }
    const idx = [];
    for (let r = 0; r + 1 < RH; r++)
      for (let c = 0; c + 1 < RW; c++) {
        const a = r * RW + c, b = a + 1, cc = a + RW, d = cc + 1;
        idx.push(a, cc, b, b, cc, d); // outer side
        idx.push(n + a, n + b, n + cc, n + b, n + d, n + cc); // inner side
      }
    // hems: close the side and bottom edges between the two surfaces
    const edge = (list) => {
      for (let k = 0; k + 1 < list.length; k++) {
        const a = list[k], b = list[k + 1];
        idx.push(a, b, n + a, b, n + b, n + a);
      }
    };
    edge(Array.from({ length: RH }, (_, r) => r * RW));
    edge(Array.from({ length: RH }, (_, r) => r * RW + RW - 1).reverse());
    edge(Array.from({ length: RW }, (_, c) => (RH - 1) * RW + c).reverse());
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'SIM_ShirtBody';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.n = n;
    this.tmp = new Float32Array(RW * H * 3);
    this.wts = Array.from({ length: up }, (_, k) => crWeights(k / up));
  }

  update(src) {
    const { W, H, up, RW, RH, n, tmp } = this;
    const P = (r, c, k) => src[(Math.max(0, Math.min(H - 1, r)) * W + Math.max(0, Math.min(W - 1, c))) * 3 + k];
    // rows: upsample along columns direction (c)
    for (let r = 0; r < H; r++)
      for (let c = 0; c < RW; c++) {
        const gc = Math.min(W - 1, Math.floor(c / up)), f = c - gc * up;
        const o = (r * RW + c) * 3;
        if (f === 0) for (let k = 0; k < 3; k++) tmp[o + k] = P(r, gc, k);
        else {
          const w = this.wts[f];
          for (let k = 0; k < 3; k++) tmp[o + k] = w[0] * P(r, gc - 1, k) + w[1] * P(r, gc, k) + w[2] * P(r, gc + 1, k) + w[3] * P(r, gc + 2, k);
        }
      }
    const T = (r, c, k) => tmp[(Math.max(0, Math.min(H - 1, r)) * RW + c) * 3 + k];
    const pos = this.pos;
    for (let r = 0; r < RH; r++) {
      const gr = Math.min(H - 1, Math.floor(r / up)), f = r - gr * up;
      for (let c = 0; c < RW; c++) {
        const o = (r * RW + c) * 3;
        if (f === 0) for (let k = 0; k < 3; k++) pos[o + k] = T(gr, c, k);
        else {
          const w = this.wts[f];
          for (let k = 0; k < 3; k++) pos[o + k] = w[0] * T(gr - 1, c, k) + w[1] * T(gr, c, k) + w[2] * T(gr + 1, c, k) + w[3] * T(gr + 2, c, k);
        }
      }
    }
    // normals of the outer surface (central differences on the grid)
    const nrm = this.nrm;
    for (let r = 0; r < RH; r++)
      for (let c = 0; c < RW; c++) {
        const o = (r * RW + c) * 3;
        const cl = (r * RW + Math.max(0, c - 1)) * 3, cr = (r * RW + Math.min(RW - 1, c + 1)) * 3;
        const ru = (Math.max(0, r - 1) * RW + c) * 3, rd = (Math.min(RH - 1, r + 1) * RW + c) * 3;
        const ax = pos[cr] - pos[cl], ay = pos[cr + 1] - pos[cl + 1], az = pos[cr + 2] - pos[cl + 2];
        const bx = pos[rd] - pos[ru], by = pos[rd + 1] - pos[ru + 1], bz = pos[rd + 2] - pos[ru + 2];
        let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
        // inner surface: offset by the thickness, opposite normal
        const oi = (n + r * RW + c) * 3;
        pos[oi] = pos[o] - nx * this.thick; pos[oi + 1] = pos[o + 1] - ny * this.thick; pos[oi + 2] = pos[o + 2] - nz * this.thick;
        nrm[oi] = -nx; nrm[oi + 1] = -ny; nrm[oi + 2] = -nz;
      }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}

/** A rolled sleeve end hanging from the knot: tube along the simulated chain, with a cuff. */
class SleeveTail {
  constructor(t, material, seg = 7, around = 12) {
    this.t = t;
    this.seg = seg;
    this.around = around;
    const S = (t.count - 1) * seg + 1;
    this.S = S;
    const n = S * (around + 1) + 1;
    this.pos = new Float32Array(n * 3);
    this.nrm = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < S; i++)
      for (let k = 0; k <= around; k++) {
        const o = i * (around + 1) + k;
        uv[o * 2] = (k / around) * 1.2;
        uv[o * 2 + 1] = (i / (S - 1)) * (t.seg * (t.count - 1)) / 0.12;
      }
    const idx = [];
    for (let i = 0; i + 1 < S; i++)
      for (let k = 0; k < around; k++) {
        const a = i * (around + 1) + k, b = a + 1, c = a + around + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    const cap = n - 1;
    for (let k = 0; k < around; k++) idx.push((S - 1) * (around + 1) + k, cap, (S - 1) * (around + 1) + k + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'SIM_SleeveEnd';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.wts = Array.from({ length: seg }, (_, k) => crWeights(k / seg));
  }

  update(src) {
    const { t, seg, around, S } = this;
    const P = (i, k) => src[(t.start + Math.max(0, Math.min(t.count - 1, i))) * 3 + k];
    const pts = [];
    for (let i = 0; i < S; i++) {
      const g = Math.min(t.count - 1, Math.floor(i / seg)), f = i - g * seg;
      const p = new THREE.Vector3();
      if (f === 0) p.set(P(g, 0), P(g, 1), P(g, 2));
      else {
        const w = this.wts[f];
        p.set(...[0, 1, 2].map((k) => w[0] * P(g - 1, k) + w[1] * P(g, k) + w[2] * P(g + 1, k) + w[3] * P(g + 2, k)));
      }
      pts.push(p);
    }
    // parallel-transport frames along the tube
    let normal = new THREE.Vector3(1, 0, 0);
    const tan = new THREE.Vector3(), bin = new THREE.Vector3();
    for (let i = 0; i < S; i++) {
      tan.copy(pts[Math.min(S - 1, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
      normal.addScaledVector(tan, -normal.dot(tan));
      if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1).addScaledVector(tan, -tan.z);
      normal.normalize();
      bin.crossVectors(tan, normal);
      const s = i / (S - 1);
      // rolled sleeve: flattened, a little fuller toward the cuff
      const rr = t.radius + (t.cuff - t.radius) * Math.max(0, (s - 0.75) / 0.25);
      for (let k = 0; k <= around; k++) {
        const a = (k / around) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a) * 0.6;
        const o = (i * (around + 1) + k) * 3;
        const dx = normal.x * ca + bin.x * sa, dy = normal.y * ca + bin.y * sa, dz = normal.z * ca + bin.z * sa;
        this.pos[o] = pts[i].x + dx * rr; this.pos[o + 1] = pts[i].y + dy * rr; this.pos[o + 2] = pts[i].z + dz * rr;
        const l = Math.hypot(dx, dy, dz) || 1;
        this.nrm[o] = dx / l; this.nrm[o + 1] = dy / l; this.nrm[o + 2] = dz / l;
      }
    }
    const capO = (S * (around + 1)) * 3;
    const end = pts[S - 1].clone().addScaledVector(tan, 0.004);
    this.pos[capO] = end.x; this.pos[capO + 1] = end.y; this.pos[capO + 2] = end.z;
    this.nrm[capO] = tan.x; this.nrm[capO + 1] = tan.y; this.nrm[capO + 2] = tan.z;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }
}
