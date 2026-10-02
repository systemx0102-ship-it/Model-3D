// Skinned garments grown from the body mesh: region selection -> outward offset -> Laplacian
// relaxation with body collision (fabric bridges concavities instead of shrink-wrapping) ->
// solid shell with real thickness (outer + inner surface + hem rims) -> own UV atlas,
// smoothed skin weights and transferred breathing blendshapes.
import * as THREE from 'three';
import { TriangleSet } from './binding.mjs';

/** Boundary loops (ordered vertex lists) of a set of polygons. */
export function boundaryLoops(polys) {
  const count = new Map(), dir = new Map();
  for (const p of polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
      dir.set(k, [a, b]);
    }
  const next = new Map();
  for (const [k, c] of count) if (c === 1) next.set(dir.get(k)[0], dir.get(k)[1]);
  const seen = new Set();
  const loops = [];
  for (const s of next.keys()) {
    if (seen.has(s)) continue;
    const loop = [];
    for (let v = s; !seen.has(v); v = next.get(v)) {
      seen.add(v);
      loop.push(v);
      if (!next.has(v)) break;
    }
    loops.push(loop);
  }
  return loops;
}

function adjacency(polys, n) {
  const adj = Array.from({ length: n }, () => new Set());
  for (const p of polys)
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      adj[a].add(b);
      adj[b].add(a);
    }
  return adj.map((s) => [...s]);
}

/**
 * @param src        { world, normals (per MH vertex), faces (MH polys with .v and .t), uvs (packed, glTF) }
 * @param include    (vertexIndex, position Vector3) => boolean
 * @param opt        { ease, thickness, relax, clearance }
 */
export function growGarment(src, include, opt) {
  const { world, normals, faces } = src;
  const P = (v) => new THREE.Vector3(world[v * 3], world[v * 3 + 1], world[v * 3 + 2]);
  const vin = new Map();
  const isIn = (v) => {
    if (!vin.has(v)) vin.set(v, include(v, P(v)));
    return vin.get(v);
  };
  let sel = faces.filter((f) => f.v.every(isIn));
  // drop tiny disconnected bits (keep components with > 2% of the faces)
  sel = largestComponents(sel, 0.02);
  // local indexing
  const map = new Map();
  const srcIdx = [];
  const polys = sel.map((f) => f.v.map((v) => {
    if (!map.has(v)) {
      map.set(v, srcIdx.length);
      srcIdx.push(v);
    }
    return map.get(v);
  }));
  const n = srcIdx.length;
  const pos = new Float32Array(n * 3);
  srcIdx.forEach((v, i) => {
    const ease = typeof opt.ease === 'function' ? opt.ease(v, P(v)) : opt.ease;
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = world[v * 3 + k] + normals[v * 3 + k] * (ease + opt.thickness);
  });
  const adj = adjacency(polys, n);
  const loops = boundaryLoops(polys);
  const onBoundary = new Uint8Array(n);
  const loopNext = new Map();
  for (const L of loops) L.forEach((v, i) => {
    onBoundary[v] = 1;
    loopNext.set(v, [L[(i + L.length - 1) % L.length], L[(i + 1) % L.length]]);
  });

  // relaxation: Laplacian smoothing + keep a clearance outside the body
  const bodySet = opt.collisionSet ?? src.bodySet; // e.g. a smoothed "last" for footwear
  const tri = new THREE.Triangle(), tn = new THREE.Vector3(), q = new THREE.Vector3();
  const tmp = new Float32Array(n * 3);
  // Taubin smoothing (alternating +lambda / -mu passes) removes zig-zag and bumps without the
  // shrinkage of plain Laplacian smoothing, which would eat thin straps and round off necklines
  const pass = (lam, interior) => {
    for (let i = 0; i < n; i++) {
      const nb = onBoundary[i] ? loopNext.get(i) : adj[i];
      const l = onBoundary[i] ? lam : interior;
      let x = 0, y = 0, z = 0;
      for (const j of nb) (x += pos[j * 3]), (y += pos[j * 3 + 1]), (z += pos[j * 3 + 2]);
      tmp[i * 3] = pos[i * 3] + (x / nb.length - pos[i * 3]) * l;
      tmp[i * 3 + 1] = pos[i * 3 + 1] + (y / nb.length - pos[i * 3 + 1]) * l;
      tmp[i * 3 + 2] = pos[i * 3 + 2] + (z / nb.length - pos[i * 3 + 2]) * l;
    }
    pos.set(tmp);
  };
  for (let it = 0; it < opt.relax; it++) {
    pass(0.5, 0.55);
    // interior: 'smooth' garments (boots: smooth toe box) use plain Laplacian, others keep mild
    // tension; the boundary is always volume-preserving
    pass(-0.53, opt.smoothInterior ? 0 : it % 2 ? -0.2 : 0);
    // collision with the body surface
    for (let i = 0; i < n; i++) {
      q.fromArray(pos, i * 3);
      const hit = bodySet.closest(q);
      if (!hit) continue;
      bodySet.triangle(hit.tri, tri);
      tri.getNormal(tn);
      const sv = srcIdx[i];
      if (tn.dot(new THREE.Vector3(normals[sv * 3], normals[sv * 3 + 1], normals[sv * 3 + 2])) < 0) tn.negate();
      const d = q.clone().sub(hit.point).dot(tn);
      const need = opt.clearance + opt.thickness;
      if (d < need) {
        q.copy(hit.point).addScaledVector(tn, need);
        pos[i * 3] = q.x; pos[i * 3 + 1] = q.y; pos[i * 3 + 2] = q.z;
      }
    }
  }
  return { polys, srcIdx, pos, loops, onBoundary, adj };
}

function largestComponents(faces, minFrac) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const f of faces) for (const v of f.v) if (!parent.has(v)) parent.set(v, v);
  for (const f of faces) for (let i = 1; i < f.v.length; i++) {
    const a = find(f.v[0]), b = find(f.v[i]);
    if (a !== b) parent.set(a, b);
  }
  const size = new Map();
  for (const f of faces) {
    const r = find(f.v[0]);
    size.set(r, (size.get(r) ?? 0) + 1);
  }
  return faces.filter((f) => size.get(find(f.v[0])) >= faces.length * minFrac);
}

/**
 * Turns a relaxed shell into a closed thin solid: outer surface (as relaxed), inner surface
 * offset inward by the fabric thickness, and rim quads along every boundary (hems).
 * Also builds a per-garment UV atlas from the source body UVs.
 */
export function solidify(g, src, { thickness, uvScale = 1 }) {
  const n = g.srcIdx.length;
  // vertex normals of the shell
  const nrm = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const p of g.polys)
    for (let i = 1; i + 1 < p.length; i++) {
      a.fromArray(g.pos, p[0] * 3); b.fromArray(g.pos, p[i] * 3); c.fromArray(g.pos, p[i + 1] * 3);
      const fn = b.sub(a).cross(c.sub(a));
      for (const v of [p[0], p[i], p[i + 1]]) (nrm[v * 3] += fn.x), (nrm[v * 3 + 1] += fn.y), (nrm[v * 3 + 2] += fn.z);
    }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
    nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
  }
  // per-garment UV atlas: source UV islands repacked side by side (uniform scale)
  const uvSrc = new Float32Array(n * 2);
  const vtOf = new Map(); // source vertex -> a UV (first corner seen)
  for (const f of src.faces) f.v.forEach((v, k) => !vtOf.has(v) && vtOf.set(v, [src.uvs[f.t[k] * 2], src.uvs[f.t[k] * 2 + 1], src.tileOfVt[f.t[k]]]));
  const tiles = new Map();
  g.srcIdx.forEach((v, i) => {
    const [u, w, t] = vtOf.get(v);
    uvSrc[i * 2] = u; uvSrc[i * 2 + 1] = w;
    if (!tiles.has(t)) tiles.set(t, { min: [1, 1], max: [0, 0], verts: [] });
    const T = tiles.get(t);
    T.min[0] = Math.min(T.min[0], u); T.min[1] = Math.min(T.min[1], w);
    T.max[0] = Math.max(T.max[0], u); T.max[1] = Math.max(T.max[1], w);
    T.verts.push(i);
  });
  const list = [...tiles.values()];
  const totalW = list.reduce((s, T) => s + (T.max[0] - T.min[0]), 0);
  const maxH = Math.max(...list.map((T) => T.max[1] - T.min[1]));
  const sc = Math.min(0.96 / (totalW + 0.02 * list.length), 0.96 / maxH);
  const uv = new Float32Array(n * 2);
  let ox = 0.02;
  for (const T of list) {
    for (const i of T.verts) {
      uv[i * 2] = ox + (uvSrc[i * 2] - T.min[0]) * sc;
      uv[i * 2 + 1] = 0.02 + (uvSrc[i * 2 + 1] - T.min[1]) * sc;
    }
    ox += (T.max[0] - T.min[0]) * sc + 0.02;
  }
  // assemble: outer [0,n), inner [n,2n), rims
  const pos = [], nor = [], uvs = [], src2 = [], layer = [], idx = [];
  for (let i = 0; i < n; i++) {
    pos.push(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
    nor.push(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    uvs.push(uv[i * 2], uv[i * 2 + 1]);
    src2.push(i);
    layer.push(0);
  }
  for (let i = 0; i < n; i++) {
    pos.push(g.pos[i * 3] - nrm[i * 3] * thickness, g.pos[i * 3 + 1] - nrm[i * 3 + 1] * thickness, g.pos[i * 3 + 2] - nrm[i * 3 + 2] * thickness);
    nor.push(-nrm[i * 3], -nrm[i * 3 + 1], -nrm[i * 3 + 2]);
    uvs.push(uv[i * 2], uv[i * 2 + 1]);
    src2.push(i);
    layer.push(1);
  }
  for (const p of g.polys) {
    for (let i = 1; i + 1 < p.length; i++) {
      idx.push(p[0], p[i], p[i + 1]);
      idx.push(n + p[0], n + p[i + 1], n + p[i]);
    }
  }
  // rims (hems): duplicate verts so rim normals face outward from the boundary
  for (const L of g.loops) {
    const base = pos.length / 3;
    L.forEach((v, k) => {
      const nx = L[(k + 1) % L.length], pv = L[(k + L.length - 1) % L.length];
      const t = new THREE.Vector3().fromArray(g.pos, nx * 3).sub(new THREE.Vector3().fromArray(g.pos, pv * 3)).normalize();
      const nn = new THREE.Vector3().fromArray(nrm, v * 3);
      const out = new THREE.Vector3().crossVectors(t, nn).normalize();
      for (const [lay, sgn] of [[0, 0], [1, 1]]) {
        pos.push(g.pos[v * 3] - nrm[v * 3] * thickness * sgn, g.pos[v * 3 + 1] - nrm[v * 3 + 1] * thickness * sgn, g.pos[v * 3 + 2] - nrm[v * 3 + 2] * thickness * sgn);
        nor.push(out.x, out.y, out.z);
        uvs.push(uv[v * 2], uv[v * 2 + 1]);
        src2.push(v);
        layer.push(2 + lay);
      }
    });
    // orientation of the rim: consistent with the outer surface winding
    for (let k = 0; k < L.length; k++) {
      const a0 = base + k * 2, b0 = base + ((k + 1) % L.length) * 2;
      idx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
    }
  }
  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nor),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(idx),
    shellVertex: Int32Array.from(src2), // which shell vertex each render vertex came from
    layer: Uint8Array.from(layer),
    uvScale: sc * uvScale,
  };
}

/** Skin weights for garment vertices from the body source vertex, optionally smoothed over the shell. */
export function garmentWeights(g, perVertex, rig, smooth = 2) {
  const n = g.srcIdx.length;
  let maps = g.srcIdx.map((v) => new Map(perVertex[v] ?? [['pelvis', 1]]));
  for (let it = 0; it < smooth; it++) {
    maps = maps.map((m, i) => {
      const out = new Map();
      const add = (mm, w) => mm.forEach((x, k) => out.set(k, (out.get(k) ?? 0) + x * w));
      add(m, 0.5);
      for (const j of g.adj[i]) add(maps[j], 0.5 / g.adj[i].length);
      return out;
    });
  }
  const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  maps.forEach((m, i) => {
    const top = [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const s = top.reduce((x, [, w]) => x + w, 0) || 1;
    top.forEach(([b, w], k) => {
      joints[i * 4 + k] = rig.byName.get(b).index;
      weights[i * 4 + k] = w / s;
    });
  });
  return { joints, weights };
}

export function bodySetFor(world, triangles) {
  return new TriangleSet(world, triangles);
}

/**
 * Taubin-smoothed copy of a region of the body (a shoe "last"): toes and the gaps between them
 * merge into one smooth surface while the overall volume is preserved.
 */
export function smoothedRegion(world, faces, inRegion, iterations = 40) {
  const pos = Float32Array.from(world);
  const adj = new Map();
  for (const f of faces)
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      if (!inRegion(a) && !inRegion(b)) continue;
      (adj.get(a) ?? adj.set(a, new Set()).get(a)).add(b);
      (adj.get(b) ?? adj.set(b, new Set()).get(b)).add(a);
    }
  const verts = [...adj.keys()].filter(inRegion);
  const tmp = new Map();
  const pass = (lam) => {
    for (const v of verts) {
      let x = 0, y = 0, z = 0, n = 0;
      for (const u of adj.get(v)) (x += pos[u * 3]), (y += pos[u * 3 + 1]), (z += pos[u * 3 + 2]), n++;
      tmp.set(v, [pos[v * 3] + (x / n - pos[v * 3]) * lam, pos[v * 3 + 1] + (y / n - pos[v * 3 + 1]) * lam, pos[v * 3 + 2] + (z / n - pos[v * 3 + 2]) * lam]);
    }
    for (const [v, p] of tmp) pos.set(p, v * 3);
  };
  for (let i = 0; i < iterations; i++) {
    pass(0.6);
    pass(-0.62);
  }
  return pos;
}
