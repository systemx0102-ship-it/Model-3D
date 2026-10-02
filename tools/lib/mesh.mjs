// Mesh assembly helpers: split OBJ corners into GPU vertices (unique position/UV pairs),
// keep the quad list for subdivision/export, and compute seam-safe normals and tangents.
import * as THREE from 'three';

/**
 * @param positions  Float32Array of all source vertices (already transformed)
 * @param uvs        Float32Array of source UVs
 * @param faces      [{v:[], t:[]}] faces to include (quads or tris)
 */
export function assemble(positions, uvs, faces) {
  const key = new Map();
  const src = [];
  const outUv = [];
  const polys = [];
  for (const f of faces) {
    const poly = [];
    for (let i = 0; i < f.v.length; i++) {
      const k = f.v[i] * 131072 + (f.t[i] + 1);
      let idx = key.get(k);
      if (idx === undefined) {
        idx = src.length;
        key.set(k, idx);
        src.push(f.v[i]);
        if (f.t[i] >= 0) outUv.push(uvs[f.t[i] * 2], uvs[f.t[i] * 2 + 1]);
        else outUv.push(0, 0);
      }
      poly.push(idx);
    }
    polys.push(poly);
  }
  const n = src.length;
  const pos = new Float32Array(n * 3);
  src.forEach((s, i) => pos.set(positions.subarray(s * 3, s * 3 + 3), i * 3));
  return { positions: pos, uvs: Float32Array.from(outUv), src: Int32Array.from(src), polys };
}

export function triangulate(polys) {
  const out = [];
  for (const p of polys) for (let i = 1; i + 1 < p.length; i++) out.push(p[0], p[i], p[i + 1]);
  return Uint32Array.from(out);
}

/** Area-weighted normals, welded across UV seams via the shared source index. */
export function computeNormals(positions, indices, weldKey) {
  const n = positions.length / 3;
  const keyCount = Math.max(...weldKey) + 1;
  const acc = new Float32Array(keyCount * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    const [i0, i1, i2] = [indices[i], indices[i + 1], indices[i + 2]];
    a.fromArray(positions, i0 * 3); b.fromArray(positions, i1 * 3); c.fromArray(positions, i2 * 3);
    e1.subVectors(b, a); e2.subVectors(c, a);
    const fn = e1.cross(e2); // magnitude = 2*area
    for (const v of [i0, i1, i2]) {
      const k = weldKey[v] * 3;
      acc[k] += fn.x; acc[k + 1] += fn.y; acc[k + 2] += fn.z;
    }
  }
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const k = weldKey[v] * 3;
    const l = Math.hypot(acc[k], acc[k + 1], acc[k + 2]) || 1;
    out[v * 3] = acc[k] / l; out[v * 3 + 1] = acc[k + 1] / l; out[v * 3 + 2] = acc[k + 2] / l;
  }
  return out;
}

/** Per-vertex tangents (xyz + handedness w) from UV gradients, Gram-Schmidt against the normal. */
export function computeTangents(positions, normals, uvs, indices) {
  const n = positions.length / 3;
  const tan = new Float32Array(n * 3);
  const bit = new Float32Array(n * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const v = [indices[i], indices[i + 1], indices[i + 2]];
    const p = v.map((j) => [positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]]);
    const t = v.map((j) => [uvs[j * 2], uvs[j * 2 + 1]]);
    const x1 = p[1][0] - p[0][0], y1 = p[1][1] - p[0][1], z1 = p[1][2] - p[0][2];
    const x2 = p[2][0] - p[0][0], y2 = p[2][1] - p[0][1], z2 = p[2][2] - p[0][2];
    const s1 = t[1][0] - t[0][0], t1 = t[1][1] - t[0][1];
    const s2 = t[2][0] - t[0][0], t2 = t[2][1] - t[0][1];
    const det = s1 * t2 - s2 * t1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    const sd = [(t2 * x1 - t1 * x2) * r, (t2 * y1 - t1 * y2) * r, (t2 * z1 - t1 * z2) * r];
    const td = [(s1 * x2 - s2 * x1) * r, (s1 * y2 - s2 * y1) * r, (s1 * z2 - s2 * z1) * r];
    for (const j of v) for (let k = 0; k < 3; k++) (tan[j * 3 + k] += sd[k]), (bit[j * 3 + k] += td[k]);
  }
  const out = new Float32Array(n * 4);
  const N = new THREE.Vector3(), T = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    N.fromArray(normals, i * 3); T.fromArray(tan, i * 3); B.fromArray(bit, i * 3);
    T.addScaledVector(N, -N.dot(T));
    if (T.lengthSq() < 1e-16) T.set(1, 0, 0).addScaledVector(N, -N.x);
    T.normalize();
    const w = C.crossVectors(N, T).dot(B) < 0 ? -1 : 1;
    out.set([T.x, T.y, T.z, w], i * 4);
  }
  return out;
}

export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], positions[i + k])), (max[k] = Math.max(max[k], positions[i + k]));
  return { min, max };
}
