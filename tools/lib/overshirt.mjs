// Flannel overshirt tied around the hips: the static part (bunched yoke at the back, sleeves
// wrapped round the front, knot) is a skinned mesh; the shirt body hanging behind and the two
// sleeve ends hanging from the knot are simulated cloth at runtime (src/physics/cloth.js).
// This module lays out the simulation particles in the bind pose (draped clear of the body),
// defines the fabric's true rest dimensions (wider than the hips: the top edge is gathered, so the
// cloth buckles into pleats by itself) and bakes the plaid flannel textures.
import * as THREE from 'three';
import sharp from 'sharp';
import path from 'node:path';

export const FLANNEL_TILE = 0.12; // m per plaid repeat (= one UV unit on every flannel mesh)

export function buildOvershirt({ outfit, rig, W = 30, H = 24, seed = 3 }) {
  const rnd = mulberry(seed);
  const belt = outfit.belt;
  const pants = outfit.pants;
  const cen = belt.center.clone();
  const yTie = belt.bottomY - 0.03; // sits low on the hips, below the belt and buckle
  const pantsMesh = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pants.positions, 3)).setIndex(new THREE.BufferAttribute(pants.indices, 1)),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  const ray = new THREE.Raycaster();
  // outer surface radius of the trousers around the vertical axis through the waist centre
  const radiusAt = (theta, y) => {
    const dir = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
    ray.set(new THREE.Vector3(cen.x, y, cen.z), dir);
    ray.far = 0.35;
    const hits = ray.intersectObject(pantsMesh, false);
    return hits.length ? hits.at(-1).distance : null;
  };
  const at = (theta, r, y) => new THREE.Vector3(cen.x + Math.sin(theta) * r, y, cen.z + Math.cos(theta) * r);
  const deg = Math.PI / 180;

  // ---- hanging body of the shirt: W x H particle grid ------------------------------------------
  const th0 = 80 * deg, th1 = 280 * deg; // left hip -> centre back -> right hip
  const width = 0.76; // fabric width across the grid (gathered into ~0.5 m of hip line)
  const dx = width / (W - 1);
  const lengths = [];
  const particles = [], uv = [];
  let tieR = [];
  for (let c = 0; c < W; c++) {
    const th = th0 + ((th1 - th0) * c) / (W - 1);
    // shirt-tail hem: longer at the back centre and the front panels, shorter at the side seams
    const L = 0.56 - 0.085 * Math.exp(-(((th - 128 * deg) / (16 * deg)) ** 2)) - 0.085 * Math.exp(-(((th - 232 * deg) / (16 * deg)) ** 2));
    lengths.push(L);
    tieR.push(radiusAt(th, yTie) ?? 0.17);
  }
  // smooth the hip-line radii
  for (let it = 0; it < 3; it++) tieR = tieR.map((r, c) => (tieR[Math.max(0, c - 1)] + 2 * r + tieR[Math.min(W - 1, c + 1)]) / 4);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const th = th0 + ((th1 - th0) * c) / (W - 1);
      const dy = lengths[c] / (H - 1);
      const y = yTie - r * dy;
      // curtain: never closer to the body than the widest point above (+ clearance)
      const prev = r ? particles[(r - 1) * W + c] : null;
      const surf = radiusAt(th, y);
      let rad = Math.max(tieR[c] + 0.006, surf !== null ? surf + 0.03 : 0);
      if (prev) rad = Math.max(rad, Math.hypot(prev.x - cen.x, prev.z - cen.z));
      // gathered pleats at the top, decaying downward
      rad += (c % 2 ? 0.014 : 0) * Math.exp(-r / 2.5) + 0.003 * (rnd() - 0.5);
      particles.push(at(th, rad, y));
      uv.push((c * dx) / FLANNEL_TILE, (r * dy) / FLANNEL_TILE);
    }
  const pins = Array.from({ length: W }, (_, c) => c);

  // ---- knot and sleeve ends ---------------------------------------------------------------------
  const thK = 24 * deg;
  const rK = (radiusAt(thK, yTie) ?? 0.15) + 0.026;
  const knot = at(thK, rK, yTie - 0.008);
  const tails = [];
  const TP = 10, seg = 0.024;
  for (const [k, off] of [[0, -0.014], [1, 0.016]]) {
    const start = particles.length;
    const side = new THREE.Vector3(Math.cos(thK), 0, -Math.sin(thK));
    const out = new THREE.Vector3(Math.sin(thK), 0, Math.cos(thK));
    for (let i = 0; i < TP; i++) {
      const p = knot.clone().addScaledVector(side, off * (1 + i * 0.08)).addScaledVector(out, 0.006 + 0.002 * i).add(new THREE.Vector3(0, -0.012 - i * seg, 0));
      particles.push(p);
      uv.push(0, (i * seg) / FLANNEL_TILE);
    }
    tails.push({ start, count: TP, seg, radius: k ? 0.021 : 0.019, cuff: 0.024 });
    pins.push(start);
  }

  // ---- static tie: bunched yoke round the back, sleeves round the front, knot ---------------------
  const tie = tieMesh({ radiusAt, at, yTie, thStart: thK, rnd, knot });

  return {
    W, H, dx, lengths, yTie,
    rest: particles,
    uv,
    pins,
    tails,
    knot,
    tie,
  };
}

function tieMesh({ radiusAt, at, yTie, thStart, rnd, knot }) {
  const deg = Math.PI / 180;
  const N = 140, S = 14;
  const pos = [], uv = [], idx = [];
  const ringPts = [];
  let arc = 0, last = null;
  for (let i = 0; i <= N; i++) {
    const th = thStart + 6 * deg + ((360 - 12) * deg * i) / N;
    const thW = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const back = Math.exp(-(((thW - Math.PI) / (75 * deg)) ** 2)); // yoke at the back is bulkier
    const rr = (radiusAt(thW, yTie) ?? 0.16) + 0.004;
    const half = [0.009 + 0.006 * back, 0.02 + 0.012 * back]; // radial, vertical half-sizes
    // twisted fabric: slow wobble of the cross-section and sag between
    const wob = Math.sin(th * 7 + 1.3) * 0.15 + Math.sin(th * 13) * 0.08;
    const sag = 0.004 * Math.sin(th * 3);
    const c = at(thW, rr + half[0], yTie + sag);
    if (last) arc += c.distanceTo(last);
    last = c;
    const out = new THREE.Vector3(Math.sin(thW), 0, Math.cos(thW));
    const up = new THREE.Vector3(0, 1, 0);
    const ring = [];
    for (let k = 0; k <= S; k++) {
      const a = (k / S) * Math.PI * 2;
      const bump = 1 + 0.12 * Math.sin(a * 3 + th * 5 + wob * 4) + 0.06 * (rnd() - 0.5);
      const ca = Math.cos(a + wob), sa = Math.sin(a + wob);
      // flattened against the body (no part of the section dips inside the trousers)
      const radial = Math.max(-half[0] * 0.9, ca * half[0] * bump);
      const p = c.clone().addScaledVector(out, radial).addScaledVector(up, sa * half[1] * bump);
      ring.push(p);
      pos.push(p.x, p.y, p.z);
      uv.push(arc / 0.12, (k / S) * (2 * (half[0] + half[1]) * 2) / 0.12);
    }
    ringPts.push(ring);
  }
  for (let i = 0; i < N; i++)
    for (let k = 0; k < S; k++) {
      const a = i * (S + 1) + k, b = a + 1, c = a + S + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  // knot: lumpy ellipsoid over the sleeve ends
  const base = pos.length / 3;
  const KR = 18, KS = 24;
  for (let i = 0; i <= KR; i++) {
    const v = i / KR, phi = v * Math.PI;
    for (let k = 0; k <= KS; k++) {
      const u = k / KS, th = u * Math.PI * 2;
      const n = new THREE.Vector3(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      const lump = 1 + 0.16 * Math.sin(th * 3 + phi * 2) * Math.sin(phi) + 0.08 * Math.sin(th * 7 - phi * 3);
      const p = knot.clone().add(new THREE.Vector3(n.x * 0.036, n.y * 0.027, n.z * 0.03).multiplyScalar(lump));
      pos.push(p.x, p.y, p.z);
      uv.push(u * 1.6, v * 0.9);
    }
  }
  for (let i = 0; i < KR; i++)
    for (let k = 0; k < KS; k++) {
      const a = base + i * (KS + 1) + k, b = a + 1, c = a + KS + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  // orient every triangle outward (away from the waist axis / knot centre)
  const P = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  for (let t = 0; t < idx.length; t += 3) {
    const a = P(idx[t]), b = P(idx[t + 1]), c = P(idx[t + 2]);
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    let ref;
    if (idx[t] >= base) ref = knot;
    else {
      const i = Math.floor(idx[t] / (S + 1));
      const ring = ringPts[Math.min(i, ringPts.length - 1)];
      ref = ring.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    }
    if (n.dot(centroid.sub(ref)) < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
  return { positions: Float32Array.from(pos), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

/** Plaid flannel: burgundy / charcoal tartan with fine cream lines, 2/2 twill, brushed fuzz. */
export async function bakeFlannel(dir, N = 1024, formats = ['webp']) {
  // stripe sequence across one repeat (mm, colour index), mirrored like a real sett
  const C = [[0.32, 0.045, 0.05], [0.055, 0.05, 0.05], [0.72, 0.62, 0.48], [0.16, 0.035, 0.04]];
  const raw = [[0, 26], [1, 18], [3, 4], [2, 1.2], [3, 4], [1, 6], [0, 6]];
  const rawHalf = raw.reduce((s, [, w]) => s + w, 0);
  const half = (FLANNEL_TILE * 1000) / 2; // one mirrored sett per tile: seamless repeat
  const sett = raw.map(([c, w]) => [c, (w * half) / rawHalf]);
  const total = half * 2;
  const stripeAt = (mm) => {
    let x = ((mm % total) + total) % total;
    if (x > half) x = total - x;
    for (const [c, w] of sett) {
      if (x < w) return c;
      x -= w;
    }
    return sett.at(-1)[0];
  };
  const toLin = (c) => c;
  const col = Buffer.alloc(N * N * 3), nrm = Buffer.alloc(N * N * 3);
  const H = new Float32Array(N * N);
  const mmPerPx = (FLANNEL_TILE * 1000) / N;
  const hash = (x, y) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const per = 256; // twill threads per tile (multiple of 4: the 2/2 twill repeats seamlessly)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const warp = C[stripeAt(x * mmPerPx)], weft = C[stripeAt(y * mmPerPx)];
      // 2/2 twill: which yarn is on top at this thread crossing
      const tx = Math.floor(u * per), ty = Math.floor(v * per);
      const top = ((tx + ty) % 4) < 2;
      const fx = u * per - tx, fy = v * per - ty;
      const w = top ? 0.78 : 0.22;
      const fuzz = 0.9 + 0.2 * hash(x, y);
      const i = (y * N + x) * 3;
      for (let k = 0; k < 3; k++) {
        const lin = (warp[k] * w + weft[k] * (1 - w)) * fuzz;
        col[i + k] = Math.round(Math.max(0, Math.min(1, toSrgb(toLin(lin)))) * 255);
      }
      H[y * N + x] = top ? Math.sin(Math.PI * fy) ** 0.6 : Math.sin(Math.PI * fx) ** 0.6;
      H[y * N + x] += 0.25 * (hash(x * 7, y * 3) - 0.5);
    }
  const relief = 0.00012, texel = FLANNEL_TILE / N;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const hx = (H[y * N + ((x + 1) % N)] - H[y * N + ((x - 1 + N) % N)]) * relief / (2 * texel);
      const hy = (H[((y + 1) % N) * N + x] - H[((y - 1 + N) % N) * N + x]) * relief / (2 * texel);
      const l = Math.hypot(hx, hy, 1);
      const i = (y * N + x) * 3;
      nrm[i] = Math.round((-hx / l * 0.5 + 0.5) * 255);
      nrm[i + 1] = Math.round((hy / l * 0.5 + 0.5) * 255);
      nrm[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
    }
  const files = {};
  for (const [key, buf, q] of [['BaseColor', col, 92], ['Normal', nrm, 95]])
    for (const f of formats) {
      const file = path.join(dir, `T_Flannel_${key}.${f}`);
      const img = sharp(buf, { raw: { width: N, height: N, channels: 3 } });
      await (f === 'png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality: q, effort: 4 })).toFile(file);
      (files[key] ??= {})[f] = path.basename(file);
    }
  return files;
}

const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
