// Outfit: fitted rib-knit tank top (tucked in), cotton-twill cargo trousers, leather ankle boots
// with a rubber sole, leather belt with buckle and a hip pouch. Region rules use rig landmarks so
// they follow any body shape produced by the recipe.
import * as THREE from 'three';
import { growGarment, solidify, garmentWeights, smoothedRegion } from './garments.mjs';
import { buildBoot } from './boots.mjs';

const ARM = /^(upperarm|lowerarm|hand|thumb|index_|middle_|ring_|pinky_)/; // note: not indextoe/middletoe/ringtoe
const NECKHEAD = /^(neck_02|head|eye)/;
const FOOT = /^(foot|ball|bigtoe|indextoe|middletoe|ringtoe|littletoe)/;

export const SOLE = 0.014; // rubber sole thickness below the boot (m)

export function buildOutfit({ rig, world, normals, faces, uvs, tileOfVt, perVertex, bodySet, dominant, bodyTris }) {
  const B = (n) => rig.byName.get(n).head;
  const src = { world, normals, faces, uvs, tileOfVt, bodySet };
  const dom = (v) => dominant(v) ?? 'pelvis';
  const clav = B('clavicle_l').y;
  const hipY = B('thigh_l').y;
  const ankleY = B('foot_l').y;
  const spineZ = B('spine_02').z;
  const out = {};

  // ---- tank top -----------------------------------------------------------------------------
  const shoulder = { l: B('upperarm_l'), r: B('upperarm_r') };
  const tankInclude = (v, p) => {
    const d = dom(v);
    if (ARM.test(d) || NECKHEAD.test(d)) return false;
    if (p.y < hipY - 0.005) return false; // tucked ~5 cm into the trousers
    for (const s of ['l', 'r']) {
      const a = shoulder[s].clone().add(new THREE.Vector3(0, -0.05, 0));
      if (p.distanceTo(a) < 0.092) return false; // armholes
    }
    const ax = Math.abs(p.x);
    const front = p.z > spineZ + 0.03;
    const strap = ax > 0.056 && ax < 0.094;
    if (front && p.y > clav - 0.07 + 3.2 * ax * ax && !strap) return false; // scoop neck
    if (!front && p.y > clav - 0.03 + 2.5 * ax * ax && !strap) return false; // back neckline
    if (strap && /^neck/.test(d) && p.y > clav + 0.06) return false;
    return true;
  };
  out.tank = makeGarment('Tank', tankInclude, { ease: 0.0025, thickness: 0.0012, relax: 30, clearance: 0.0015 }, 1);

  // ---- cargo trousers ------------------------------------------------------------------------
  const waist = hipY + 0.065;
  const pantsInclude = (v, p) => {
    const d = dom(v);
    if (ARM.test(d) || FOOT.test(d)) return false;
    if (p.y > waist + (p.z < spineZ ? 0.012 : 0)) return false;
    if (p.y < ankleY + 0.06) return false; // cuffs tucked into the boot shaft
    return true;
  };
  // loose legs that gather toward the ankle where they are tucked into the boots
  const pantsEase = (v, p) => THREE.MathUtils.lerp(0.0045, 0.016, THREE.MathUtils.smoothstep(p.y, ankleY + 0.13, ankleY + 0.3));
  out.pants = makeGarment('Pants', pantsInclude, { ease: pantsEase, thickness: 0.0011, relax: 40, clearance: 0.0105, smoothInterior: true }, 4);

  // ---- boots (shaft covers the trouser cuffs) -------------------------------------------------
  const bootsInclude = (v, p) => {
    const d = dom(v);
    if (ARM.test(d)) return false;
    return p.y < ankleY + 0.145 && (FOOT.test(d) || /^calf/.test(d));
  };
  // boots: own topology, lofted around a smoothed "last" of the foot (toes merged)
  const footRegion = (v) => world[v * 3 + 1] < ankleY + 0.2 && (FOOT.test(dom(v)) || /^calf/.test(dom(v)));
  const last = smoothedRegion(world, faces, footRegion, 45);
  const wOf = (v) => {
    const top = [...(perVertex[v] ?? new Map([['foot_l', 1]])).entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const s = top.reduce((x, [, w]) => x + w, 0) || 1;
    const J = [0, 0, 0, 0], W = [0, 0, 0, 0];
    top.forEach(([bn, w], k) => ((J[k] = rig.byName.get(bn).index), (W[k] = w / s)));
    return { J, W };
  };
  const bootParts = ['l', 'r'].map((side) => {
    const sgn = side === 'l' ? 1 : -1;
    const tris = [];
    const verts = new Set();
    for (const f of faces) {
      if (!f.v.every((v) => footRegion(v) && Math.sign(world[v * 3]) === sgn)) continue;
      for (let i = 1; i + 1 < f.v.length; i++) tris.push(f.v[0], f.v[i], f.v[i + 1]);
      f.v.forEach((v) => verts.add(v));
    }
    return buildBoot({ side, rig, last, footTri: { tris: Uint32Array.from(tris), verts: [...verts] }, trousers: out.pants, perVertexWeights: wOf, world });
  });
  out.boots = mergeParts(bootParts, 'Boots');
  out.boots.pivotClearance = Math.min(...bootParts.map((b) => b.pivotClearance));
  const bootTop = Math.min(...bootParts.map((b) => b.topY));
  out.boots.covered = new Set();
  for (let v = 0; v < world.length / 3; v++) if (footRegion(v) && world[v * 3 + 1] < bootTop - 0.012) out.boots.covered.add(v);
  out.soles = ['l', 'r'].map((s) => buildSole(out.boots, s, rig));

  // ---- belt, buckle, pouch ---------------------------------------------------------------------
  out.belt = buildBelt(out.pants, rig);

  function makeGarment(name, include, opt, smooth) {
    const g = growGarment(src, include, opt);
    const solid = solidify(g, src, { thickness: opt.thickness });
    const w = garmentWeights(g, perVertex, rig, smooth);
    const joints = new Uint16Array(solid.positions.length / 3 * 4);
    const weights = new Float32Array(solid.positions.length / 3 * 4);
    solid.shellVertex.forEach((sv, i) => {
      joints.set(w.joints.subarray(sv * 4, sv * 4 + 4), i * 4);
      weights.set(w.weights.subarray(sv * 4, sv * 4 + 4), i * 4);
    });
    return { name, shell: g, ...solid, joints, weights, opt };
  }
  return out;
}

/** Rubber sole: convex footprint of the boot bottom, offset into a welt and extruded downward. */
function buildSole(boots, side, rig) {
  const sx = side === 'l' ? 1 : -1;
  const n = boots.positions.length / 3;
  let minY = Infinity;
  for (let i = 0; i < n; i++) if (boots.layer[i] === 0 && boots.positions[i * 3] * sx > 0) minY = Math.min(minY, boots.positions[i * 3 + 1]);
  // footprint: the flat underside, plus the rounded heel counter behind the ankle
  const heelZ = rig.byName.get(`foot_${side}`).head.z;
  const pts = [];
  for (let i = 0; i < n; i++) {
    if (boots.layer[i] !== 0 || boots.positions[i * 3] * sx <= 0) continue;
    const h = boots.positions[i * 3 + 1] - minY, z = boots.positions[i * 3 + 2];
    if (h > (z < heelZ ? 0.014 : 0.004)) continue;
    pts.push(new THREE.Vector2(boots.positions[i * 3], z));
  }
  const hull = hull2(pts);
  // resample the outline evenly by arc length (starting at the heel), with outward normals
  const N = 64;
  const per = [0];
  for (let i = 1; i <= hull.length; i++) per.push(per[i - 1] + hull[i % hull.length].distanceTo(hull[i - 1]));
  const total = per.at(-1);
  const at = (s) => {
    s = ((s % total) + total) % total;
    let j = 0;
    while (per[j + 1] < s) j++;
    return hull[j].clone().lerp(hull[(j + 1) % hull.length], (s - per[j]) / (per[j + 1] - per[j] || 1));
  };
  const outline = Array.from({ length: N }, (_, k) => at((k / N) * total));
  // light smoothing so the hull corners become a rounded toe and heel
  for (let it = 0; it < 4; it++) {
    const cp = outline.map((p) => p.clone());
    outline.forEach((p, k) => p.copy(cp[(k + N - 1) % N]).add(cp[k].clone().multiplyScalar(2)).add(cp[(k + 1) % N]).multiplyScalar(0.25));
  }
  const c = outline.reduce((a, p) => a.add(p), new THREE.Vector2()).multiplyScalar(1 / N);
  const nrm = outline.map((p, k) => {
    const t = outline[(k + 1) % N].clone().sub(outline[(k + N - 1) % N]);
    const o = new THREE.Vector2(t.y, -t.x).normalize();
    return o.dot(p.clone().sub(c)) < 0 ? o.negate() : o;
  });
  const ring = (dy, grow) => outline.map((p, k) => new THREE.Vector3(p.x + nrm[k].x * grow, minY + dy, p.y + nrm[k].y * grow));
  // top lip hidden inside the boot, welt, tread edge, bevelled bottom
  const rings = [ring(0.008, -0.006), ring(0.0015, 0.0005), ring(0.0, 0.0028), ring(-0.004, 0.0028), ring(-SOLE + 0.0025, 0.0022), ring(-SOLE, -0.0003)];
  const pos = [], idx = [], uv = [];
  rings.forEach((R, ri) => R.forEach((p, k) => (pos.push(p.x, p.y, p.z), uv.push(k / N, ri / (rings.length - 1)))));
  for (let ri = 0; ri < rings.length - 1; ri++)
    for (let k = 0; k < N; k++) {
      const a = ri * N + k, b = ri * N + ((k + 1) % N), cc = a + N, d = b + N;
      idx.push(a, cc, b, b, cc, d);
    }
  const capBottom = pos.length / 3;
  pos.push(c.x, minY - SOLE, c.y);
  uv.push(0.5, 1);
  const last = (rings.length - 1) * N;
  for (let k = 0; k < N; k++) idx.push(last + k, capBottom, last + ((k + 1) % N));
  // consistent outward winding
  const P = (i) => new THREE.Vector3().fromArray(pos, i * 3);
  const w0 = 2 * N * 6; // first triangle of the vertical welt wall
  const fn = P(idx[w0 + 1]).sub(P(idx[w0])).cross(P(idx[w0 + 2]).sub(P(idx[w0])));
  if (fn.dot(P(idx[w0]).sub(new THREE.Vector3(c.x, minY, c.y)).setY(0)) < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  // weights: forefoot (ahead of the ball joint) bends with the ball bone
  const ball = rig.byName.get(`ball_${side}`), foot = rig.byName.get(`foot_${side}`);
  const vcount = pos.length / 3;
  const joints = new Uint16Array(vcount * 4), weights = new Float32Array(vcount * 4);
  for (let i = 0; i < vcount; i++) {
    const z = pos[i * 3 + 2];
    const t = THREE.MathUtils.smoothstep(z, ball.head.z - 0.025, ball.head.z + 0.015);
    joints[i * 4] = foot.index; weights[i * 4] = 1 - t;
    joints[i * 4 + 1] = ball.index; weights[i * 4 + 1] = t;
  }
  return { positions: Float32Array.from(pos), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx), joints, weights, bottomY: minY - SOLE };
}

function hull2(pts) {
  const s = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const p of s) {
    while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop();
    lo.push(p);
  }
  for (const p of s.reverse()) {
    while (up.length >= 2 && cross(up.at(-2), up.at(-1), p) <= 0) up.pop();
    up.push(p);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Leather belt band following the trouser waistband, with a buckle and a hip pouch. */
function buildBelt(pants, rig) {
  // top boundary loop of the trousers (the highest loop)
  const loops = pants.shell.loops.map((L) => ({ L, y: L.reduce((s, v) => s + pants.shell.pos[v * 3 + 1], 0) / L.length }));
  const top = loops.sort((a, b) => b.y - a.y)[0].L;
  const P = (v) => new THREE.Vector3().fromArray(pants.shell.pos, v * 3);
  // resample the loop evenly
  const pts = top.map(P);
  const cen = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  const N = 96;
  const ring = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    let best = pts[0], bd = -Infinity;
    for (const p of pts) {
      const d = p.clone().sub(cen).setY(0).normalize().dot(dir);
      if (d > bd) (bd = d), (best = p);
    }
    ring.push(best.clone());
  }
  // smooth heights and radii
  for (let it = 0; it < 6; it++) {
    const copy = ring.map((p) => p.clone());
    ring.forEach((p, k) => p.copy(copy[(k + N - 1) % N]).add(copy[k].clone().multiplyScalar(2)).add(copy[(k + 1) % N]).multiplyScalar(0.25));
  }
  const H = 0.034, T = 0.0042, drop = 0.006;
  const pos = [], idx = [], uv = [], nrm = [];
  const layers = [[0, 0.0015], [0, T], [-H, T], [-H, 0.0015]]; // [dy, outward]
  ring.forEach((p, k) => {
    const out = p.clone().sub(cen).setY(0).normalize();
    for (const [dy, o] of layers) {
      const q = p.clone().addScaledVector(out, o + 0.0012).add(new THREE.Vector3(0, dy + 0.004 - drop, 0));
      pos.push(q.x, q.y, q.z);
      uv.push(k / N, dy === 0 ? 0 : 1);
      nrm.push(out.x, out.y, out.z);
    }
  });
  for (let k = 0; k < N; k++)
    for (let j = 0; j < 4; j++) {
      const a = k * 4 + j, b = ((k + 1) % N) * 4 + j, c = k * 4 + ((j + 1) % 4), d = ((k + 1) % N) * 4 + ((j + 1) % 4);
      idx.push(a, b, c, c, b, d);
    }
  // buckle: frame at the front centre
  const front = ring.reduce((a, p) => (p.z > a.z ? p : a));
  const buckle = box(new THREE.Vector3(front.x, front.y - H / 2 + 0.004 - drop, front.z + 0.007), new THREE.Vector3(0.05, 0.042, 0.006));
  // pouch on the right hip, slightly behind the side
  const hipR = ring.reduce((a, p) => {
    const ang = Math.atan2(p.x - cen.x, p.z - cen.z);
    return Math.abs(ang - -2.0) < Math.abs(Math.atan2(a.x - cen.x, a.z - cen.z) - -2.0) ? p : a;
  });
  const outR = hipR.clone().sub(cen).setY(0).normalize();
  const pouchCenter = hipR.clone().addScaledVector(outR, 0.028).add(new THREE.Vector3(0, -0.055 - drop, 0));
  const pouch = roundedBox(pouchCenter, new THREE.Vector3(0.11, 0.12, 0.045), outR);
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx), buckle, pouch, pouchAnchor: hipR.clone().addScaledVector(outR, 0.01).add(new THREE.Vector3(0, -drop, 0)), center: cen };
}

function mergeParts(parts, name) {
  const pos = [], uv = [], idx = [], layer = [], joints = [], weights = [];
  for (const p of parts) {
    const base = pos.length / 3;
    pos.push(...p.positions); uv.push(...p.uvs); layer.push(...p.layer); joints.push(...p.joints); weights.push(...p.weights);
    idx.push(...Array.from(p.indices, (i) => i + base));
  }
  return { name, positions: Float32Array.from(pos), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx), layer: Uint8Array.from(layer), joints: Uint16Array.from(joints), weights: Float32Array.from(weights) };
}

function box(c, s) {
  const g = new THREE.BoxGeometry(s.x, s.y, s.z, 1, 1, 1).translate(c.x, c.y, c.z);
  return fromGeometry(g);
}

function roundedBox(c, s, outward) {
  // a soft pouch: subdivided box, corners pushed toward an ellipsoid
  const g = new THREE.BoxGeometry(s.x, s.y, s.z, 6, 6, 4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const n = new THREE.Vector3(v.x / (s.x / 2), v.y / (s.y / 2), v.z / (s.z / 2));
    const e = n.clone().normalize().multiply(new THREE.Vector3(s.x / 2, s.y / 2, s.z / 2));
    v.lerp(e, 0.35);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // orient: local +z = outward from the hip, then place
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
  g.applyQuaternion(q).translate(c.x, c.y, c.z);
  g.computeVertexNormals();
  return fromGeometry(g);
}

function fromGeometry(g) {
  const ng = g.index ? g : g;
  return {
    positions: Float32Array.from(ng.attributes.position.array),
    normals: Float32Array.from(ng.attributes.normal.array),
    uvs: Float32Array.from(ng.attributes.uv.array),
    indices: Uint32Array.from(ng.index.array),
  };
}
