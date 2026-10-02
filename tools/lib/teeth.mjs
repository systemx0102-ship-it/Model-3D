// Procedural dentition: 14 crowns per jaw placed along a dental arch fitted to the MakeHuman
// teeth helpers, plus scalloped gingiva. Dimensions follow average adult female odontometry.
import * as THREE from 'three';

// [name, mesiodistal width mm, crown height mm, labio-lingual thickness mm, type]
const UPPER = [
  ['central_incisor', 8.4, 10.0, 7.0, 'incisor'],
  ['lateral_incisor', 6.4, 8.6, 6.0, 'incisor'],
  ['canine', 7.5, 9.6, 7.8, 'canine'],
  ['premolar_1', 6.9, 8.2, 9.0, 'premolar'],
  ['premolar_2', 6.5, 7.6, 8.8, 'premolar'],
  ['molar_1', 10.0, 7.2, 11.0, 'molar'],
  ['molar_2', 9.0, 6.8, 10.6, 'molar'],
];
const LOWER = [
  ['central_incisor', 5.2, 8.8, 5.8, 'incisor'],
  ['lateral_incisor', 5.8, 9.2, 6.1, 'incisor'],
  ['canine', 6.8, 10.2, 7.4, 'canine'],
  ['premolar_1', 7.0, 8.0, 7.6, 'premolar'],
  ['premolar_2', 7.1, 7.8, 8.1, 'premolar'],
  ['molar_1', 11.0, 7.4, 10.3, 'molar'],
  ['molar_2', 10.4, 7.0, 10.0, 'molar'],
];

/** Arch curve z(x) = front - k*x^2 (head space), with arc-length sampling helpers. */
function arch(front, k) {
  const z = (x) => front - k * x * x;
  const pts = [];
  for (let x = 0; x <= 0.045; x += 0.0002) pts.push([x, z(x)]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = (s) => {
    let i = len.findIndex((l) => l >= s);
    if (i <= 0) i = 1;
    const t = (s - len[i - 1]) / (len[i] - len[i - 1]);
    const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
    const tan = new THREE.Vector2(1, -2 * k * x).normalize();
    return { x, z: z(x), tangent: tan };
  };
  return { at };
}

function toothMesh(spec, jaw, place, rng) {
  const [, wmm, hmm, dmm, type] = spec;
  const w = wmm / 1000, h = hmm / 1000, d = dmm / 1000;
  const rings = 14, segs = 18;
  const pos = [], nrm = [], uv = [], idx = [];
  const rootExt = 0.003; // crown continues 3 mm under the gum
  for (let i = 0; i <= rings; i++) {
    const v = i / rings; // 0 = deep in gum, 1 = biting edge
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      let cx = Math.cos(a), cz = Math.sin(a);
      // superellipse cross-section: boxier for molars
      const e = type === 'molar' ? 0.55 : type === 'premolar' ? 0.7 : 0.85;
      cx = Math.sign(cx) * Math.abs(cx) ** e;
      cz = Math.sign(cz) * Math.abs(cz) ** e;
      let hw = w / 2, hd = d / 2;
      const edge = Math.max(0, (v - 0.35) / 0.65);
      if (type === 'incisor') hd *= 1 - 0.78 * edge * edge; // thin incisal edge
      if (type === 'canine') (hw *= 1 - 0.45 * edge ** 2), (hd *= 1 - 0.35 * edge ** 2);
      hw *= 0.86 + 0.14 * Math.sin(Math.min(1, v * 1.4) * Math.PI * 0.5); // cervical constriction
      hd *= 0.88 + 0.12 * Math.sin(Math.min(1, v * 1.4) * Math.PI * 0.5);
      let y = -rootExt + v * (h + rootExt);
      // occlusal anatomy: cusp tips on back teeth, rounded incisal corners, pointed canine
      const r2 = cx * cx + cz * cz;
      if (v === 1) {
        if (type === 'molar' || type === 'premolar') y -= 0.0012 * (1 - Math.abs(Math.cos(a * 2)));
        if (type === 'canine') y -= 0.0018 * Math.abs(cx);
        if (type === 'incisor') y -= 0.0004 * cx * cx;
        hw *= 0.97; hd *= 0.97;
      }
      if (i === rings) (hw *= 0.6), (hd *= 0.6), (y -= type === 'molar' ? 0.0006 : 0.0002);
      // labial convexity (bulge toward +z outward side)
      const bulge = cz > 0 ? 1 + 0.06 * cz * Math.sin(v * Math.PI) : 1;
      // local frame: biting edge at y = 0, crown/neck toward -y
      pos.push(cx * hw, y - h + jitter(rng) * 0.00004, cz * hd * bulge);
      uv.push(j / segs, v);
      void r2;
    }
  }
  // caps: pole at the biting edge
  const row = segs + 1;
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      const a = i * row + j, b = a + 1, c = a + row, dd = c + 1;
      idx.push(a, b, c, b, dd, c);
    }
  const capCenter = pos.length / 3;
  const top = rings * row;
  let cxs = 0, cys = 0, czs = 0;
  for (let j = 0; j < segs; j++) (cxs += pos[(top + j) * 3]), (cys += pos[(top + j) * 3 + 1]), (czs += pos[(top + j) * 3 + 2]);
  pos.push(cxs / segs, cys / segs + (type === 'molar' ? 0.0005 : 0.0002), czs / segs);
  uv.push(0.5, 1);
  for (let j = 0; j < segs; j++) idx.push(top + j, top + j + 1, capCenter);

  // local -> head space: x along arch tangent, z outward (labial), y vertical (flip for upper)
  const out = new Float32Array(pos.length);
  const m = place;
  const v3 = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) {
    v3.set(pos[i], jaw === 'upper' ? -pos[i + 1] : pos[i + 1], pos[i + 2]).applyMatrix4(m);
    out.set([v3.x, v3.y, v3.z], i);
  }
  orientClosed(out, idx);
  return { positions: out, uvs: Float32Array.from(uv), indices: idx };
}

const jitter = (rng) => rng() * 2 - 1;

/** Flips winding of a closed mesh so the enclosed signed volume is positive (normals outward). */
export function orientClosed(pos, idx) {
  let cx = 0, cy = 0, cz = 0;
  const n = pos.length / 3;
  for (let i = 0; i < pos.length; i += 3) (cx += pos[i] / n), (cy += pos[i + 1] / n), (cz += pos[i + 2] / n);
  let vol = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    a.set(pos[idx[i] * 3] - cx, pos[idx[i] * 3 + 1] - cy, pos[idx[i] * 3 + 2] - cz);
    b.set(pos[idx[i + 1] * 3] - cx, pos[idx[i + 1] * 3 + 1] - cy, pos[idx[i + 1] * 3 + 2] - cz);
    c.set(pos[idx[i + 2] * 3] - cx, pos[idx[i + 2] * 3 + 1] - cy, pos[idx[i + 2] * 3 + 2] - cz);
    vol += a.dot(b.cross(c));
  }
  if (vol < 0) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
}

/**
 * @param upperPts/lowerPts  helper vertex positions (world, metres)
 * @returns {upper: mesh, lower: mesh, gumUpper, gumLower} each {positions, normals, uvs, indices}
 */
export function buildDentition(upperPts, lowerPts, rng) {
  const stats = (P) => {
    const xs = P.map((p) => p.x), ys = P.map((p) => p.y), zs = P.map((p) => p.z);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  };
  const U = stats(upperPts), L = stats(lowerPts);
  const occY = (U.minY + L.maxY) / 2;
  const frontU = U.maxZ - 0.0035; // labial surface sits ~3.5 mm inside the helper envelope
  const frontL = frontU - 0.0024; // overjet
  const halfW = 0.0265;
  const depth = 0.04;
  const kU = depth / (halfW * halfW) * 0.55;
  const arches = { upper: arch(frontU, kU), lower: arch(frontL, kU * 1.08) };

  const result = {};
  for (const jaw of ['upper', 'lower']) {
    const specs = jaw === 'upper' ? UPPER : LOWER;
    const meshes = [];
    const centers = [];
    for (const side of [1, -1]) {
      let s = 0.0003;
      for (const spec of specs) {
        const w = spec[1] / 1000;
        const c = arches[jaw].at(s + w / 2);
        s += w + 0.0001;
        const outward = new THREE.Vector3(side * -c.tangent.y, 0, c.tangent.x).normalize(); // perpendicular to arch, labial
        const tangent = new THREE.Vector3(side * c.tangent.x, 0, c.tangent.y).normalize();
        const center = new THREE.Vector3(side * c.x, occY, c.z).addScaledVector(outward, -(spec[3] / 2000));
        const yOff = jaw === 'upper' ? (spec[4] === 'incisor' ? -0.0016 : spec[4] === 'canine' ? -0.0009 : 0) : 0;
        center.y += yOff + (jaw === 'upper' ? 0.0002 : -0.0002);
        // slight labial crown tip for incisors
        const tilt = spec[4] === 'incisor' ? (jaw === 'upper' ? 0.2 : -0.12) : 0.04;
        const basis = new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3(0, 1, 0), outward);
        const rot = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), tilt);
        const place = new THREE.Matrix4().setPosition(center).multiply(basis).multiply(rot);
        meshes.push(toothMesh(spec, jaw, place, rng));
        centers.push({ center, outward, tangent, w, h: spec[2] / 1000, d: spec[3] / 1000, type: spec[4] });
      }
    }
    result[jaw] = merge(meshes);
    result[`gum_${jaw}`] = gum(centers, jaw, occY);
  }
  return result;
}

function merge(meshes) {
  const pos = [], uv = [], idx = [];
  for (const m of meshes) {
    const base = pos.length / 3;
    pos.push(...m.positions);
    uv.push(...m.uvs);
    idx.push(...m.indices.map((i) => i + base));
  }
  return { positions: Float32Array.from(pos), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

/** Gingiva: inverted-U band following the arch with papillae between teeth. */
function gum(centers, jaw, occY) {
  const sgn = jaw === 'upper' ? 1 : -1;
  // order centers along the arch from right molar to left molar
  const ordered = [...centers].sort((a, b) => Math.atan2(a.center.x, a.center.z) - Math.atan2(b.center.x, b.center.z));
  const samples = [];
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    for (let k = 0; k < 6; k++) {
      const f = k / 6; // across this tooth
      const n = ordered[Math.min(i + 1, ordered.length - 1)];
      const p = c.center.clone().lerp(n.center, f * (i + 1 < ordered.length ? 1 : 0));
      const out = c.outward.clone().lerp(n.outward, f).normalize();
      const h = c.h + (n.h - c.h) * f;
      const d = c.d + (n.d - c.d) * f;
      // gum line: high over crown centre (zenith), low between teeth (papilla)
      const papilla = Math.cos(f * Math.PI * 2) * 0.5 + 0.5; // 1 at tooth center, 0 between
      const line = occY + sgn * (h * (0.86 - 0.12 * (1 - papilla)) + (jaw === 'upper' && c.type === 'incisor' ? -0.0016 : 0));
      samples.push({ p, out, d, line });
    }
  }
  const pos = [], uv = [], idx = [];
  const prof = 9;
  samples.forEach((s, i) => {
    for (let k = 0; k <= prof; k++) {
      const a = (k / prof) * Math.PI; // labial (0) -> over the top -> lingual (pi)
      const half = s.d / 2 + 0.0011;
      const off = Math.cos(a) * half;
      const lift = Math.sin(a) * 0.0035;
      const y = s.line + sgn * (lift + (k === 0 || k === prof ? 0 : 0.0012)) - sgn * 0.0002 * (k === 0 ? 1 : 0);
      const p = s.p.clone().addScaledVector(s.out, off);
      pos.push(p.x, y, p.z);
      uv.push(k / prof, i / samples.length);
    }
    if (i > 0) {
      const a = (i - 1) * (prof + 1), b = i * (prof + 1);
      for (let k = 0; k < prof; k++) {
        if (jaw === 'upper') idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
        else idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
      }
    }
  });
  return { positions: Float32Array.from(pos), uvs: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}
