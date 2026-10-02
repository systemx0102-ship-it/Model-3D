// Eyeballs, lid margins and tear lines.
// Eye model (per eye, local frame: +Z = gaze): sclera sphere radius R fitted to the socket,
// cornea = sphere cap (radius 0.65R) meeting the sclera at the limbus (iris radius 0.49R).
// The iris itself is not modelled as geometry: the eye shader refracts the view ray through
// the cornea onto a recessed iris plane (parallax-correct iris depth, like UE's eye shader).
import * as THREE from 'three';

export const EYE = {
  limbus: 0.49, // iris radius / R  (11.8 mm iris on a 24 mm eye)
  cornea: 0.65, // cornea curvature radius / R
  irisDepth: 0.86, // iris plane z / R
};

export function corneaGeometry(R) {
  const rL = EYE.limbus * R;
  const Rc = EYE.cornea * R;
  const zL = Math.sqrt(R * R - rL * rL);
  const zc = zL - Math.sqrt(Rc * Rc - rL * rL);
  return { rL, Rc, zL, zc, thetaL: Math.asin(EYE.limbus) };
}

/** Ordered loop of vertex indices along the boundary between `inner` faces and the rest. */
export function boundaryLoop(innerFaces) {
  const count = new Map();
  const dir = new Map();
  for (const f of innerFaces)
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(k, (count.get(k) ?? 0) + 1);
      dir.set(k, [a, b]);
    }
  const next = new Map();
  for (const [k, c] of count) if (c === 1) next.set(dir.get(k)[0], dir.get(k)[1]);
  const start = next.keys().next().value;
  const loop = [start];
  for (let v = next.get(start); v !== start && loop.length <= next.size; v = next.get(v)) loop.push(v);
  return loop;
}

export function eyeFrame(center, gaze) {
  const z = gaze.clone().normalize();
  const x = new THREE.Vector3(1, 0, 0).addScaledVector(z, -z.x).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(center);
}

/** UV-sphere eyeball with cornea bulge; returns positions/normals/uvs/indices in world space. */
export function eyeballMesh(frame, R, rings = 48, segs = 64) {
  const g = corneaGeometry(R);
  const pos = [], nrm = [], uv = [], idx = [];
  const nrmMat = new THREE.Matrix3().setFromMatrix4(frame);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i <= rings; i++) {
    // denser rings across the cornea and limbus
    const s = i / rings;
    const theta = s < 0.4 ? (s / 0.4) * g.thetaL * 1.25 : g.thetaL * 1.25 + ((s - 0.4) / 0.6) * (Math.PI - g.thetaL * 1.25);
    for (let j = 0; j <= segs; j++) {
      const phi = (j / segs) * Math.PI * 2;
      const d = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta));
      let r = R;
      if (theta < g.thetaL) {
        r = g.zc * d.z + Math.sqrt(g.Rc * g.Rc - g.zc * g.zc * (1 - d.z * d.z));
        p.copy(d).multiplyScalar(r);
        n.set(p.x, p.y, p.z - g.zc).normalize();
      } else {
        p.copy(d).multiplyScalar(r);
        n.copy(d);
      }
      uv.push(0.5 + (0.5 * p.x) / R, 0.5 - (0.5 * p.y) / R); // image top = eye top
      const wp = p.clone().applyMatrix4(frame);
      const wn = n.clone().applyMatrix3(nrmMat).normalize();
      pos.push(wp.x, wp.y, wp.z);
      nrm.push(wn.x, wn.y, wn.z);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      if (i > 0) idx.push(a, c, b);
      if (i < rings - 1) idx.push(b, c, d);
    }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

/** Thin wet strip between the lid margin and the eyeball (lacrimal meniscus). */
export function tearlineStrip(loopPoints, center, R) {
  const pos = [], nrm = [], uv = [], idx = [];
  const n = loopPoints.length;
  loopPoints.forEach((m, i) => {
    const toC = new THREE.Vector3().subVectors(center, m).normalize();
    const outer = m.clone().addScaledVector(toC, 0.00012);
    const inner = center.clone().addScaledVector(toC.clone().negate(), R + 0.00006);
    inner.lerp(outer, 0.15);
    const normal = new THREE.Vector3().subVectors(outer, center).normalize();
    for (const [p, u] of [[outer, 0], [inner, 1]]) {
      pos.push(p.x, p.y, p.z);
      nrm.push(normal.x, normal.y, normal.z);
      uv.push(u, i / n);
    }
    const a = i * 2, b = ((i + 1) % n) * 2;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  });
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

/** Concentric vertex rings around a hole, starting at the boundary of `innerFaces`. */
export function ringsAround(innerFaces, allFaces, count) {
  const adj = new Map();
  for (const f of allFaces)
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      (adj.get(a) ?? adj.set(a, new Set()).get(a)).add(b);
      (adj.get(b) ?? adj.set(b, new Set()).get(b)).add(a);
    }
  const seen = new Set(innerFaces.flatMap((f) => f.v));
  let ring = boundaryLoop(innerFaces);
  const rings = [ring];
  for (let k = 1; k < count; k++) {
    for (const v of ring) seen.add(v);
    // keep loop order: for each vertex of the previous ring, take its unseen neighbours in order
    const next = [];
    const added = new Set();
    for (const v of ring)
      for (const u of adj.get(v))
        if (!seen.has(u) && !added.has(u)) {
          added.add(u);
          next.push(u);
        }
    ring = orderLoop(next, adj);
    rings.push(ring);
  }
  return rings;
}

function orderLoop(verts, adj) {
  const set = new Set(verts);
  const out = [verts[0]];
  const used = new Set(out);
  while (out.length < verts.length) {
    const cur = out.at(-1);
    const n = [...adj.get(cur)].find((u) => set.has(u) && !used.has(u));
    if (n === undefined) break;
    out.push(n);
    used.add(n);
  }
  return out.length === verts.length ? out : verts;
}

/** Eye-surface radius (relative to R) for a direction `theta` off the gaze axis. */
export function unitSurface(theta) {
  const g = corneaGeometry(1);
  return theta < g.thetaL ? g.zc * Math.cos(theta) + Math.sqrt(g.Rc ** 2 - g.zc ** 2 * Math.sin(theta) ** 2) : 1;
}

/**
 * Fits eyeball radius R and a forward offset (along the gaze) so the eye sits against the inner
 * lid surface: every contact point keeps >= `gap` clearance, and the upper/lower lids are as
 * close as possible. Points are given in the original eye frame (Matrix4 inverse applied).
 */
export function fitEye(localPoints, { gap = 0.00015, rMin = 0.0118, rMax = 0.0126 } = {}) {
  let best = null;
  for (let R = rMin; R <= rMax + 1e-9; R += 0.00005)
    for (let d = 0; d <= 0.006; d += 0.0001) {
      let minGap = Infinity, sum = 0, n = 0;
      for (const p of localPoints) {
        const z = p.z - d;
        const dist = Math.hypot(p.x, p.y, z);
        const theta = Math.acos(Math.max(-1, Math.min(1, z / dist)));
        const g = dist - R * unitSurface(theta);
        minGap = Math.min(minGap, g);
        if (Math.abs(p.y) > 0.0025) (sum += g), n++;
      }
      if (minGap < gap) continue;
      const score = sum / Math.max(1, n);
      if (!best || score < best.score) best = { R, offset: d, score, minGap };
    }
  return best;
}
