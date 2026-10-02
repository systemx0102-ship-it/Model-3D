// Turns polyline strands into thin ribbon geometry (2 verts per point) for lashes, brows and
// exported hair cards. uv.x runs across the ribbon, uv.y root (0) -> tip (1); uv1.x is a
// per-strand random value used for colour/roughness variation in the shader.
import * as THREE from 'three';

/**
 * strands: [{points: Vector3[], width: number|fn(t), side: Vector3 (ribbon width axis), normal?: Vector3, seed}]
 */
export function ribbons(strands) {
  const pos = [], nrm = [], uv = [], uv1 = [], idx = [], strandOf = [];
  const tmpT = new THREE.Vector3(), side = new THREE.Vector3(), n = new THREE.Vector3();
  strands.forEach((s, si) => {
    const P = s.points;
    const base = pos.length / 3;
    for (let i = 0; i < P.length; i++) {
      const t = i / (P.length - 1);
      tmpT.subVectors(P[Math.min(i + 1, P.length - 1)], P[Math.max(i - 1, 0)]).normalize();
      side.copy(s.side).addScaledVector(tmpT, -s.side.dot(tmpT)).normalize();
      n.crossVectors(side, tmpT).normalize();
      if (s.normal && n.dot(s.normal) < 0) n.negate();
      const w = (typeof s.width === 'function' ? s.width(t) : s.width) / 2;
      for (const sgn of [-1, 1]) {
        pos.push(P[i].x + side.x * w * sgn, P[i].y + side.y * w * sgn, P[i].z + side.z * w * sgn);
        nrm.push(n.x, n.y, n.z);
        uv.push(sgn < 0 ? 0 : 1, t);
        uv1.push(s.seed ?? 0, si);
        strandOf.push(si);
      }
      if (i > 0) {
        const a = base + (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  });
  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    uvs: Float32Array.from(uv),
    uvs1: Float32Array.from(uv1),
    indices: Uint32Array.from(idx),
    strandOf: Int32Array.from(strandOf),
  };
}

/** Deterministic PRNG (mulberry32) so builds are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const gauss = (r) => () => {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
