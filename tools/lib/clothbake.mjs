// Garment texture bake (UV space, evaluated in 3D bind space): construction details that a real
// garment has and a smooth simulated shell does not - seams with their allowances, top-stitching,
// hems and bindings, patch / cargo pockets with flaps and buttons, waistband, fly, back yoke,
// compression and drape folds - plus wear and tint variation. For the boots: lacing with eyelets,
// speed hooks and crossed laces, tongue, padded collar, toe cap, heel counter, vamp / quarter
// seams, welt stitching, flex creases and scuffs.
// Outputs per garment: BaseColor (sRGB), ORM (AO, roughness, metalness), tangent-space Normal.
// The fine weave / grain lives in the tileable fabric detail maps (fabric.mjs).
import sharp from 'sharp';
import path from 'node:path';
import * as THREE from 'three';
import { rasterize, dilate } from './raster.mjs';
import { fbm, smoothstep, clamp01, mix } from './noise.mjs';

const MM = 0.001;
const srgb = (r, g, b) => [r, g, b].map((c) => ((c / 255 + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const u8 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
const noise = (x, y, z, f, o, seed) => 0.5 + 0.5 * fbm(x, y, z, f, o, seed, null); // [0, 1]
const frac = (x) => x - Math.floor(x);

// ---- profile helpers (all lengths in metres) -------------------------------------------------
const bell = (d, w) => Math.exp(-((d / w) ** 2));
/** A seam: sunken join with the folded allowances raised either side. */
const seamH = (d) => -0.35 * MM * bell(d, 0.45 * MM) + 0.22 * MM * bell(Math.abs(d) - 2.6 * MM, 1.6 * MM);
/** Top-stitching: dashed thread on the surface, needle holes between the dashes. */
function stitch(dPerp, along, period = 3 * MM, width = 0.32 * MM) {
  const ph = frac(along / period);
  const dash = smoothstep(0.08, 0.2, ph) * (1 - smoothstep(0.8, 0.92, ph));
  const across = bell(dPerp, width);
  return { h: across * (0.22 * MM * dash - 0.12 * MM * (1 - dash)), thread: across * dash };
}
/** Signed distance to a rounded box centred at 0 with half size (hx, hy), corner radius r. */
function sdBox(x, y, hx, hy, r) {
  const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
/** Distance from p to the segment ab in 2D, plus the parameter along it. */
function seg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return { d: Math.hypot(px - ax - dx * t, py - ay - dy * t), t, len: Math.hypot(dx, dy) };
}

// ---- generic baker ---------------------------------------------------------------------------
/**
 * @param gm      garment mesh {positions, normals, tangents, uvs, indices, layer}
 * @param attrs   Float32Array(vertexCount * K) extra per-vertex attributes (interpolated, with gradients)
 * @param shade   (q:[x,y,z], A:Float32Array(K), n:[x,y,z], out) => fills out.h (m), r, g, b (linear), ao, rough, metal
 */
export function bakeGarment(gm, N, attrs, K, shade) {
  const { positions: pos, normals: nor, tangents: tan, uvs, indices: idx, layer } = gm;
  const T = idx.length / 3;
  const uv = new Float32Array(T * 6);
  const keep = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    keep[t] = layer[idx[t * 3]] === 0 && layer[idx[t * 3 + 1]] === 0 && layer[idx[t * 3 + 2]] === 0 ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      uv[t * 6 + k * 2] = uvs[idx[t * 3 + k] * 2];
      uv[t * 6 + k * 2 + 1] = uvs[idx[t * 3 + k] * 2 + 1];
    }
  }
  const NN = N * N;
  const color = new Float32Array(NN * 3), orm = new Float32Array(NN * 3), nrm = new Float32Array(NN * 3);
  const mask = new Uint8Array(NN);
  const P = [0, 0, 0], Nv = [0, 0, 0], Tv = [0, 0, 0], Bv = [0, 0, 0], Q = [0, 0, 0];
  const A = new Float32Array(K), A2 = new Float32Array(K);
  const grad = new Float32Array(K * 3);
  let gradTri = -1;
  const out = {}, tmp = {};
  const eps = 0.12 * MM;
  const triGrad = (t) => {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const e1 = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]];
    const e2 = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]];
    const g11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], g22 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const g12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
    const det = g11 * g22 - g12 * g12 || 1e-18;
    for (let k = 0; k < K; k++) {
      const d1 = attrs[b * K + k] - attrs[a * K + k], d2 = attrs[c * K + k] - attrs[a * K + k];
      const al = (d1 * g22 - d2 * g12) / det, be = (d2 * g11 - d1 * g12) / det;
      for (let j = 0; j < 3; j++) grad[k * 3 + j] = al * e1[j] + be * e2[j];
    }
  };
  rasterize(N, uv, (pi, t, w0, w1, w2) => {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    if (t !== gradTri) (triGrad(t), (gradTri = t));
    for (let k = 0; k < 3; k++) {
      P[k] = pos[a * 3 + k] * w0 + pos[b * 3 + k] * w1 + pos[c * 3 + k] * w2;
      Nv[k] = nor[a * 3 + k] * w0 + nor[b * 3 + k] * w1 + nor[c * 3 + k] * w2;
      Tv[k] = tan[a * 4 + k] * w0 + tan[b * 4 + k] * w1 + tan[c * 4 + k] * w2;
    }
    for (let k = 0; k < K; k++) A[k] = attrs[a * K + k] * w0 + attrs[b * K + k] * w1 + attrs[c * K + k] * w2;
    let l = Math.hypot(Nv[0], Nv[1], Nv[2]) || 1;
    Nv[0] /= l; Nv[1] /= l; Nv[2] /= l;
    const td = Tv[0] * Nv[0] + Tv[1] * Nv[1] + Tv[2] * Nv[2];
    Tv[0] -= Nv[0] * td; Tv[1] -= Nv[1] * td; Tv[2] -= Nv[2] * td;
    l = Math.hypot(Tv[0], Tv[1], Tv[2]) || 1;
    Tv[0] /= l; Tv[1] /= l; Tv[2] /= l;
    const sgn = tan[a * 4 + 3];
    Bv[0] = (Nv[1] * Tv[2] - Nv[2] * Tv[1]) * sgn;
    Bv[1] = (Nv[2] * Tv[0] - Nv[0] * Tv[2]) * sgn;
    Bv[2] = (Nv[0] * Tv[1] - Nv[1] * Tv[0]) * sgn;
    shade(P, A, Nv, out);
    // height gradient along T and B by forward differences (attributes follow their gradients)
    const hAt = (D) => {
      for (let k = 0; k < 3; k++) Q[k] = P[k] + D[k] * eps;
      for (let k = 0; k < K; k++) A2[k] = A[k] + (grad[k * 3] * D[0] + grad[k * 3 + 1] * D[1] + grad[k * 3 + 2] * D[2]) * eps;
      shade(Q, A2, Nv, tmp);
      return tmp.h;
    };
    const gT = (hAt(Tv) - out.h) / eps, gB = (hAt(Bv) - out.h) / eps;
    l = Math.hypot(gT, gB, 1);
    nrm[pi * 3] = -gT / l; nrm[pi * 3 + 1] = -gB / l; nrm[pi * 3 + 2] = 1 / l;
    color[pi * 3] = out.r; color[pi * 3 + 1] = out.g; color[pi * 3 + 2] = out.b;
    orm[pi * 3] = out.ao; orm[pi * 3 + 1] = out.rough; orm[pi * 3 + 2] = out.metal ?? 0;
    mask[pi] = 1;
  }, (t) => keep[t] === 1);
  dilate(N, [{ data: color, channels: 3 }, { data: orm, channels: 3 }, { data: nrm, channels: 3 }], mask, 24);
  return { N, color, orm, nrm };
}

export async function writeGarmentSet(set, dir, name, formats = ['webp']) {
  const { N } = set;
  const NN = N * N;
  const c8 = Buffer.alloc(NN * 3), o8 = Buffer.alloc(NN * 3), n8 = Buffer.alloc(NN * 3);
  for (let i = 0; i < NN; i++)
    for (let k = 0; k < 3; k++) {
      c8[i * 3 + k] = u8(toSrgb(set.color[i * 3 + k]));
      o8[i * 3 + k] = u8(set.orm[i * 3 + k]);
      n8[i * 3 + k] = u8(set.nrm[i * 3 + k] * 0.5 + 0.5);
    }
  const files = {};
  for (const [key, buf, q] of [['BaseColor', c8, 90], ['ORM', o8, 90], ['Normal', n8, 95]])
    for (const f of formats) {
      const file = path.join(dir, `T_${name}_${key}.${f}`);
      const img = sharp(buf, { raw: { width: N, height: N, channels: 3 } });
      await (f === 'png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality: q, effort: 4 })).toFile(file);
      (files[key] ??= {})[f] = path.basename(file);
    }
  return files;
}

// ---- shell attributes --------------------------------------------------------------------------
/**
 * Geodesic distance (along shell edges) from a set of boundary loops, and the arc-length position
 * of the closest boundary point, encoded as (cos, sin) of its angle around its loop plus the loop
 * length so the stitching can be dashed continuously. Returns per render vertex [d, cos, sin, L].
 */
export function boundaryField(gm, loopFilter = () => true) {
  const sh = gm.shell;
  const n = sh.srcIdx.length;
  const adj = Array.from({ length: n }, () => []);
  for (const p of sh.polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const d = Math.hypot(sh.pos[a * 3] - sh.pos[b * 3], sh.pos[a * 3 + 1] - sh.pos[b * 3 + 1], sh.pos[a * 3 + 2] - sh.pos[b * 3 + 2]);
      adj[a].push([b, d]);
      adj[b].push([a, d]);
    }
  const dist = new Float64Array(n).fill(Infinity), cs = new Float32Array(n * 3);
  const heap = [];
  const push = (v, d) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const pIdx = (i - 1) >> 1;
      if (heap[pIdx][0] <= heap[i][0]) break;
      [heap[pIdx], heap[i]] = [heap[i], heap[pIdx]];
      i = pIdx;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  sh.loops.forEach((L, li) => {
    if (!loopFilter(L, li)) return;
    const P = (v) => [sh.pos[v * 3], sh.pos[v * 3 + 1], sh.pos[v * 3 + 2]];
    const arc = [0];
    for (let k = 1; k <= L.length; k++) {
      const a = P(L[k - 1]), b = P(L[k % L.length]);
      arc.push(arc[k - 1] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    const len = arc.at(-1);
    L.forEach((v, k) => {
      dist[v] = 0;
      const th = (2 * Math.PI * arc[k]) / len;
      cs[v * 3] = Math.cos(th); cs[v * 3 + 1] = Math.sin(th); cs[v * 3 + 2] = len;
      push(v, 0);
    });
  });
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    for (const [w, e] of adj[v])
      if (d + e < dist[w]) {
        dist[w] = d + e;
        cs[w * 3] = cs[v * 3]; cs[w * 3 + 1] = cs[v * 3 + 1]; cs[w * 3 + 2] = cs[v * 3 + 2];
        push(w, d + e);
      }
  }
  const nv = gm.positions.length / 3;
  const out = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    const s = gm.shellVertex[i];
    out[i * 4] = Math.min(dist[s], 1);
    out[i * 4 + 1] = cs[s * 3]; out[i * 4 + 2] = cs[s * 3 + 1]; out[i * 4 + 3] = cs[s * 3 + 2];
  }
  return out;
}
const alongLoop = (A, o) => ((Math.atan2(A[o + 2], A[o + 1]) + Math.PI) / (2 * Math.PI)) * A[o + 3];

/** Per height bin and side: lateral / medial extremes and centre of the garment's outer shell. */
function sliceTable(gm, bin = 0.005) {
  const nv = gm.positions.length / 3;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < nv; i++) if (gm.layer[i] === 0) (y0 = Math.min(y0, gm.positions[i * 3 + 1])), (y1 = Math.max(y1, gm.positions[i * 3 + 1]));
  const B = Math.ceil((y1 - y0) / bin) + 1;
  const mk = () => ({ xo: new Float32Array(B).fill(NaN), zo: new Float32Array(B), xi: new Float32Array(B).fill(NaN), zi: new Float32Array(B), xmin: new Float32Array(B).fill(Infinity), xmax: new Float32Array(B).fill(-Infinity), zmin: new Float32Array(B).fill(Infinity), zmax: new Float32Array(B).fill(-Infinity) });
  const T = { l: mk(), r: mk() };
  for (let i = 0; i < nv; i++) {
    if (gm.layer[i] !== 0) continue;
    const x = gm.positions[i * 3], y = gm.positions[i * 3 + 1], z = gm.positions[i * 3 + 2];
    const b = Math.round((y - y0) / bin);
    const s = x >= 0 ? 'l' : 'r', sx = x >= 0 ? x : -x;
    const t = T[s];
    if (!(sx <= t.xo[b])) {
      if (Number.isNaN(t.xo[b]) || sx > t.xo[b]) (t.xo[b] = sx), (t.zo[b] = z);
    }
    if (Number.isNaN(t.xi[b]) || sx < t.xi[b]) (t.xi[b] = sx), (t.zi[b] = z);
    t.xmin[b] = Math.min(t.xmin[b], sx); t.xmax[b] = Math.max(t.xmax[b], sx);
    t.zmin[b] = Math.min(t.zmin[b], z); t.zmax[b] = Math.max(t.zmax[b], z);
  }
  // fill gaps and smooth
  for (const t of Object.values(T))
    for (const key of ['xo', 'zo', 'xi', 'zi', 'xmin', 'xmax', 'zmin', 'zmax']) {
      const a = t[key];
      for (let b = 0; b < B; b++) if (!Number.isFinite(a[b])) a[b] = b ? a[b - 1] : NaN;
      for (let b = B - 1; b >= 0; b--) if (!Number.isFinite(a[b])) a[b] = a[b + 1];
      for (let it = 0; it < 6; it++) {
        const c = a.slice();
        for (let b = 1; b < B - 1; b++) a[b] = (c[b - 1] + 2 * c[b] + c[b + 1]) / 4;
      }
    }
  const at = (side, key, y) => {
    const f = Math.max(0, Math.min(B - 1.001, (y - y0) / bin));
    const b = Math.floor(f), w = f - b;
    const a = T[side][key];
    return a[b] * (1 - w) + a[b + 1] * w;
  };
  return { at, y0, y1 };
}

// ---- tank top (1x1 rib knit) ---------------------------------------------------------------------
export function tankShader(gm) {
  const S = sliceTable(gm);
  const base = srgb(84, 92, 74);
  return (q, A, n, o) => {
    const [x, y, z] = q;
    const side = x >= 0 ? 'l' : 'r', sx = Math.abs(x);
    let h = 0, ao = 1, thread = 0, tint = 0;
    // neckline / armhole binding: folded band, join seam and a cover-stitch
    const d = A[0], along = alongLoop(A, 0);
    const band = smoothstep(9.5 * MM, 7.5 * MM, d);
    h += 0.45 * MM * band * (0.6 + 0.4 * smoothstep(0, 3 * MM, d)) + seamH(d - 8.6 * MM) * 0.7;
    const st = stitch(d - 6.2 * MM, along, 2.4 * MM, 0.28 * MM);
    h += st.h * band;
    thread += st.thread * band;
    tint -= 0.04 * band;
    ao -= 0.25 * bell(d - 8.6 * MM, 0.7 * MM);
    // side seams (overlocked, pressed to the back)
    const ds = Math.hypot(z - S.at(side, 'zo', y), Math.max(0, S.at(side, 'xo', y) - sx));
    h += seamH(ds) * 0.8;
    ao -= 0.2 * bell(ds, 0.6 * MM);
    tint -= 0.03 * bell(ds, 3 * MM);
    // gentle body-hugging drape and tension wrinkles under the arms
    const drape = noise(x, y, z, 9, 3, 701) - 0.5;
    h += 0.35 * MM * drape;
    const pit = bell(y - (S.y1 - 0.12), 0.05) * smoothstep(0.08, 0.13, sx);
    h += 0.4 * MM * pit * Math.sin((y * 0.7 + z) * 2 * Math.PI / 0.022);
    const mott = noise(x, y, z, 30, 3, 711) - 0.5;
    const k = 1 + tint + 0.06 * mott + 0.04 * drape;
    const th = srgb(78, 86, 68);
    o.h = h;
    o.r = mix(base[0] * k, th[0], thread * 0.6); o.g = mix(base[1] * k, th[1], thread * 0.6); o.b = mix(base[2] * k, th[2], thread * 0.6);
    o.ao = clamp01(ao + 0.05 * drape);
    o.rough = 0.9 - 0.04 * thread;
    o.metal = 0;
  };
}

// ---- cargo trousers (cotton twill) -------------------------------------------------------------
export function pantsShader(gm, rig) {
  const S = sliceTable(gm);
  const Bn = (nm) => rig.byName.get(nm).head;
  const hipY = Bn('thigh_l').y, kneeY = Bn('calf_l').y, ankleY = Bn('foot_l').y;
  const waistTop = S.y1;
  // crotch: lowest outer vertex near the centre plane
  let crotchY = Infinity;
  for (let i = 0; i < gm.positions.length / 3; i++)
    if (gm.layer[i] === 0 && Math.abs(gm.positions[i * 3]) < 0.012) crotchY = Math.min(crotchY, gm.positions[i * 3 + 1]);
  const base = srgb(116, 102, 76), threadC = srgb(146, 120, 78), dust = srgb(140, 132, 114);
  // leg frame: centre of each leg section (below the crotch; frozen above it)
  const legC = (side, y) => {
    const yy = Math.min(y, crotchY - 0.01);
    return [(S.at(side, 'xmin', yy) + S.at(side, 'xmax', yy)) / 2, (S.at(side, 'zmin', yy) + S.at(side, 'zmax', yy)) / 2, (S.at(side, 'xmax', yy) - S.at(side, 'xmin', yy)) / 2];
  };
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  return (q, A, n, o) => {
    const [x, y, z] = q;
    const side = x >= 0 ? 'l' : 'r', sx = Math.abs(x);
    let h = 0, ao = 1, thread = 0, wear = 0, tint = 0, dirt = 0;
    const addStitch = (dp, along, w = 1) => {
      const s = stitch(dp, along, 3.2 * MM, 0.34 * MM);
      h += s.h * w;
      thread += s.thread * w;
    };
    const [cx, cz, r] = legC(side, y);
    const phi = Math.atan2(z - cz, sx - cx); // 0 lateral, +pi/2 front, -pi/2 back, pi medial
    const arcR = Math.max(0.04, r);
    const front = n[2] > 0.15, back = n[2] < -0.15;

    // waistband: 4 cm band, double top-stitched, seam at its bottom
    const dT = A[0], along = alongLoop(A, 0);
    if (dT < 0.06) {
      const wb = smoothstep(41 * MM, 39 * MM, dT);
      h += 0.5 * MM * wb + seamH(dT - 40 * MM);
      addStitch(dT - 3 * MM, along, wb);
      addStitch(dT - 37 * MM, along, wb);
      ao -= 0.25 * bell(dT - 40 * MM, 0.8 * MM);
      // belt cinch pleats just below the band
      const pl = smoothstep(0.04, 0.05, dT) * (1 - smoothstep(0.06, 0.1, dT));
      h += 0.8 * MM * pl * Math.sin((along / 0.03) * 2 * Math.PI + 0.7 * Math.sin(along * 40));
    }
    // outseam and inseam (felled, double stitched), centre rise seams
    const dOut = Math.abs(wrapPi(phi)) * arcR;
    h += seamH(dOut);
    addStitch(dOut - 6 * MM, y, 1);
    ao -= 0.2 * bell(dOut, 0.6 * MM);
    if (y < crotchY + 0.01) {
      const dIn = Math.abs(wrapPi(phi - Math.PI)) * arcR;
      h += seamH(dIn);
      addStitch(dIn - 5 * MM, y);
      ao -= 0.2 * bell(dIn, 0.6 * MM);
    }
    if (y > crotchY - 0.005) {
      h += seamH(sx);
      addStitch(sx - 5 * MM, y, back ? 1 : 0.5);
      ao -= 0.25 * bell(sx, 0.7 * MM);
    }
    // fly (wearer's left), J-stitched, with a bar tack
    if (front && y > crotchY && y < waistTop - 0.03) {
      const flyX = 0.034;
      const yb = crotchY + 0.055;
      let dF, aF;
      if (y > yb) (dF = Math.abs(x - flyX)), (aF = y);
      else {
        const rr = Math.hypot(x - (flyX - 0.034), y - yb);
        dF = Math.abs(rr - 0.034) + (x < 0 ? 1 : 0);
        aF = Math.atan2(y - yb, x) * 0.034;
      }
      addStitch(dF, aF);
      h += 0.3 * MM * smoothstep(flyX + 1 * MM, flyX - 1 * MM, x) * (x > 0 ? 1 : 0) * smoothstep(yb - 0.04, yb, y);
      ao -= 0.15 * bell(x, 0.5 * MM) * (x > -0.001 ? 1 : 0);
    }
    // front slant pockets: opening edge, facing, top-stitch
    if (front && y > waistTop - 0.2) {
      const sgnX = sx;
      const e = seg2(sgnX, y, 0.085, waistTop - 0.04, S.at(side, 'xo', waistTop - 0.17) - 0.004, waistTop - 0.17);
      const sideOfLine = (0.085 - sgnX) * (waistTop - 0.17 - (waistTop - 0.04)) - (waistTop - 0.04 - y) * (S.at(side, 'xo', waistTop - 0.17) - 0.004 - 0.085);
      if (y < waistTop - 0.035) {
        h += -0.45 * MM * bell(e.d, 0.6 * MM) + 0.35 * MM * (sideOfLine > 0 ? 1 : 0) * smoothstep(5 * MM, 0, e.d);
        addStitch(e.d - 6.5 * MM, e.t * e.len);
        ao -= 0.35 * bell(e.d, 0.8 * MM);
        wear += 0.25 * bell(e.d, 2 * MM);
      }
    }
    // back yoke and patch pockets
    if (back) {
      const yoke = waistTop - 0.115 + 0.05 * Math.min(1, sx / 0.17);
      if (y > yoke - 0.01 && dT > 0.04) {
        h += seamH(y - yoke);
        addStitch(y - yoke + 6 * MM, sx);
        addStitch(y - yoke + 11 * MM, sx);
      }
      const pc = [0.095, yoke - 0.11], hw = 0.068, hh = 0.075;
      const px = sx - pc[0], py = y - pc[1];
      // pentagon-ish: box with the bottom corners chamfered toward a point
      const sd = Math.max(sdBox(px, py, hw, hh, 0.006), (Math.abs(px) * 0.55 - (py + hh + 0.022)) * 0.85);
      if (sd < 0.004) {
        h += 0.6 * MM * smoothstep(0.6 * MM, -0.6 * MM, sd);
        addStitch(sd + 2.5 * MM, px + py);
        addStitch(sd + 7.5 * MM, px + py);
        ao -= 0.3 * bell(sd - 0.4 * MM, 0.7 * MM);
        wear += 0.3 * bell(sd, 1.5 * MM);
        // opening hem at the top
        if (py > hh - 0.02) addStitch(py - (hh - 0.012), px);
      }
    }
    // cargo pockets on the outer thighs: bellows patch, flap, button
    {
      const top = hipY - 0.115, bottom = top - 0.2;
      const sArc = wrapPi(phi - 0.12) * arcR, ty = y - (top + bottom) / 2;
      const hw = 0.078, hh = (top - bottom) / 2;
      const sd = sdBox(sArc, ty, hw, hh, 0.01);
      if (sd < 0.01) {
        h += 0.9 * MM * smoothstep(0.8 * MM, -0.8 * MM, sd);
        addStitch(sd + 2.5 * MM, sArc + ty);
        addStitch(sd + 6.5 * MM, sArc + ty);
        ao -= 0.35 * bell(sd - 0.5 * MM, 0.9 * MM);
        // bellows pleats along the sides
        h -= 0.5 * MM * bell(Math.abs(sArc) - (hw - 0.012), 1.2 * MM) * (sd < 0 ? 1 : 0);
        wear += 0.35 * bell(sd, 1.5 * MM);
      }
      // flap
      const fy = y - (top - 0.03);
      const sf = sdBox(sArc, fy, hw + 0.006, 0.033, 0.012);
      if (sf < 0.012) {
        h += 0.8 * MM * smoothstep(0.8 * MM, -0.8 * MM, sf);
        addStitch(sf + 2.5 * MM, sArc + fy);
        // shadow beneath the flap's lower edge
        ao -= 0.45 * smoothstep(0.006, 0, sf) * (fy < -0.02 ? 1 : 0) * (sf > 0 ? 1 : 0);
        wear += 0.3 * bell(sf, 1.4 * MM);
        // button
        const rb = Math.hypot(sArc, fy + 0.02);
        if (rb < 0.009) {
          h += 1.6 * MM * Math.sqrt(Math.max(0, 1 - (rb / 0.007) ** 2)) - 0.3 * MM * bell(rb - 0.0025, 0.4 * MM);
          tint -= 0.35 * smoothstep(0.0075, 0.0065, rb);
          ao -= 0.3 * bell(rb - 0.0075, 0.8 * MM);
        }
      }
    }
    // folds: knee bags and back-of-knee compression, crotch whiskers, bunching above the boots
    const kd = y - (kneeY + 0.01);
    const kneeBack = bell(kd, 0.07) * smoothstep(-0.2, -1.2, Math.sin(phi));
    const kneeFront = bell(kd - 0.02, 0.08) * smoothstep(0.2, 1, Math.sin(phi));
    const wav = noise(x, y, z, 14, 2, 801) - 0.5;
    h += 1.4 * MM * kneeBack * Math.sin((y + 0.012 * Math.sin(phi * 3) + 0.01 * wav) * 2 * Math.PI / 0.024);
    h += 1.2 * MM * kneeFront * (noise(x, y, z, 22, 2, 811) - 0.5);
    wear += 0.45 * kneeFront;
    if (front && y < crotchY + 0.04 && y > crotchY - 0.2) {
      const dx = sx - 0.02, dy = y - crotchY;
      const ang = Math.atan2(dy + 0.03, dx);
      const rho = Math.hypot(dx, dy + 0.03);
      const env = smoothstep(0.03, 0.06, rho) * (1 - smoothstep(0.1, 0.17, rho));
      let wh = 0;
      for (const [a0, s] of [[0.15, 1], [0.38, 0.8], [-0.1, 0.6], [0.6, 0.5]]) wh += s * bell(ang - a0 - 0.05 * wav, 0.05);
      h -= 1.0 * MM * env * wh;
      wear += 0.25 * env * wh;
    }
    // stacking where the gathered legs are tucked into the boots: a few irregular, slanted folds
    const bunch = smoothstep(ankleY + 0.12, ankleY + 0.15, y) * (1 - smoothstep(ankleY + 0.19, ankleY + 0.29, y));
    if (bunch > 0) {
      const warp = noise(x * 0.5, y * 0.2, z * 0.5, 9, 2, 841) - 0.5;
      const ph = (y + 0.018 * Math.sin(phi * 1.5 + 1.3) + 0.03 * warp) / 0.036;
      const brk = smoothstep(0.3, 0.7, noise(x, 0, z, 16, 2, 851) * 0.7 + 0.3 * Math.cos(phi * 2));
      const f = Math.sin(ph * 2 * Math.PI);
      const amp = bunch * (0.35 + 0.65 * brk);
      h += 1.3 * MM * amp * (f > 0 ? Math.sqrt(f) : -f * f);
      ao -= 0.18 * amp * Math.max(0, -f);
      dirt += 0.5 * bunch * smoothstep(ankleY + 0.26, ankleY + 0.13, y);
    }
    // seat stress folds
    if (back && y < crotchY + 0.06 && y > crotchY - 0.06) h -= 0.7 * MM * bell(y - crotchY - 0.01 + 0.15 * (sx - 0.06), 0.006) * smoothstep(0.02, 0.06, sx);
    // drape and fibre-level tint
    const drape = noise(x, y, z, 6, 3, 821) - 0.5;
    h += 0.5 * MM * drape;
    wear = clamp01(wear + 0.25 * Math.max(0, h / MM - 0.6) * 0.3);
    const mott = noise(x, y, z, 25, 3, 831) - 0.5;
    const k = 1 + tint + 0.07 * mott + 0.05 * drape;
    let r0 = base[0] * k, g0 = base[1] * k, b0 = base[2] * k;
    // wear: lighter, slightly desaturated; dust toward the boots
    r0 = mix(r0, r0 * 1.25 + 0.01, wear * 0.6); g0 = mix(g0, g0 * 1.22 + 0.01, wear * 0.6); b0 = mix(b0, b0 * 1.3 + 0.012, wear * 0.6);
    r0 = mix(r0, dust[0], dirt * 0.4); g0 = mix(g0, dust[1], dirt * 0.4); b0 = mix(b0, dust[2], dirt * 0.4);
    const tw = Math.min(1, thread * 0.85);
    o.h = h;
    o.r = mix(r0, threadC[0], tw); o.g = mix(g0, threadC[1], tw); o.b = mix(b0, threadC[2], tw);
    o.ao = clamp01(ao + 0.06 * drape);
    o.rough = 0.84 + 0.06 * wear - 0.08 * tw;
    o.metal = 0;
  };
}

// ---- leather boots -----------------------------------------------------------------------------
export function bootShader(gm) {
  const leather = srgb(54, 36, 26), dark = srgb(32, 21, 15), scuffC = srgb(92, 70, 54), suede = srgb(74, 56, 42);
  const threadC = srgb(168, 140, 98), lace = srgb(24, 20, 17), metalC = srgb(58, 58, 60);
  const M = gm.marks;
  const frontAt = (m, t) => {
    const f = m.front;
    let i = 0;
    while (i < f.length - 2 && f[i + 1].t < t) i++;
    const w = Math.max(0, Math.min(1, (t - f[i].t) / (f[i + 1].t - f[i].t || 1)));
    return { a: f[i].a + (f[i + 1].a - f[i].a) * w, c: f[i].c + (f[i + 1].c - f[i].c) * w };
  };
  const geo = {};
  for (const [side, m] of Object.entries(M)) {
    const tipA = new THREE.Vector3().subVectors(m.tip, m.ankle).dot(m.fwd);
    const laceEnd = m.tFoot + 0.05;
    const le = frontAt(m, laceEnd);
    // eyelet rows: speed hooks on the shaft, eyelets lower down
    const holes = [];
    for (let t = 0.028; t < laceEnd - 0.008; t += 0.021) holes.push(t);
    geo[side] = { m, tipA, laceEnd, le, holes };
  }
  return (q, A, n, o) => {
    const side = q[0] >= 0 ? 'l' : 'r';
    const G = geo[side], m = G.m;
    const s = A[0], t = A[1], as = Math.abs(s);
    const dx = q[0] - m.ankle.x, dz = q[2] - m.ankle.z;
    const a = dx * m.fwd.x + dz * m.fwd.z; // forward of the ankle
    const lat = (dx * m.fwd.z - dz * m.fwd.x) * (side === 'l' ? 1 : -1); // + = outer side
    const c = q[1] - m.floor; // height above the underside
    let h = 0, ao = 1, thread = 0, scuff = 0, darkMix = 0, rough = 0.52, metal = 0;
    let col = null; // override colour (laces, eyelets, tongue)
    const addStitch = (dp, along, w = 1, width = 0.36 * MM) => {
      const st = stitch(dp, along, 3.4 * MM, width);
      h += st.h * w * 1.2;
      thread += st.thread * w;
    };
    // padded collar
    const collar = smoothstep(0.03, 0.012, t);
    h += 1.2 * MM * collar * Math.sin(Math.min(1, t / 0.03) * Math.PI);
    addStitch(t - 0.031, s);
    rough += 0.25 * collar;
    // lacing: facings, tongue, eyelets / hooks, crossed laces
    if (t < G.laceEnd + 0.01) {
      const open = smoothstep(G.laceEnd + 0.004, G.laceEnd - 0.004, t);
      const facing = smoothstep(0.034, 0.03, as) * open;
      const gap = smoothstep(0.0105, 0.0085, as) * open;
      h += 0.7 * MM * facing - 1.2 * MM * gap;
      addStitch(as - 0.029, t, open);
      addStitch(as - 0.0315, t, open);
      ao -= 0.35 * gap + 0.25 * bell(as - 0.0095, 0.7 * MM) * open;
      if (gap > 0.01) {
        col = suede;
        rough = mix(rough, 0.85, gap);
        h += 0.4 * MM * gap * (noise(q[0], q[1], q[2], 120, 2, 901) - 0.5);
      }
      // laces between consecutive eyelet pairs, crossing over the tongue
      let laceH = 0;
      for (let i = 0; i + 1 < G.holes.length; i++) {
        const t0 = G.holes[i], t1 = G.holes[i + 1];
        if (t < t0 - 0.006 || t > t1 + 0.006) continue;
        for (const sg of [1, -1]) {
          const sgm = seg2(s, t, -0.016 * sg, t0, 0.016 * sg, t1);
          const w = 2.1 * MM;
          if (sgm.d < w) {
            const over = sg > 0 ? 1 : 0.85;
            const prof = Math.sqrt(1 - (sgm.d / w) ** 2);
            laceH = Math.max(laceH, (1.4 * MM + 0.5 * MM * over) * prof + 0.15 * MM * Math.sin((sgm.t * sgm.len) / 0.0012 * Math.PI * 2) * prof);
          }
        }
      }
      if (laceH > 0) {
        h = Math.max(h, laceH);
        col = lace;
        rough = 0.6;
        ao = Math.min(ao, 0.9);
      } else {
        ao -= 0.12 * open * smoothstep(0.02, 0.0, as);
      }
      // eyelets (lower) and speed hooks (upper three on the shaft)
      for (let i = 0; i < G.holes.length; i++) {
        const hook = i < 3;
        const rr = Math.hypot(as - 0.016, t - G.holes[i]);
        const R = hook ? 4.2 * MM : 3.2 * MM;
        if (rr < R + 0.6 * MM) {
          const ring = hook ? Math.sqrt(Math.max(0, 1 - (rr / R) ** 2)) : bell(rr - 2.2 * MM, 0.8 * MM);
          if (laceH <= 0 || ring * 1.2 * MM > laceH) {
            h = Math.max(h, (hook ? 1.6 : 0.9) * MM * ring);
            col = metalC;
            metal = smoothstep(0.1, 0.4, ring);
            rough = 0.32;
            if (!hook && rr < 1.4 * MM && laceH <= 0) ao -= 0.6;
          }
          ao -= 0.25 * bell(rr - R, 0.6 * MM);
        }
      }
    }
    // vamp / quarter seam: from the bottom of the lacing down each side to the welt
    {
      const top = G.le;
      const vqA = top.a - 0.012 + (top.c - c) * 0.32;
      if (c < top.c + 0.01 && Math.abs(lat) > 0.008) {
        const d = a - vqA;
        h += seamH(d) + 0.5 * MM * smoothstep(0.5 * MM, -0.5 * MM, d);
        addStitch(d + 2.5 * MM, c);
        addStitch(d + 5.5 * MM, c);
        ao -= 0.25 * bell(d, 0.8 * MM);
      }
    }
    // toe cap
    {
      const capA = G.tipA - 0.062 - 14 * lat * lat;
      const d = a - capA;
      if (c < 0.075) {
        h += seamH(d) * 0.8 + 0.6 * MM * smoothstep(-0.5 * MM, 0.5 * MM, d);
        addStitch(d - 3 * MM, lat);
        addStitch(d - 6 * MM, lat);
        ao -= 0.25 * bell(d, 0.8 * MM);
        if (d > 0) (rough -= 0.1), (darkMix += 0.25);
      }
    }
    // heel counter
    {
      const hc = 0.028 + 0.05 * smoothstep(0.005, -0.075, a);
      const d = c - hc;
      if (a < 0.03) {
        const on = smoothstep(0.5 * MM, -0.5 * MM, d);
        h += 0.7 * MM * on + seamH(d) * 0.6;
        addStitch(d + 3 * MM, a);
        addStitch(d + 6.5 * MM, a);
        ao -= 0.25 * bell(d, 0.8 * MM);
        darkMix += 0.15 * on;
      }
    }
    // back pull tab and back seam
    if (a < -0.02 && Math.abs(lat) < 0.03) {
      const bs = Math.abs(lat);
      h += seamH(bs) * 0.7;
      if (c > G.le.c + 0.06 || t < 0.06) {
        const tab = smoothstep(0.012, 0.009, bs) * smoothstep(0.06, 0.04, t);
        h += 1.5 * MM * tab;
        addStitch(bs - 0.008, c, smoothstep(0.065, 0.04, t));
        ao -= 0.3 * bell(bs - 0.011, 0.8 * MM) * smoothstep(0.065, 0.04, t);
      }
    }
    // welt stitching just above the sole, all the way round
    {
      const ang = Math.atan2(lat, a - G.tipA * 0.4) * 0.09;
      const d = c - 5.5 * MM;
      addStitch(d, ang, smoothstep(0.012, 0.004, c), 0.45 * MM);
      ao -= 0.3 * smoothstep(0.004, 0, c);
    }
    // flex creases across the vamp near the ball
    const ballA = G.tipA - 0.07;
    if (c > 0.025 && t > G.laceEnd) {
      for (const [k, s0] of [[0, 1], [1, 0.8], [2, 0.6]]) {
        const ca = ballA + 0.012 * (k - 1) + 0.004 * Math.sin(lat * 60 + k);
        h -= 0.45 * MM * s0 * bell(a - ca, 1.3 * MM) * smoothstep(0.045, 0.02, Math.abs(lat));
        darkMix += 0.25 * s0 * bell(a - ca, 1.5 * MM) * smoothstep(0.045, 0.02, Math.abs(lat));
      }
    }
    // scuffs on the toe, heel and low sides; broad tonal variation of the hide
    const nz = noise(q[0], q[1], q[2], 40, 4, 911);
    scuff += smoothstep(G.tipA - 0.03, G.tipA, a) * smoothstep(0.02, 0.06, c + 0.03) * smoothstep(0.45, 0.65, nz);
    scuff += smoothstep(-0.06, -0.085, a) * smoothstep(0.04, 0.0, c) * smoothstep(0.5, 0.7, nz);
    scuff += smoothstep(0.015, 0.0, c) * smoothstep(0.55, 0.75, nz);
    scuff = clamp01(scuff);
    const tone = noise(q[0], q[1], q[2], 8, 3, 921) - 0.5;
    h += 0.2 * MM * tone;
    let r0 = leather[0], g0 = leather[1], b0 = leather[2];
    r0 = mix(r0, dark[0], darkMix + 0.3 * Math.max(0, -tone)); g0 = mix(g0, dark[1], darkMix + 0.3 * Math.max(0, -tone)); b0 = mix(b0, dark[2], darkMix + 0.3 * Math.max(0, -tone));
    r0 = mix(r0, scuffC[0], scuff * 0.7); g0 = mix(g0, scuffC[1], scuff * 0.7); b0 = mix(b0, scuffC[2], scuff * 0.7);
    if (col) [r0, g0, b0] = col;
    const tw = Math.min(1, thread * 0.9) * (col === null ? 1 : 0);
    o.h = h;
    o.r = mix(r0, threadC[0], tw); o.g = mix(g0, threadC[1], tw); o.b = mix(b0, threadC[2], tw);
    o.ao = clamp01(ao);
    o.rough = clamp01(rough + 0.3 * scuff + 0.25 * tw);
    o.metal = metal;
  };
}
