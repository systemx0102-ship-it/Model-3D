// Surface binding: attaches arbitrary points (lashes, brows, tear lines, clothing) to the
// closest triangle of a reference mesh using an affine triangle frame (edge1, edge2, normal).
// Blendshape deltas are then transferred by re-evaluating the point in the deformed frame,
// which carries rotation of the surface (an eyelid closing rotates its lashes with it).
import * as THREE from 'three';

export class TriangleSet {
  constructor(positions, triangles) {
    this.p = positions; // Float32Array (n*3), indexed by `triangles`
    this.t = triangles; // Uint32Array (m*3)
    const m = triangles.length / 3;
    this.centroids = new Float32Array(m * 3);
    for (let i = 0; i < m; i++)
      for (let k = 0; k < 3; k++)
        this.centroids[i * 3 + k] =
          (positions[triangles[i * 3] * 3 + k] + positions[triangles[i * 3 + 1] * 3 + k] + positions[triangles[i * 3 + 2] * 3 + k]) / 3;
    // uniform grid over centroids for nearest queries
    this.cell = 0.01;
    this.grid = new Map();
    for (let i = 0; i < m; i++) {
      const key = this.key(this.centroids[i * 3], this.centroids[i * 3 + 1], this.centroids[i * 3 + 2]);
      (this.grid.get(key) ?? this.grid.set(key, []).get(key)).push(i);
    }
  }
  key(x, y, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`;
  }
  /** Closest point on the triangle set (exact over candidate triangles in nearby cells). */
  closest(q, filter) {
    const cx = Math.floor(q.x / this.cell), cy = Math.floor(q.y / this.cell), cz = Math.floor(q.z / this.cell);
    const tri = new THREE.Triangle();
    const tmp = new THREE.Vector3();
    let best = null, bestD = Infinity;
    for (let r = 1; r <= 6 && !best; r++) {
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let z = cz - r; z <= cz + r; z++) {
            const list = this.grid.get(`${x},${y},${z}`);
            if (!list) continue;
            for (const i of list) {
              if (filter && !filter(i)) continue;
              this.triangle(i, tri);
              tri.closestPointToPoint(q, tmp);
              const d = tmp.distanceToSquared(q);
              if (d < bestD) (bestD = d), (best = { tri: i, point: tmp.clone(), dist: Math.sqrt(d) });
            }
          }
    }
    return best;
  }
  triangle(i, out = new THREE.Triangle(), deltas = null) {
    const t = this.t, p = this.p;
    const get = (v, target) => {
      target.fromArray(p, v * 3);
      if (deltas) target.x += deltas[v * 3], target.y += deltas[v * 3 + 1], target.z += deltas[v * 3 + 2];
      return target;
    };
    get(t[i * 3], out.a); get(t[i * 3 + 1], out.b); get(t[i * 3 + 2], out.c);
    return out;
  }
}

function frameOf(tri) {
  const e1 = new THREE.Vector3().subVectors(tri.b, tri.a);
  const e2 = new THREE.Vector3().subVectors(tri.c, tri.a);
  const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
  return { o: tri.a.clone(), m: new THREE.Matrix3().set(e1.x, e2.x, n.x, e1.y, e2.y, n.y, e1.z, e2.z, n.z) };
}

/** Binds points to the triangle closest to `anchor` (one frame per group, e.g. per lash). */
export function bindGroup(set, points, anchor, filter) {
  const hit = set.closest(anchor, filter);
  const tri = set.triangle(hit.tri);
  const { o, m } = frameOf(tri);
  const inv = m.clone().invert();
  const coords = points.map((p) => p.clone().sub(o).applyMatrix3(inv));
  return { tri: hit.tri, coords, bary: tri.getBarycoord(hit.point, new THREE.Vector3()) };
}

/** Delta of every bound point under a per-vertex delta field of the reference mesh. */
export function boundDeltas(set, binding, deltas) {
  const tri = set.triangle(binding.tri, new THREE.Triangle(), deltas);
  const { o, m } = frameOf(tri);
  const rest = set.triangle(binding.tri);
  const { o: o0, m: m0 } = frameOf(rest);
  return binding.coords.map((c) => {
    const p1 = c.clone().applyMatrix3(m).add(o);
    const p0 = c.clone().applyMatrix3(m0).add(o0);
    return p1.sub(p0);
  });
}

/** Interpolated skin weights at a triangle's barycentric point (top 4, renormalised). */
export function bindWeights(set, binding, joints, weights) {
  const acc = new Map();
  const b = [binding.bary.x, binding.bary.y, binding.bary.z];
  for (let k = 0; k < 3; k++) {
    const v = set.t[binding.tri * 3 + k];
    for (let j = 0; j < 4; j++) {
      const w = weights[v * 4 + j] * b[k];
      if (w > 0) acc.set(joints[v * 4 + j], (acc.get(joints[v * 4 + j]) ?? 0) + w);
    }
  }
  const top = [...acc.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4);
  const s = top.reduce((x, [, w]) => x + w, 0) || 1;
  const J = [0, 0, 0, 0], W = [0, 0, 0, 0];
  top.forEach(([j, w], i) => ((J[i] = j), (W[i] = w / s)));
  return { J, W };
}
