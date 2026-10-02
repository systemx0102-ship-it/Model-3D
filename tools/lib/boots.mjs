// Ankle boots with their own clean quad topology, built by sweeping cross-section planes over a
// smoothed "last" of the foot (toes merged):
//   shaft  - horizontal planes stepping down the leg,
//   ankle  - planes rotating 90 deg about a lateral axis held just in front of the ankle crease
//            (planes only meet on that axis, which lies outside the boot, so sections never fold),
//   foot   - vertical planes stepping forward to the toes, closed by a domed toe cap.
// Each section is measured with rays against the last (and, in the shaft, against the trousers so
// the cuffs tuck in). Real thickness (outer + inner wall + collar rim); weights from the foot.
import * as THREE from 'three';

const SEG = 36, CAP = 7;

export function buildBoot({ side, rig, last, footTri, trousers, perVertexWeights, world, ease = 0.0055, shaftEase = 0.003, thickness = 0.0028, shaftHeight = 0.15 }) {
  const sgn = side === 'l' ? 1 : -1;
  const B = (n) => rig.byName.get(`${n}_${side}`);
  const ankle = B('foot').head.clone();
  let tip = ankle.clone();
  for (const v of footTri.verts) if (last[v * 3 + 2] > tip.z) tip = new THREE.Vector3().fromArray(last, v * 3);
  const fwd = new THREE.Vector3(tip.x - ankle.x, 0, tip.z - ankle.z).normalize();
  const Y = new THREE.Vector3(0, 1, 0);

  const mesh = (positions, indices) => new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)).setIndex(new THREE.BufferAttribute(indices, 1)),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  const lastMesh = mesh(last, footTri.tris);
  const pantsMesh = trousers ? mesh(trousers.positions, trousers.indices) : null;
  const ray = new THREE.Raycaster();
  const cast = (o, dir, target, far = 0.2) => {
    ray.set(o, dir);
    ray.far = far;
    return ray.intersectObject(target, false);
  };

  // pivot axis: in front of the ankle crease, clear of the skin by more than the boot's thickness
  const frontHit = cast(ankle, fwd, lastMesh).at(-1);
  const A = ankle.clone().addScaledVector(fwd, (frontHit?.distance ?? 0.04) + 0.034);
  const top = A.y + shaftHeight;

  // section planes: origin O, direction d from O into the section, normal n (sweep direction)
  const planes = [];
  const NS = 13, NR = 15;
  for (let i = 0; i < NS; i++) planes.push({ O: A.clone().addScaledVector(Y, shaftHeight * (1 - i / NS)), d: fwd.clone().negate(), n: Y.clone().negate(), half: false, phase: 0, h: shaftHeight * (1 - i / NS) });
  for (let i = 0; i <= NR; i++) {
    const th = (i / NR) * Math.PI * 0.5;
    planes.push({ O: A.clone(), d: fwd.clone().multiplyScalar(-Math.cos(th)).addScaledVector(Y, -Math.sin(th)), n: fwd.clone().multiplyScalar(Math.sin(th)).addScaledVector(Y, -Math.cos(th)), half: true, phase: 1 });
  }
  const reach = tip.clone().sub(A).dot(fwd) - 0.014;
  const NF = Math.max(6, Math.round(reach / 0.009));
  for (let i = 1; i <= NF; i++) planes.push({ O: A.clone().addScaledVector(fwd, (i / NF) * reach), d: Y.clone().negate(), n: fwd.clone(), half: true, phase: 2 });

  // centres: midpoint of the section along d, then centred laterally
  for (const P of planes) {
    P.up = P.d.clone().negate();
    P.lat = new THREE.Vector3().crossVectors(P.n, P.up).normalize();
    const hits = cast(P.O, P.d, lastMesh, 0.3);
    P.c = hits.length ? P.O.clone().addScaledVector(P.d, (hits[0].distance + hits.at(-1).distance) / 2) : null;
  }
  for (let i = 0; i < planes.length; i++) if (!planes[i].c) planes[i].c = planes[i - 1].c.clone().add(planes[i].O).sub(planes[i - 1].O);
  for (const P of planes) {
    const a = cast(P.c, P.lat, lastMesh, 0.12).at(-1)?.distance ?? 0.03;
    const b = cast(P.c, P.lat.clone().negate(), lastMesh, 0.12).at(-1)?.distance ?? 0.03;
    P.off = (a - b) / 2;
  }
  for (let it = 0; it < 6; it++) {
    const o = planes.map((P) => P.off);
    for (let i = 1; i < planes.length - 1; i++) planes[i].off = (o[i - 1] + 2 * o[i] + o[i + 1]) / 4;
  }
  planes.forEach((P) => P.c.addScaledVector(P.lat, P.off));

  // radii: farthest skin hit inside the plane's half-space, made convex (boots bridge the arch,
  // the toe gaps, the Achilles hollow); the ease grows toward the toe box and tightens on the shaft
  const inHalf = (P, p) => !P.half || p.clone().sub(P.O).dot(P.d) > 0.002;
  const sameLeg = (p) => Math.sign(p.x) === sgn;
  let minClear = Infinity;
  planes.forEach((P, i) => {
    P.dirs = [];
    let radii = [];
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const dir = P.up.clone().multiplyScalar(Math.cos(a)).addScaledVector(P.lat, Math.sin(a));
      const hits = cast(P.c, dir, lastMesh, 0.16).filter((h) => inHalf(P, h.point));
      radii.push(hits.length ? hits.at(-1).distance : i ? planes[i - 1].radii[k] : 0.04);
      P.dirs.push(dir);
    }
    P.radii = convexRadii(radii);
    const s = P.phase === 2 ? P.O.clone().sub(A).dot(fwd) / reach : 0;
    P.e = P.phase === 0 ? THREE.MathUtils.lerp(ease, shaftEase, THREE.MathUtils.smoothstep(P.h / shaftHeight, 0.15, 0.5)) : ease + 0.003 * THREE.MathUtils.smoothstep(s, 0.45, 1);
  });
  // requirements: the skin hull and, in the shaft, the trousers (inner wall clears the fabric)
  const req = planes.map((P) => {
    const r = P.radii.slice();
    if (P.phase === 0 && pantsMesh)
      P.dirs.forEach((dir, k) => {
        const ph = cast(P.c, dir, pantsMesh, 0.12).filter((h) => sameLeg(h.point));
        if (ph.length) r[k] = Math.max(r[k], ph.at(-1).distance + 0.0015 - P.e);
      });
    return convexRadii(r);
  });
  planes.forEach((P, i) => (P.radii = req[i].slice()));
  // geometric smoothing of the section points, each constrained to slide along its own ray: never
  // inside a requirement, and never across the pivot axis (the ankle crease fills with a fillet)
  const N = planes.length;
  const rmax = planes.map((P) => P.dirs.map((dir) => {
    const dd = dir.dot(P.d);
    return P.half && dd < -1e-3 ? (P.c.clone().sub(P.O).dot(P.d) - 0.004 - P.e - thickness) / -dd : Infinity;
  }));
  const pt = (i, k) => planes[i].c.clone().addScaledVector(planes[i].dirs[k], planes[i].radii[k]);
  for (let it = 0; it < 40; it++) {
    const pts = planes.map((P, i) => P.dirs.map((_, k) => pt(i, k)));
    for (let i = 0; i < N; i++)
      for (let k = 0; k < SEG; k++) {
        const q = pts[Math.max(0, i - 1)][k].clone().add(pts[Math.min(N - 1, i + 1)][k])
          .add(pts[i][(k + SEG - 1) % SEG]).add(pts[i][(k + 1) % SEG]).addScaledVector(pts[i][k], 2).multiplyScalar(1 / 6);
        const r = q.sub(planes[i].c).dot(planes[i].dirs[k]);
        planes[i].radii[k] = Math.min(rmax[i][k], Math.max(req[i][k], r));
      }
  }
  // clearance of the outer wall from the pivot axis (must stay positive: no folds at the instep)
  for (const P of planes)
    if (P.phase === 1) minClear = Math.min(minClear, P.c.clone().sub(P.O).dot(P.d) - P.radii[0] - P.e - thickness);

  // rings of the outer and inner walls; domed toe cap closing on an apex. The underside is pressed
  // flat (heel included) by a smooth monotonic remap of the height above the floor: y -> h * s(h).
  let floor = null;
  const FLAT = 0.03;
  const ringPts = (P, extra, scale = 1) => {
    const out = [];
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const dir = P.up.clone().multiplyScalar(Math.cos(a)).addScaledVector(P.lat, Math.sin(a));
      const p = P.c.clone().addScaledVector(dir, (P.radii[k] + P.e + extra) * scale);
      if (floor !== null) {
        const h = Math.max(0, p.y - floor);
        p.y = floor + h * THREE.MathUtils.smoothstep(h, 0, FLAT);
      }
      out.push(p);
    }
    return out;
  };
  const end = planes.at(-1);
  const toeLen = Math.max(0.01, tip.clone().sub(end.c).dot(fwd));
  const capCentre = (u, extra) => end.c.clone().addScaledVector(fwd, (toeLen + end.e + extra) * Math.sin(u));
  floor = Math.min(...planes.flatMap((P) => ringPts(P, thickness).map((p) => p.y)));
  const outerRings = planes.map((P) => ringPts(P, thickness));
  const innerRings = planes.map((P) => ringPts(P, 0));
  for (let j = 1; j < CAP; j++) {
    const u = (j / CAP) * Math.PI * 0.5;
    for (const [rings, extra] of [[outerRings, thickness], [innerRings, 0]]) rings.push(ringPts({ ...end, c: capCentre(u, extra) }, extra, Math.cos(u)));
  }
  const apexO = end.c.clone().addScaledVector(fwd, toeLen + end.e + thickness);
  const apexI = end.c.clone().addScaledVector(fwd, toeLen + end.e);

  // assemble: outer rings, outer apex, inner rings, inner apex, collar rim
  const R = outerRings.length;
  const pos = [], uv = [], layer = [], idx = [];
  const push = (p, u, v, l) => (pos.push(p.x, p.y, p.z), uv.push(u, v), layer.push(l), pos.length / 3 - 1);
  // v follows arc length along the centres so the leather texture does not stretch
  const cen = [...planes.map((P) => P.c), ...outerRings.slice(planes.length).map((r) => r.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / SEG)), apexO];
  const arc = [0];
  for (let i = 1; i < cen.length; i++) arc.push(arc[i - 1] + cen[i].distanceTo(cen[i - 1]));
  const vOf = (i) => arc[i] / arc.at(-1);
  const wall = (rings, apex, l) => {
    const base = pos.length / 3;
    rings.forEach((ring, i) => ring.forEach((p, k) => push(p, k / SEG, vOf(i), l)));
    const ap = push(apex, 0.5, 1, l);
    const flip = l === 1;
    for (let i = 0; i < R - 1; i++)
      for (let k = 0; k < SEG; k++) {
        const a = base + i * SEG + k, b = base + i * SEG + ((k + 1) % SEG), c = a + SEG, d = b + SEG;
        if (flip) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    for (let k = 0; k < SEG; k++) {
      const a = base + (R - 1) * SEG + k, b = base + (R - 1) * SEG + ((k + 1) % SEG);
      if (flip) idx.push(a, b, ap);
      else idx.push(a, ap, b);
    }
    return base;
  };
  const oBase = wall(outerRings, apexO, 0);
  const iBase = wall(innerRings, apexI, 1);
  for (let k = 0; k < SEG; k++) {
    const a = push(outerRings[0][k], k / SEG, 0, 2), b = push(innerRings[0][k], k / SEG, 0.02, 3);
    void a, b;
  }
  const rim = pos.length / 3 - SEG * 2;
  for (let k = 0; k < SEG; k++) {
    const a = rim + k * 2, b = rim + ((k + 1) % SEG) * 2;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const positions = Float32Array.from(pos);
  const indices = Uint32Array.from(idx);
  // winding: outer wall normals must point away from the section centres
  {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let s = 0;
    for (let t = 0; t < (R - 1) * SEG * 6; t += 3) {
      a.fromArray(positions, indices[t] * 3); b.fromArray(positions, indices[t + 1] * 3); c.fromArray(positions, indices[t + 2] * 3);
      const ring = Math.floor((indices[t] - oBase) / SEG);
      s += b.clone().sub(a).cross(c.clone().sub(a)).dot(a.clone().sub(cen[Math.min(ring, cen.length - 1)]));
    }
    if (s < 0) for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  }
  void iBase;
  // skin weights: nearest foot/leg vertex of the body
  const n = positions.length / 3;
  const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  const cand = footTri.verts;
  for (let i = 0; i < n; i++) {
    let best = cand[0], bd = Infinity;
    for (const v of cand) {
      const d = (world[v * 3] - positions[i * 3]) ** 2 + (world[v * 3 + 1] - positions[i * 3 + 1]) ** 2 + (world[v * 3 + 2] - positions[i * 3 + 2]) ** 2;
      if (d < bd) (bd = d), (best = v);
    }
    const w = perVertexWeights(best);
    joints.set(w.J, i * 4);
    weights.set(w.W, i * 4);
  }
  return { positions, uvs: Float32Array.from(uv), indices, layer: Uint8Array.from(layer), joints, weights, topY: top, pivotClearance: minClear };
}

/** Radii (evenly spaced angles around a centre) pushed out to the section's convex hull. */
function convexRadii(radii) {
  const n = radii.length;
  const pts = radii.map((r, k) => [Math.cos((k / n) * Math.PI * 2) * r, Math.sin((k / n) * Math.PI * 2) * r]);
  const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return radii.map((r, k) => {
    const dx = Math.cos((k / n) * Math.PI * 2), dy = Math.sin((k / n) * Math.PI * 2);
    let best = r;
    for (let j = 0; j < hull.length; j++) {
      const [ax, ay] = hull[j], [bx, by] = hull[(j + 1) % hull.length];
      // ray (t*dx, t*dy) against segment a + u*(b - a)
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = (ax * ey - ay * ex) / den, u = (ax * dy - ay * dx) / den;
      if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.max(best, t);
    }
    return best;
  });
}
