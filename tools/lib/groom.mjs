// Hair groom: long, layered hair with a side part, curtain bangs, face-framing lengths and soft
// waves. Produces simulated guide strands (draped under gravity against the body colliders with
// the runtime solver) and the per-strand interpolation data for ~40k rendered strands, plus
// static baby hairs along the hairline.
import * as THREE from 'three';
import { scalp, SKULL_CENTER } from '../../character/hairline.mjs';
import { StrandSim } from '../../src/physics/strands.js';
import { TriangleSet } from './binding.mjs';

export const HAIR_STYLE = {
  partOffset: 0.026, // side part, on her left (m from the midline)
  lengths: { bangs: 0.15, side: 0.37, top: 0.47, back: 0.5, nape: 0.4 },
  layer: { bangs: 0.005, side: 0.006, top: 0.01, back: 0.008, nape: 0.003 },
  points: 32,
  guideSpacing: 0.0125,
  strands: 40000,
  babyHairs: 700,
  wave: { amplitude: 0.008, wavelength: 0.09 },
};

/** Zone classification for a root (q relative to the skull centre). */
export function zoneOf(q, info, partX) {
  const nearPart = Math.abs(q.x - partX) < 0.045;
  if (info.above < 0.024 && q.z > 0.045 && nearPart) return 'bangs';
  if (q.y < -0.035 && q.z < 0.0) return 'nape';
  if (Math.abs(q.x) > 0.052 && q.z > -0.035) return 'side';
  if (q.z < -0.03) return 'back';
  return 'top';
}

export function buildGroom({ world, headTris, normals, earMask, eyes, colliders, rng, style = HAIR_STYLE }) {
  const eyeMid = eyes.l.center.clone().add(eyes.r.center).multiplyScalar(0.5);
  const skull = eyeMid.clone().add(new THREE.Vector3(...SKULL_CENTER));
  const partX = eyeMid.x + style.partOffset - skull.x;
  const P = (v) => new THREE.Vector3(world[v * 3], world[v * 3 + 1], world[v * 3 + 2]);
  const Nn = (v) => new THREE.Vector3(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
  const info = (p, ear = 0) => scalp([p.x - eyeMid.x, p.y - eyeMid.y, p.z - eyeMid.z], ear);

  // --- scalp sampling -----------------------------------------------------------------------
  const tris = [];
  let total = 0;
  for (let t = 0; t < headTris.length; t += 3) {
    const [a, b, c] = [headTris[t], headTris[t + 1], headTris[t + 2]];
    const pa = P(a), pb = P(b), pc = P(c);
    const cen = pa.clone().add(pb).add(pc).multiplyScalar(1 / 3);
    const ear = (earMask[a] + earMask[b] + earMask[c]) / 3;
    const d = info(cen, ear).scalp;
    if (d < 0.02) continue;
    const area = new THREE.Triangle(pa, pb, pc).getArea();
    total += area * d;
    tris.push({ a, b, c, cdf: total });
  }
  const sample = () => {
    for (;;) {
      const x = rng() * total;
      let lo = 0, hi = tris.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tris[mid].cdf < x) lo = mid + 1;
        else hi = mid;
      }
      const t = tris[lo];
      let u = rng(), v = rng();
      if (u + v > 1) (u = 1 - u), (v = 1 - v);
      const p = P(t.a).multiplyScalar(1 - u - v).add(P(t.b).multiplyScalar(u)).add(P(t.c).multiplyScalar(v));
      const n = Nn(t.a).multiplyScalar(1 - u - v).add(Nn(t.b).multiplyScalar(u)).add(Nn(t.c).multiplyScalar(v)).normalize();
      const ear = earMask[t.a] * (1 - u - v) + earMask[t.b] * u + earMask[t.c] * v;
      const inf = info(p, ear);
      if (rng() > inf.scalp) continue;
      return { p, n, info: inf, q: p.clone().sub(skull) };
    }
  };

  // scalp ellipsoid (for combing over the head surface)
  const sp = [];
  for (let i = 0; i < 4000; i++) sp.push(sample().p);
  const bb = new THREE.Box3().setFromPoints(sp);
  const ec = skull.clone();
  const radii = new THREE.Vector3(Math.max(bb.max.x - ec.x, ec.x - bb.min.x), bb.max.y - ec.y, Math.max(bb.max.z - ec.z, ec.z - bb.min.z));
  const shellPoint = (p, h) => {
    const q = p.clone().sub(ec);
    const s = Math.hypot(q.x / radii.x, q.y / radii.y, q.z / radii.z);
    return ec.clone().add(q.divideScalar(s).multiplyScalar(1 + h / ((radii.x + radii.y + radii.z) / 3)));
  };
  const shellNormal = (p) => {
    const q = p.clone().sub(ec);
    return new THREE.Vector3(q.x / radii.x ** 2, q.y / radii.y ** 2, q.z / radii.z ** 2).normalize();
  };
  const crown = ec.clone().add(new THREE.Vector3(partX * 0.6, radii.y * 0.82, -radii.z * 0.45));

  // the real head surface: keep strands at least `h` outside the skin
  const headSet = new TriangleSet(world, headTris);
  const tri = new THREE.Triangle();
  const triN = new THREE.Vector3();
  const outside = (p, h) => {
    const hit = headSet.closest(p);
    if (!hit) return false;
    headSet.triangle(hit.tri, tri);
    tri.getNormal(triN);
    const cv = tri.a.clone().add(tri.b).add(tri.c).multiplyScalar(1 / 3);
    if (triN.dot(cv.sub(ec)) < 0) triN.negate(); // outward
    const d = p.clone().sub(hit.point).dot(triN);
    if (d >= h) return false;
    p.copy(hit.point).addScaledVector(triN, h);
    return true;
  };

  const combDir = (root, zone) => {
    const q = root.q;
    const side = Math.sign(q.x - partX) || 1;
    let d;
    if (zone === 'bangs') d = new THREE.Vector3(side * 1.0, -0.25, 0.2); // curtain: swept out to the temples
    else if (zone === 'side') d = new THREE.Vector3(side * 0.25, -1, q.z > 0.02 ? 0.12 : -0.25);
    else if (zone === 'nape') d = new THREE.Vector3(0, -1, -0.15);
    else if (q.z > crown.z - ec.z) d = new THREE.Vector3(side * 1.0, -0.1, -0.45 * Math.min(1, Math.max(0.2, q.z / 0.06))); // away from the part, swept back
    else d = root.p.clone().sub(crown).setY(-0.04).normalize().add(new THREE.Vector3(0, -0.5, 0)); // whorl at the crown
    d.addScaledVector(root.n, -d.dot(root.n)).normalize();
    return d;
  };

  // --- guides -------------------------------------------------------------------------------
  const guideRoots = [];
  for (let tries = 0; tries < 60000 && guideRoots.length < 340; tries++) {
    const r = sample();
    if (guideRoots.some((g) => g.p.distanceToSquared(r.p) < style.guideSpacing ** 2)) continue;
    r.zone = zoneOf(r.q, r.info, partX);
    guideRoots.push(r);
  }
  const NP = style.points;
  const guides = guideRoots.map((r, gi) => {
    const zone = r.zone;
    const L = style.lengths[zone] * (1 + (rng() * 2 - 1) * 0.06) * (zone === 'side' ? THREE.MathUtils.lerp(0.86, 1.12, THREE.MathUtils.smoothstep(-r.q.z, -0.04, 0.06)) : 1);
    const seg = L / (NP - 1);
    const h = style.layer[zone] * (0.7 + 0.6 * rng());
    let dir = combDir(r, zone);
    const pts = [r.p.clone()];
    let onHead = true;
    // which side of the shoulders this lock falls: face-framing front locks in front
    const frontLock = (zone === 'side' && r.q.z > 0.015 && rng() < 0.65) || zone === 'bangs';
    for (let k = 1; k < NP; k++) {
      const prev = pts[k - 1];
      let p;
      if (k === 1) p = prev.clone().addScaledVector(r.n, h * 0.7).addScaledVector(dir, seg * 0.7);
      else p = prev.clone().addScaledVector(dir, seg);
      if (onHead) {
        const sn = shellNormal(p);
        if (sn.y < (zone === 'bangs' ? 0.55 : 0.05) && k > 1) onHead = false;
        else {
          p = shellPoint(p, h);
          outside(p, h);
          dir = p.clone().sub(prev).normalize();
        }
      }
      if (!onHead) {
        const fall = new THREE.Vector3(0, -1, frontLock ? 0.22 : -0.2);
        dir.lerp(fall.normalize(), zone === 'bangs' ? 0.25 : 0.35).normalize();
      }
      // keep segment length exact
      pts.push(prev.clone().add(p.sub(prev).setLength(seg)));
    }
    return { rest: Float32Array.from(pts.flatMap((v) => v.toArray())), zone, seed: 1000 + gi, root: r, length: L, frontLock };
  });

  // drape under gravity against the body (shared runtime solver, heavily damped)
  const drapeZones = {};
  for (const z of Object.keys(style.lengths))
    drapeZones[z] = { global: [0.9, 0.02, 0.0], bend: [0.7, 0.2, 0.08], damping: [0.35, 0.3, 0.3], drag: 0, inertia: 1, angularInertia: 1, radius: 0.006 };
  const I = new THREE.Matrix4().elements;
  const tmp = new THREE.Vector3();
  const settle = (zones, steps, extraColliders = []) => {
    const sim = new StrandSim(guides, zones, { iterations: 4 });
    sim.reset(I);
    const minH = guides.map((g) => style.layer[g.zone] * 0.6);
    for (let i = 0; i < steps; i++) {
      sim.step(I, [...colliders, ...extraColliders]);
      // scalp guard against the actual head mesh (the colliders are only proxies)
      for (let g = 0; g < guides.length; g++)
        for (let k = 1; k < NP; k++) {
          const o = (g * NP + k) * 3;
          tmp.fromArray(sim.pos, o);
          if (tmp.distanceToSquared(ec) > 0.016) continue;
          if (outside(tmp, minH[g] + 0.0015 * Math.min(1, k / 6))) {
            sim.pos[o] = tmp.x; sim.pos[o + 1] = tmp.y; sim.pos[o + 2] = tmp.z;
          }
        }
    }
    guides.forEach((g, gi) => g.rest.set(sim.pos.subarray(gi * NP * 3, (gi + 1) * NP * 3)));
  };
  // a head proxy keeps locks off the scalp/face during the drape
  const headProxy = { type: 'sphere', c: ec.toArray(), r: Math.min(radii.x, radii.z) * 0.98 };
  // a shield in front of the face during the drape so face-framing locks fall beside the face
  const faceShield = { type: 'capsule', a: eyeMid.clone().add(new THREE.Vector3(0, 0.035, 0.015)).toArray(), b: eyeMid.clone().add(new THREE.Vector3(0, -0.11, 0.005)).toArray(), r: 0.078 };
  settle(drapeZones, 420, [headProxy, faceShield]);

  // waves: elliptical 3D waves below the ear line, growing toward the tips (hair "memory")
  const axis = new THREE.Vector3(0, 0, ec.z);
  for (const g of guides) {
    const A = style.wave.amplitude * (0.75 + 0.5 * rng()) * (g.zone === 'bangs' ? 0.35 : 1);
    const lam = style.wave.wavelength * (0.85 + 0.3 * rng());
    const ph = rng() * Math.PI * 2;
    let arc = 0;
    const pts = [];
    for (let k = 0; k < NP; k++) pts.push(new THREE.Vector3().fromArray(g.rest, k * 3));
    const startArc = g.length * (g.zone === 'bangs' ? 0.45 : 0.3);
    const out = pts.map((p) => p.clone());
    for (let k = 1; k < NP; k++) {
      arc += pts[k].distanceTo(pts[k - 1]);
      const t = THREE.MathUtils.smoothstep(arc, startArc, startArc + 0.08);
      if (t <= 0) continue;
      const T = pts[Math.min(k + 1, NP - 1)].clone().sub(pts[k - 1]).normalize();
      const outward = pts[k].clone().sub(axis.clone().setY(pts[k].y)).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(T, outward).normalize();
      const w = (2 * Math.PI * arc) / lam + ph;
      out[k].addScaledVector(side, Math.sin(w) * A * t).addScaledVector(outward, Math.cos(w) * A * 0.45 * t);
    }
    g.rest.set(out.flatMap((v) => v.toArray()));
  }
  const keepZones = {};
  for (const z of Object.keys(style.lengths))
    keepZones[z] = { global: [0.95, 0.5, 0.35], bend: [0.6, 0.5, 0.4], damping: [0.5, 0.5, 0.5], drag: 0, inertia: 1, angularInertia: 1, radius: 0.005 };
  settle(keepZones, 60, [headProxy, faceShield]);

  // --- rendered strands: interpolation data ------------------------------------------------
  const groupOf = (zone, q) => (zone === 'bangs' ? 'bangs' : (zone === 'top' || zone === 'side') && q.z > -0.03 ? (q.x > partX ? 'L' : 'R') : 'rest');
  const groups = new Map();
  guides.forEach((g, i) => {
    const k = groupOf(g.zone, g.root.q);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(i);
  });
  const M = style.strands;
  const S = {
    guides: new Float32Array(M * 3),
    weights: new Float32Array(M * 3),
    rootOffset: new Float32Array(M * 3),
    params: new Float32Array(M * 4), // length fraction, seed, clump strength, kind (0 hair / 1 flyaway)
    shape: new Float32Array(M * 4), // wave amp, wave freq, phase, frizz
  };
  for (let s = 0; s < M; s++) {
    const r = sample();
    const zone = zoneOf(r.q, r.info, partX);
    let cand = groups.get(groupOf(zone, r.q)) ?? [];
    if (cand.length < 3) cand = guides.map((_, i) => i);
    const near = cand.map((i) => [i, guides[i].root.p.distanceToSquared(r.p)]).sort((a, b) => a[1] - b[1]).slice(0, 3);
    let wsum = 0;
    const w = near.map(([, d]) => 1 / (d + 1e-6));
    for (const x of w) wsum += x;
    const off = r.p.clone();
    near.forEach(([gi], k) => {
      S.guides[s * 3 + k] = gi;
      S.weights[s * 3 + k] = w[k] / wsum;
      off.addScaledVector(guides[gi].root.p, -w[k] / wsum);
    });
    S.rootOffset.set(off.toArray(), s * 3);
    const fly = rng() < 0.016 ? 1 : 0;
    S.params.set([fly ? 0.9 + 0.12 * rng() : 0.84 + 0.16 * rng(), rng(), 0.35 + 0.4 * rng(), fly], s * 4);
    S.shape.set([0.0012 + 0.0025 * rng(), 10 + 6 * rng(), rng() * 6.283, fly ? 0.012 + 0.025 * rng() : 0.0008 * rng() * rng()], s * 4);
  }

  // --- baby hairs (static, bound to the skin) ---------------------------------------------------
  const baby = [];
  for (let tries = 0; tries < 200000 && baby.length < style.babyHairs; tries++) {
    const r = sample();
    if (rng() > r.info.edge * 1.4 || r.info.above > 0.012) continue;
    const zone = zoneOf(r.q, r.info, partX);
    const dir = combDir(r, zone).applyAxisAngle(r.n, (rng() * 2 - 1) * 0.7);
    const len = 0.006 + 0.026 * rng() * rng();
    const curl = (rng() * 2 - 1) * 3.2;
    const pts = [r.p.clone()];
    let d = dir.clone();
    for (let k = 1; k <= 5; k++) {
      d.applyAxisAngle(r.n, curl / 5);
      const lift = Math.sin((k / 5) * Math.PI * 0.6) * 0.0012;
      pts.push(pts[k - 1].clone().addScaledVector(d, len / 5).addScaledVector(r.n, lift / 5 + 0.00008));
    }
    baby.push({ points: pts, width: (t) => THREE.MathUtils.lerp(0.00005, 0.00002, t), side: new THREE.Vector3().crossVectors(r.n, dir).normalize(), normal: r.n, seed: rng(), root: r.p.clone(), kind: 'baby' });
  }

  return { guides, strands: S, baby, NP, partX: partX + skull.x, skull: skull.toArray() };
}
