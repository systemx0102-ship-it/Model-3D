// Eyelashes and eyebrows as individual strands (exported as thin ribbons).
import * as THREE from 'three';
import { gauss } from './ribbons.mjs';

const lerp = THREE.MathUtils.lerp;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function splitLids(loop, center) {
  // canthi = extreme lateral/medial points of the margin loop
  const n = loop.length;
  let inner = 0, outer = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(loop[i].x) < Math.abs(loop[inner].x)) inner = i;
    if (Math.abs(loop[i].x) > Math.abs(loop[outer].x)) outer = i;
  }
  const walk = (from, to) => {
    const out = [];
    for (let i = from; ; i = (i + 1) % n) {
      out.push(loop[i]);
      if (i === to) break;
    }
    return out;
  };
  const a = walk(inner, outer), b = walk(outer, inner).reverse();
  const meanY = (arr) => arr.reduce((s, p) => s + p.y, 0) / arr.length;
  const [upper, lower] = meanY(a) > meanY(b) ? [a, b] : [b, a];
  const sampler = (arc) => {
    const len = [0];
    for (let i = 1; i < arc.length; i++) len.push(len[i - 1] + arc[i].distanceTo(arc[i - 1]));
    const L = len.at(-1);
    return (t) => {
      const s = t * L;
      let i = len.findIndex((l) => l >= s);
      if (i <= 0) i = 1;
      const f = (s - len[i - 1]) / (len[i] - len[i - 1] || 1);
      const p = arc[i - 1].clone().lerp(arc[i], f);
      const tan = new THREE.Vector3().subVectors(arc[i], arc[i - 1]).normalize();
      return { p, tan };
    };
  };
  void center;
  return { upper: sampler(upper), lower: sampler(lower) };
}

/**
 * @param loop    lid margin points (world) for one eye, @param frame eye frame (Matrix4, +Z gaze)
 */
export function eyelashes(loop, center, frame, R, rng, side) {
  const g = gauss(rng);
  const lids = splitLids(loop, center);
  const fwd = new THREE.Vector3().setFromMatrixColumn(frame, 2);
  const up = new THREE.Vector3().setFromMatrixColumn(frame, 1);
  const strands = [];
  const make = (lid, count, isUpper) => {
    // clumps of 3-5 lashes share a tip attractor
    let clumpTip = null, clumpLeft = 0;
    for (let k = 0; k < count; k++) {
      const t = isUpper ? 0.06 + 0.92 * Math.pow((k + rng() * 0.8) / count, 0.92) : 0.15 + 0.8 * ((k + rng()) / count);
      const { p, tan } = lid(Math.min(0.995, t));
      const radial = new THREE.Vector3().subVectors(p, center);
      radial.addScaledVector(fwd, -radial.dot(fwd)).normalize();
      const row = rng();
      const root = p.clone().addScaledVector(radial, 0.0004 + row * 0.0004).addScaledVector(fwd, 0.0003 - row * 0.0002);
      const bell = Math.sin(Math.PI * Math.pow(t, isUpper ? 0.85 : 1));
      const len = isUpper ? (0.0042 + 0.0042 * bell) * (1 + 0.12 * g()) : (0.0018 + 0.0022 * bell) * (1 + 0.18 * g());
      const lateral = new THREE.Vector3(side, 0, 0).multiplyScalar(smooth(0.6, 1, t) * 0.3);
      // lashes leave the lid nearly parallel to the gaze, then curl away from the eye
      const dir0 = fwd.clone().addScaledVector(radial, isUpper ? 0.22 : 0.35).add(lateral).normalize();
      const curlAxis = new THREE.Vector3().crossVectors(dir0, radial).normalize();
      const curl = (isUpper ? 1.15 : 0.55) * (1 + 0.15 * g()); // radians over full length
      const pts = [root.clone()];
      let d = dir0.clone();
      const seg = len / 6;
      for (let i = 1; i <= 6; i++) {
        d.applyAxisAngle(curlAxis, (curl / 6) * (0.6 + 0.8 * (i / 6)));
        pts.push(pts[i - 1].clone().addScaledVector(d, seg));
      }
      if (clumpLeft <= 0) {
        clumpLeft = 3 + Math.floor(rng() * 3);
        clumpTip = pts[6].clone();
      }
      clumpLeft--;
      for (let i = 2; i <= 6; i++) pts[i].lerp(clumpTip, 0.28 * Math.pow(i / 6, 2));
      strands.push({
        points: pts,
        width: (u) => lerp(0.00016, 0.00004, u),
        side: tan,
        normal: fwd,
        seed: rng(),
        root,
        kind: isUpper ? 'upper' : 'lower',
      });
    }
  };
  make(lids.upper, 105, true);
  make(lids.lower, 42, false);
  void up;
  void R;
  return strands;
}

/**
 * Eyebrows: hairs rooted on the brow ridge, combed by a direction field (medial hairs point up,
 * body hairs lateral with a herringbone convergence, tail hairs lateral-down), lying on the skin.
 * @param raycastSkin (origin, dir) -> {point, normal} | null
 */
export function eyebrows(eyeCenter, side, raycastSkin, rng) {
  const g = gauss(rng);
  const s = side; // +1 = character left
  const mm = 0.001;
  // centre line control points relative to the eye centre (frontal plane), x toward lateral
  const ctrl = [
    [-15.5, 11.0], [-8, 14.5], [2, 17.0], [9, 17.6], [16, 15.5], [23, 11.0],
  ].map(([x, y]) => new THREE.Vector2(x * mm, y * mm));
  const curve = new THREE.SplineCurve(ctrl);
  const thick = (u) => (u < 0.15 ? lerp(7.5, 9.0, u / 0.15) : u < 0.65 ? lerp(9.0, 6.5, (u - 0.15) / 0.5) : lerp(6.5, 2.0, (u - 0.65) / 0.35)) * mm;
  const strands = [];
  const N = 1150;
  for (let k = 0; k < N; k++) {
    const u = Math.pow(rng(), 0.92);
    const v = (rng() * 2 - 1) * (u < 0.1 ? 0.85 : 1);
    if (Math.abs(v) > 0.75 && rng() < 0.6) continue; // sparser at the edges
    const c = curve.getPoint(u);
    const tg = curve.getTangent(u);
    const nUp = new THREE.Vector2(-tg.y, tg.x);
    const q = c.clone().addScaledVector(nUp, (v * thick(u)) / 2 + g() * 0.0004);
    const origin = new THREE.Vector3(eyeCenter.x + s * q.x, eyeCenter.y + q.y, eyeCenter.z + 0.06);
    const hit = raycastSkin(origin, new THREE.Vector3(0, 0, -1));
    if (!hit) continue;
    const n = hit.normal;
    // growth direction in the frontal plane (x lateral, y up)
    let ang; // radians from lateral, CCW = up
    if (u < 0.12) ang = lerp(1.35, 1.0, u / 0.12);
    else if (u < 0.35) ang = lerp(1.0, 0.25, (u - 0.12) / 0.23);
    else if (u < 0.75) ang = 0.15 - 0.45 * v; // herringbone: top row points down, bottom up
    else ang = lerp(0.15 - 0.45 * v, -0.45, (u - 0.75) / 0.25);
    ang += g() * 0.08;
    const dir = new THREE.Vector3(s * Math.cos(ang), Math.sin(ang), 0);
    dir.addScaledVector(n, -dir.dot(n)).normalize();
    const len = (u < 0.12 ? 3.6 : u < 0.75 ? 5.6 : 4.6) * mm * (1 + 0.15 * g());
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const f = i / 4;
      const lift = Math.sin(f * Math.PI * 0.85) * 0.00035 + 0.00005;
      pts.push(hit.point.clone().addScaledVector(dir, len * f).addScaledVector(n, lift));
    }
    strands.push({
      points: pts,
      width: (t) => lerp(0.00013, 0.00004, t),
      side: new THREE.Vector3().crossVectors(n, dir).normalize(),
      normal: n,
      seed: rng(),
      root: hit.point.clone(),
      kind: 'brow',
    });
  }
  return strands;
}
