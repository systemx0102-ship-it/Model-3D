// Texture-set baking driver: per-vertex inputs (region masks, AO, thickness, curvature),
// anatomical landmarks, rasterisation of each skin tile and image encoding.
import path from 'node:path';
import fs from 'node:fs';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import sharp from 'sharp';
import { loadTarget } from './targets.mjs';
import { rasterize, dilate } from './raster.mjs';
import { makeSkinShader, V, VCOUNT } from './skinbake.mjs';
import { smoothstep } from './noise.mjs';

const MASK_TARGETS = {
  [V.LIPS]: ['mouth/mouth-lowerlip-volume-incr', 'mouth/mouth-upperlip-volume-incr'],
  [V.NOSE]: ['nose/nose-volume-incr'],
  [V.CHEEK]: ['cheek/l-cheek-volume-incr', 'cheek/r-cheek-volume-incr'],
  [V.EAR]: ['ears/l-ear-scale-incr', 'ears/r-ear-scale-incr'],
  [V.UNDEREYE]: ['eyes/l-eye-bag-incr', 'eyes/r-eye-bag-incr'],
  [V.LID]: ['eyes/l-eye-eyefold-up', 'eyes/r-eye-eyefold-up'],
  [V.BROW]: ['eyebrows/eyebrows-trans-up'],
  [V.CHIN]: ['chin/chin-prominent-incr'],
  [V.FOREHEAD]: ['forehead/forehead-scale-vert-incr'],
  [V.NECK]: ['neck/neck-scale-horiz-incr'],
  [V.NAVEL]: ['stomach/stomach-navel-in'],
};

/** Region masks from MakeHuman detail targets: displacement magnitude, normalised per target. */
export function regionMasks(mhDir, vertexCount) {
  const out = new Float32Array(vertexCount * VCOUNT);
  for (const [ch, files] of Object.entries(MASK_TARGETS)) {
    for (const f of files) {
      const t = loadTarget(path.join(mhDir, 'targets', `${f}.target`));
      let max = 0;
      const mags = new Float32Array(t.idx.length);
      for (let k = 0; k < t.idx.length; k++) {
        mags[k] = Math.hypot(t.d[k * 3], t.d[k * 3 + 1], t.d[k * 3 + 2]);
        max = Math.max(max, mags[k]);
      }
      for (let k = 0; k < t.idx.length; k++) {
        const o = t.idx[k] * VCOUNT + +ch;
        out[o] = Math.max(out[o], mags[k] / max);
      }
    }
  }
  return out;
}

/** Ray-traced per-vertex ambient occlusion, thickness (for translucency) and curvature. */
export function vertexLighting(positions, normals, triangles, verts, adjacency, { aoRays = 48, thickRays = 16 } = {}) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(triangles, 1));
  const bvh = new MeshBVH(geom);
  const ray = new THREE.Ray();
  const n = new THREE.Vector3(), p = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), d = new THREE.Vector3();
  const ao = new Float32Array(positions.length / 3).fill(1);
  const thick = new Float32Array(positions.length / 3).fill(1);
  const curv = new Float32Array(positions.length / 3);
  // stratified directions (golden spiral on the hemisphere)
  const hemi = (count, cosine) =>
    Array.from({ length: count }, (_, i) => {
      const u = (i + 0.5) / count;
      const z = cosine ? Math.sqrt(1 - u) : 1 - u;
      const r = Math.sqrt(1 - z * z);
      const a = i * 2.399963;
      return [r * Math.cos(a), r * Math.sin(a), z];
    });
  const aoDirs = hemi(aoRays, true);
  const thDirs = hemi(thickRays, false).map(([x, y, z]) => [x * 0.45, y * 0.45, z]);
  for (const v of verts) {
    n.fromArray(normals, v * 3);
    p.fromArray(positions, v * 3);
    t1.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).cross(n).normalize();
    t2.crossVectors(n, t1);
    let occ = 0;
    for (const [x, y, z] of aoDirs) {
      d.copy(t1).multiplyScalar(x).addScaledVector(t2, y).addScaledVector(n, z).normalize();
      ray.origin.copy(p).addScaledVector(n, 0.0004);
      ray.direction.copy(d);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (hit && hit.distance < 0.2) occ += 1 - hit.distance / 0.2;
    }
    ao[v] = 1 - occ / aoDirs.length;
    let sum = 0, cnt = 0;
    for (const [x, y, z] of thDirs) {
      d.copy(t1).multiplyScalar(x).addScaledVector(t2, y).addScaledVector(n, -z).normalize();
      ray.origin.copy(p).addScaledVector(n, -0.0002);
      ray.direction.copy(d);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      sum += hit ? Math.min(hit.distance, 0.1) : 0.1;
      cnt++;
    }
    thick[v] = sum / cnt;
    // curvature: mean normal divergence over the one-ring (1/m)
    let k = 0, kn = 0;
    for (const u of adjacency.get(v) ?? []) {
      const dx = positions[v * 3] - positions[u * 3], dy = positions[v * 3 + 1] - positions[u * 3 + 1], dz = positions[v * 3 + 2] - positions[u * 3 + 2];
      const dn = (normals[v * 3] - normals[u * 3]) * dx + (normals[v * 3 + 1] - normals[u * 3 + 1]) * dy + (normals[v * 3 + 2] - normals[u * 3 + 2]) * dz;
      k += dn / (dx * dx + dy * dy + dz * dz);
      kn++;
    }
    curv[v] = kn ? k / kn : 0;
  }
  return { ao, thick, curv };
}

const toSrgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const u8 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));

/**
 * Bakes one skin texture set.
 * @param mesh  sub-mesh {positions, normals, tangents, uvs, indices, src, region?: Int8Array per tri}
 */
export function bakeTile(mesh, N, vattr, ctx, { head = false } = {}) {
  const T = mesh.indices.length / 3;
  const uv = new Float32Array(T * 6);
  for (let t = 0; t < T; t++)
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      uv[t * 6 + k * 2] = mesh.uvs[v * 2];
      uv[t * 6 + k * 2 + 1] = mesh.uvs[v * 2 + 1];
    }
  const NN = N * N;
  const color = new Float32Array(NN * 3);
  const orm = new Float32Array(NN * 3);
  const nrm = new Float32Array(NN * 3);
  const data = new Float32Array(NN * 4);
  const height = new Float32Array(NN);
  const wrink = head ? new Float32Array(NN * 3) : null;
  const wmask = head ? new Float32Array(NN * 4) : null;
  const mask = new Uint8Array(NN);
  const shade = makeSkinShader({ ...ctx, wrinkles: head });
  const P = [0, 0, 0], Nv = [0, 0, 0], Tv = [0, 0, 0], Bv = [0, 0, 0];
  const Vt = new Float32Array(VCOUNT);
  const out = {};
  const pos = mesh.positions, nor = mesh.normals, tan = mesh.tangents, src = mesh.src, idx = mesh.indices;
  rasterize(N, uv, (pi, t, w0, w1, w2) => {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      P[k] = pos[a * 3 + k] * w0 + pos[b * 3 + k] * w1 + pos[c * 3 + k] * w2;
      Nv[k] = nor[a * 3 + k] * w0 + nor[b * 3 + k] * w1 + nor[c * 3 + k] * w2;
      Tv[k] = tan[a * 4 + k] * w0 + tan[b * 4 + k] * w1 + tan[c * 4 + k] * w2;
    }
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
    const sa = src[a] * VCOUNT, sb = src[b] * VCOUNT, sc = src[c] * VCOUNT;
    for (let k = 0; k < VCOUNT; k++) Vt[k] = vattr[sa + k] * w0 + vattr[sb + k] * w1 + vattr[sc + k] * w2;
    shade(P, Nv, Tv, Bv, Vt, mesh.region ? mesh.region[t] : 0, out);
    color[pi * 3] = out.r; color[pi * 3 + 1] = out.g; color[pi * 3 + 2] = out.b;
    orm[pi * 3] = Vt[V.AO]; orm[pi * 3 + 1] = out.rough; orm[pi * 3 + 2] = 0;
    // tangent-space normal from the analytic height gradient
    const gT = out.gx * Tv[0] + out.gy * Tv[1] + out.gz * Tv[2];
    const gB = out.gx * Bv[0] + out.gy * Bv[1] + out.gz * Bv[2];
    let nx = -gT, ny = -gB, nz = 1;
    l = Math.hypot(nx, ny, nz);
    nrm[pi * 3] = nx / l; nrm[pi * 3 + 1] = ny / l; nrm[pi * 3 + 2] = nz / l;
    data[pi * 4] = out.cav;
    data[pi * 4 + 1] = Math.exp(-Vt[V.THICK] / 0.009); // translucency
    data[pi * 4 + 2] = Math.min(1, Math.max(0, Vt[V.CURV] / 120));
    data[pi * 4 + 3] = out.scatter;
    height[pi] = out.h;
    if (head) {
      const wT = out.wgx * Tv[0] + out.wgy * Tv[1] + out.wgz * Tv[2];
      const wB = out.wgx * Bv[0] + out.wgy * Bv[1] + out.wgz * Bv[2];
      nx = -wT; ny = -wB; nz = 1;
      l = Math.hypot(nx, ny, nz);
      wrink[pi * 3] = nx / l; wrink[pi * 3 + 1] = ny / l; wrink[pi * 3 + 2] = nz / l;
      wmask[pi * 4] = out.wm0; wmask[pi * 4 + 1] = out.wm1; wmask[pi * 4 + 2] = out.wm2; wmask[pi * 4 + 3] = out.wm3;
    }
    mask[pi] = 1;
  });
  const bufs = [
    { data: color, channels: 3 }, { data: orm, channels: 3 }, { data: nrm, channels: 3 }, { data: data, channels: 4 }, { data: height, channels: 1 },
  ];
  if (head) bufs.push({ data: wrink, channels: 3 }, { data: wmask, channels: 4 });
  dilate(N, bufs, mask, 24);
  return { N, color, orm, nrm, data, height, wrink, wmask };
}

/** Encodes a baked set to image files. formats: 'png' (engine export) and/or 'webp' (web runtime). */
export async function writeTile(set, dir, name, { formats = ['webp'], heightRange = 0.0004 } = {}) {
  const { N } = set;
  const NN = N * N;
  const files = {};
  const enc = async (key, buf, channels, opts = {}) => {
    for (const f of formats) {
      const file = path.join(dir, `T_${name}_${key}.${f}`);
      let img = sharp(buf, { raw: { width: N, height: N, channels } });
      img = f === 'png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality: opts.quality ?? 90, alphaQuality: 100, lossless: !!opts.lossless, effort: 4 });
      await img.toFile(file);
      (files[key] ??= {})[f] = path.basename(file);
    }
  };
  const c8 = Buffer.alloc(NN * 3), o8 = Buffer.alloc(NN * 3), n8 = Buffer.alloc(NN * 3), d8 = Buffer.alloc(NN * 4);
  for (let i = 0; i < NN; i++) {
    for (let k = 0; k < 3; k++) {
      c8[i * 3 + k] = u8(toSrgb(set.color[i * 3 + k]));
      o8[i * 3 + k] = u8(set.orm[i * 3 + k]);
      n8[i * 3 + k] = u8(set.nrm[i * 3 + k] * 0.5 + 0.5);
    }
    for (let k = 0; k < 4; k++) d8[i * 4 + k] = u8(set.data[i * 4 + k]);
  }
  await enc('BaseColor', c8, 3, { quality: 92 });
  await enc('ORM', o8, 3, { quality: 92 });
  await enc('Normal', n8, 3, { quality: 95 });
  await enc('Data', d8, 4, { quality: 95 });
  if (formats.includes('png')) {
    // 16-bit height for displacement / Nanite tessellation; 0.5 = surface, range ±heightRange m
    const h16 = Buffer.alloc(NN * 2);
    for (let i = 0; i < NN; i++) h16.writeUInt16BE(Math.max(0, Math.min(65535, Math.round((0.5 + set.height[i] / (2 * heightRange)) * 65535))), i * 2);
    const file = path.join(dir, `T_${name}_Height.png`);
    await sharp(h16, { raw: { width: N, height: N, channels: 1, premultiplied: false } }).toColourspace('grey16').png({ compressionLevel: 9 }).toFile(file).catch(async () => {
      fs.writeFileSync(file.replace('.png', '.r16'), h16);
    });
    files.Height = { png: path.basename(file) };
  }
  if (set.wrink) {
    const w8 = Buffer.alloc(NN * 3), m8 = Buffer.alloc(NN * 4);
    for (let i = 0; i < NN; i++) {
      for (let k = 0; k < 3; k++) w8[i * 3 + k] = u8(set.wrink[i * 3 + k] * 0.5 + 0.5);
      for (let k = 0; k < 4; k++) m8[i * 4 + k] = u8(smoothstep(0, 0.6, set.wmask[i * 4 + k]));
    }
    await enc('WrinkleNormal', w8, 3, { quality: 95 });
    await enc('WrinkleMask', m8, 4, { quality: 90 });
  }
  return files;
}
