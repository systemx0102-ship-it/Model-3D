// Anatomical landmarks for the skin bake, derived from the rig and the fitted eyes.
import * as THREE from 'three';
import { smoothstep } from './noise.mjs';

const arr = (v) => [v.x, v.y, v.z];

export function skinContext({ rig, eyes, world, bodyVerts, skinTone, lipTone }) {
  const B = (n) => rig.byName.get(n);
  const eyeMid = eyes.l.center.clone().add(eyes.r.center).multiplyScalar(0.5);
  const nearestVertex = (target, filter = () => true) => {
    let best = -1, bd = Infinity;
    for (const v of bodyVerts) {
      if (!filter(v)) continue;
      const d = (world[v * 3] - target.x) ** 2 + (world[v * 3 + 1] - target.y) ** 2 + (world[v * 3 + 2] - target.z) ** 2;
      if (d < bd) (bd = d), (best = v);
    }
    return new THREE.Vector3(world[best * 3], world[best * 3 + 1], world[best * 3 + 2]);
  };

  const hands = [], nails = [], knuckles = [], forearms = [], feet = [], joints = [];
  for (const s of ['l', 'r']) {
    const hand = B(`hand_${s}`);
    const iM = B(`index_metacarpal_${s}`).head, pM = B(`pinky_metacarpal_${s}`).head, m1 = B(`middle_01_${s}`).head;
    let palmar = new THREE.Vector3().subVectors(pM, iM).cross(new THREE.Vector3().subVectors(m1, iM)).normalize();
    const thumbTip = B(`thumb_03_${s}`).tail;
    const center = hand.head.clone().lerp(m1, 0.55);
    if (palmar.dot(new THREE.Vector3().subVectors(thumbTip, center)) < 0) palmar.negate();
    hands.push({ center: arr(center), radius2: 0.095 ** 2, palmar: arr(palmar) });
    forearms.push({ a: B(`lowerarm_${s}`).head, b: hand.head, inner: palmar.clone() });

    for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      const d = B(`${f}_03_${s}`);
      const Y = new THREE.Vector3().subVectors(d.tail, d.head);
      const len = Y.length();
      Y.normalize();
      let dorsal;
      if (f === 'thumb') {
        const away = new THREE.Vector3().subVectors(d.head, B(`index_01_${s}`).head);
        away.addScaledVector(Y, -away.dot(Y)).normalize();
        dorsal = palmar.clone().multiplyScalar(-0.55).add(away.multiplyScalar(0.85));
      } else dorsal = palmar.clone().negate();
      dorsal.addScaledVector(Y, -dorsal.dot(Y)).normalize();
      const X = new THREE.Vector3().crossVectors(Y, dorsal).normalize();
      nails.push({ head: arr(d.head), Y: arr(Y), X: arr(X), Z: arr(dorsal), len: len * 1.15, start: 0.3, end: 1.0, halfAngle: 0.95, maxR: 0.014, toe: false });
      const segs = f === 'thumb' ? ['02', '03'] : ['01', '02', '03'];
      for (const seg of segs) {
        const b = B(`${f}_${seg}_${s}`);
        const ax = new THREE.Vector3().subVectors(b.tail, b.head).normalize();
        knuckles.push({ pos: arr(b.head), axis: arr(ax), dorsal: arr(dorsal), len: seg === '01' ? 0.007 : 0.0045, r2: 0.013 ** 2 });
      }
    }
    const foot = B(`foot_${s}`);
    feet.push({ center: arr(foot.head.clone().lerp(B(`ball_${s}`).head, 0.5)), radius2: 0.16 ** 2 });
    for (const t of ['bigtoe', 'indextoe', 'middletoe', 'ringtoe', 'littletoe']) {
      const d = B(`${t}_02_${s}`);
      const Y = new THREE.Vector3().subVectors(d.tail, d.head);
      const len = Y.length();
      Y.normalize();
      const dorsal = new THREE.Vector3(0, 1, 0).addScaledVector(Y, -Y.y).normalize();
      const X = new THREE.Vector3().crossVectors(Y, dorsal).normalize();
      nails.push({ head: arr(d.head), Y: arr(Y), X: arr(X), Z: arr(dorsal), len: len * 1.1, start: t === 'bigtoe' ? 0.25 : 0.35, end: 1.0, halfAngle: 0.9, maxR: t === 'bigtoe' ? 0.016 : 0.01, toe: true });
    }
    // elbow (back of the joint) and knee (front)
    const sh = B(`upperarm_${s}`).head, el = B(`lowerarm_${s}`).head, wr = hand.head;
    const back = new THREE.Vector3().subVectors(el, sh.clone().lerp(wr, 0.5)).normalize();
    joints.push({ pos: arr(el), side: arr(back), r2: 0.04 ** 2 });
    joints.push({ pos: arr(B(`calf_${s}`).head.clone().add(new THREE.Vector3(0, 0, 0.03))), side: [0, 0, 1], r2: 0.05 ** 2 });
  }
  const nipples = ['l', 'r'].map((s) => ({ pos: arr(nearestVertex(B(`breast_${s}`).tail, (v) => world[v * 3 + 2] > 0)) }));
  const eyeCtx = ['l', 'r'].map((s) => {
    const e = eyes[s];
    const sideSign = s === 'l' ? 1 : -1;
    let outer = null;
    for (const v of e.rings[1]) {
      const p = new THREE.Vector3(world[v * 3], world[v * 3 + 1], world[v * 3 + 2]);
      if (!outer || (p.x - e.center.x) * sideSign > (outer.x - e.center.x) * sideSign) outer = p;
    }
    return { center: arr(e.center), R: e.R, outer: arr(outer) };
  });
  // a handful of moles: identity marks, deliberately asymmetric
  const H = (x, y, z) => eyeMid.clone().add(new THREE.Vector3(x, y, z));
  const moles = [
    { pos: nearestVertex(H(0.031, -0.052, 0.07)), r: 0.0011, k: 0.55, raised: 0 },
    { pos: nearestVertex(H(-0.052, -0.13, -0.01)), r: 0.0014, k: 0.65, raised: 1 },
    { pos: nearestVertex(B('clavicle_l').tail.clone().add(new THREE.Vector3(-0.02, 0.025, 0.03))), r: 0.0012, k: 0.6, raised: 0 },
    { pos: nearestVertex(B('spine_04').head.clone().add(new THREE.Vector3(0.06, 0.02, -0.12))), r: 0.0016, k: 0.7, raised: 1 },
    { pos: nearestVertex(B('lowerarm_r').head.clone().lerp(B('hand_r').head, 0.4).add(new THREE.Vector3(0, 0.02, 0))), r: 0.0010, k: 0.5, raised: 0 },
  ].map((m) => ({ ...m, pos: arr(m.pos) }));

  const shoulderY = B('clavicle_l').head.y;
  const seg = new THREE.Line3();
  const tmp = new THREE.Vector3(), q = new THREE.Vector3();
  const veinMask = (P, N, isHead) => {
    const hx = P[0] - eyeMid.x, hy = P[1] - eyeMid.y, hz = P[2] - eyeMid.z;
    if (isHead) return 0.55 * smoothstep(0.048, 0.062, Math.abs(hx)) * smoothstep(-0.015, 0.005, hy) * smoothstep(0.055, 0.025, hy) * smoothstep(0.02, -0.02, hz);
    let m = 0;
    q.set(P[0], P[1], P[2]);
    for (const f of forearms) {
      seg.set(f.a, f.b);
      seg.closestPointToPoint(q, true, tmp);
      const d = tmp.distanceTo(q);
      if (d < 0.05) m = Math.max(m, 0.85 * smoothstep(0.1, 0.6, N[0] * f.inner.x + N[1] * f.inner.y + N[2] * f.inner.z));
    }
    for (const h of hands) {
      const dx = P[0] - h.center[0], dy = P[1] - h.center[1], dz = P[2] - h.center[2];
      if (dx * dx + dy * dy + dz * dz < h.radius2 * 0.6) m = Math.max(m, 0.7 * smoothstep(0.2, 0.6, -(N[0] * h.palmar[0] + N[1] * h.palmar[1] + N[2] * h.palmar[2])));
    }
    if (P[1] < 0.12) m = Math.max(m, 0.5 * smoothstep(0.4, 0.8, N[1]));
    if (P[2] > 0 && Math.abs(P[0]) < 0.13 && P[1] > shoulderY - 0.16 && P[1] < shoulderY - 0.03) m = Math.max(m, 0.22);
    return m;
  };
  const freckleDensity = (P, N, isHead, cheek, nose) => {
    if (isHead) {
      const hy = P[1] - eyeMid.y;
      return 0.32 * cheek * smoothstep(-0.045, -0.01, hy) + 0.5 * nose * smoothstep(-0.03, -0.005, hy) * smoothstep(0.015, -0.0, hy) + 0.04;
    }
    let d = 0.015;
    if (P[1] > shoulderY - 0.22 && P[1] < shoulderY + 0.06) d = Math.max(d, 0.16 * smoothstep(shoulderY - 0.22, shoulderY - 0.06, P[1]));
    for (const f of forearms) {
      seg.set(f.a, f.b);
      q.set(P[0], P[1], P[2]);
      seg.closestPointToPoint(q, true, tmp);
      if (tmp.distanceTo(q) < 0.05) d = Math.max(d, 0.09 * smoothstep(0.0, 0.5, -(N[0] * f.inner.x + N[1] * f.inner.y + N[2] * f.inner.z)));
    }
    return d;
  };

  return {
    skinTone, lipTone,
    eyeMid: arr(eyeMid), headUp: [0, 1, 0], headRight: [1, 0, 0],
    eyes: eyeCtx, hands, feet, nails, knuckles, joints, nipples, moles,
    palmCreases: [], veinMask, freckleDensity,
  };
}
