// Production skeleton derived from MakeHuman joint data, renamed/restructured to the
// Unreal Engine 5 Mannequin / MetaHuman body hierarchy so IK Rig + IK Retargeter chains map 1:1.
//
// Bone frames: local +Y runs along the bone (head -> tail); local +X is the primary hinge axis
// (elbow/knee/finger flexion) where one exists. All frames are orthonormal and right-handed.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const WORLD_X = V(1, 0, 0);
const WORLD_Z = V(0, 0, 1);

const SIDES = [
  ['l', 'L', 1],
  ['r', 'R', -1],
];

// MH bone(s) whose skin weights are inherited by each production bone.
export function weightMap() {
  const m = {
    root: 'pelvis', 'pelvis.L': 'pelvis', 'pelvis.R': 'pelvis',
    spine05: 'spine_01', spine04: 'spine_02', spine03: 'spine_03', spine02: 'spine_04', spine01: 'spine_05',
    neck01: 'neck_01', neck02: 'neck_02', neck03: 'neck_02', head: 'head',
  };
  const face = /^(jaw|special|levator|oris|risorius|orbicularis|oculi|temporalis|tongue)/;
  m.__face = face; // facial bones collapse into head; facial motion is shipped as blendshapes
  for (const [s, S] of SIDES) {
    Object.assign(m, {
      [`eye.${S}`]: `eye_${s}`,
      [`clavicle.${S}`]: `clavicle_${s}`, [`shoulder01.${S}`]: `clavicle_${s}`,
      [`upperarm01.${S}`]: `upperarm_${s}`, [`upperarm02.${S}`]: `upperarm_${s}`,
      [`lowerarm01.${S}`]: `lowerarm_${s}`, [`lowerarm02.${S}`]: `lowerarm_${s}`,
      [`wrist.${S}`]: `hand_${s}`,
      [`finger1-1.${S}`]: `thumb_01_${s}`, [`finger1-2.${S}`]: `thumb_02_${s}`, [`finger1-3.${S}`]: `thumb_03_${s}`,
      [`upperleg01.${S}`]: `thigh_${s}`, [`upperleg02.${S}`]: `thigh_${s}`,
      [`lowerleg01.${S}`]: `calf_${s}`, [`lowerleg02.${S}`]: `calf_${s}`,
      [`foot.${S}`]: `foot_${s}`,
      [`breast.${S}`]: `breast_${s}`,
    });
    ['index', 'middle', 'ring', 'pinky'].forEach((f, i) => {
      m[`metacarpal${i + 1}.${S}`] = `${f}_metacarpal_${s}`;
      for (let k = 1; k <= 3; k++) m[`finger${i + 2}-${k}.${S}`] = `${f}_0${k}_${s}`;
    });
    ['bigtoe', 'indextoe', 'middletoe', 'ringtoe', 'littletoe'].forEach((t, i) => {
      m[`toe${i + 1}-1.${S}`] = `${t}_01_${s}`;
      m[`toe${i + 1}-2.${S}`] = `${t}_02_${s}`;
      m[`toe${i + 1}-3.${S}`] = `${t}_02_${s}`;
    });
  }
  return m;
}

function frame(head, tail, xHint) {
  const y = new THREE.Vector3().subVectors(tail, head).normalize();
  const x = xHint.clone().addScaledVector(y, -xHint.dot(y));
  if (x.lengthSq() < 1e-8) x.copy(Math.abs(y.x) < 0.9 ? WORLD_X : WORLD_Z).addScaledVector(y, -y.x);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(head);
}

/**
 * @param mh   MH bones in final model space ({head, tail, planeNormal})
 * @returns    bones: [{name, parent, head, tail, world: Matrix4, role}]
 */
export function buildRig(mh, opts = {}) {
  const bones = [];
  const byName = new Map();
  const add = (name, parent, head, tail, xHint, role = 'deform') => {
    const b = { name, parent, head: head.clone(), tail: tail.clone(), world: frame(head, tail, xHint), role };
    bones.push(b);
    byName.set(name, b);
    return b;
  };
  const H = (n) => mh[n].head;
  const T = (n) => mh[n].tail;
  const lerp = (a, b, t) => a.clone().lerp(b, t);
  const centroid = (...pts) => pts.reduce((a, p) => a.add(p), V(0, 0, 0)).multiplyScalar(1 / pts.length);

  // Root sits on the ground plane under the character (UE convention), identity orientation.
  bones.push({ name: 'root', parent: null, head: V(0, 0, 0), tail: V(0, 0.1, 0), world: new THREE.Matrix4(), role: 'root' });
  byName.set('root', bones[0]);

  add('pelvis', 'root', H('root'), T('spine05'), WORLD_X);
  add('spine_01', 'pelvis', H('spine05'), T('spine05'), WORLD_X);
  add('spine_02', 'spine_01', H('spine04'), T('spine04'), WORLD_X);
  add('spine_03', 'spine_02', H('spine03'), T('spine03'), WORLD_X);
  add('spine_04', 'spine_03', H('spine02'), T('spine02'), WORLD_X);
  add('spine_05', 'spine_04', H('spine01'), T('spine01'), WORLD_X);
  add('neck_01', 'spine_05', H('neck01'), T('neck01'), WORLD_X);
  add('neck_02', 'neck_01', H('neck02'), T('neck03'), WORLD_X);
  add('head', 'neck_02', H('head'), T('head'), WORLD_X);

  for (const [s, S] of SIDES) {
    const eyeHead = opts.eyeCenter?.[s] ?? H(`eye.${S}`);
    const eyeTail = eyeHead.clone().add(new THREE.Vector3().subVectors(T(`eye.${S}`), H(`eye.${S}`)).setLength(0.02));
    add(`eye_${s}`, 'head', eyeHead, eyeTail, WORLD_X);
    add(`breast_${s}`, 'spine_04', lerp(H(`breast.${S}`), T(`breast.${S}`), 0.55), T(`breast.${S}`), WORLD_X);

    // Arm: hinge axis = normal of the shoulder/elbow/wrist plane (elbow flexion is +X rotation).
    const sh = H(`upperarm01.${S}`);
    const el = H(`lowerarm01.${S}`);
    const wr = H(`wrist.${S}`);
    const armN = new THREE.Vector3().subVectors(el, sh).cross(new THREE.Vector3().subVectors(wr, el)).normalize();
    add(`clavicle_${s}`, 'spine_05', H(`clavicle.${S}`), sh, WORLD_Z);
    add(`upperarm_${s}`, `clavicle_${s}`, sh, el, armN);
    add(`lowerarm_${s}`, `upperarm_${s}`, el, wr, armN);

    // Hand: hinge axis runs across the knuckles (index -> pinky), shared by the fingers.
    const kIndex = H(`finger2-1.${S}`);
    const kPinky = H(`finger5-1.${S}`);
    const across = new THREE.Vector3().subVectors(kIndex, kPinky).normalize().multiplyScalar(s === 'l' ? 1 : -1);
    const knuckleMid = centroid(kIndex.clone(), H(`finger3-1.${S}`).clone(), H(`finger4-1.${S}`).clone(), kPinky.clone());
    add(`hand_${s}`, `lowerarm_${s}`, wr, knuckleMid, across);
    const thumbN = mh[`finger1-2.${S}`].planeNormal ?? across;
    add(`thumb_01_${s}`, `hand_${s}`, H(`finger1-1.${S}`), T(`finger1-1.${S}`), thumbN);
    add(`thumb_02_${s}`, `thumb_01_${s}`, H(`finger1-2.${S}`), T(`finger1-2.${S}`), thumbN);
    add(`thumb_03_${s}`, `thumb_02_${s}`, H(`finger1-3.${S}`), T(`finger1-3.${S}`), thumbN);
    ['index', 'middle', 'ring', 'pinky'].forEach((f, i) => {
      add(`${f}_metacarpal_${s}`, `hand_${s}`, H(`metacarpal${i + 1}.${S}`), T(`metacarpal${i + 1}.${S}`), across);
      let parent = `${f}_metacarpal_${s}`;
      for (let k = 1; k <= 3; k++) {
        const n = `finger${i + 2}-${k}.${S}`;
        add(`${f}_0${k}_${s}`, parent, H(n), T(n), across);
        parent = `${f}_0${k}_${s}`;
      }
    });

    // Leg: hinge axis is world X for both sides (knee flexion is +X rotation).
    const hip = H(`upperleg01.${S}`);
    const knee = H(`lowerleg01.${S}`);
    const ankle = H(`foot.${S}`);
    const balls = [1, 2, 3, 4, 5].map((t) => H(`toe${t}-1.${S}`).clone());
    const ball = centroid(...balls);
    add(`thigh_${s}`, 'pelvis', hip, knee, WORLD_X);
    add(`calf_${s}`, `thigh_${s}`, knee, ankle, WORLD_X);
    add(`foot_${s}`, `calf_${s}`, ankle, ball, WORLD_X);
    const toeTip = centroid(...[1, 2, 3, 4, 5].map((t) => T(`toe${t}-${t === 1 ? 2 : 3}.${S}`).clone()));
    add(`ball_${s}`, `foot_${s}`, ball, V(ball.x, ball.y, Math.max(toeTip.z, ball.z + 0.01)), WORLD_X);
    ['bigtoe', 'indextoe', 'middletoe', 'ringtoe', 'littletoe'].forEach((t, i) => {
      const n1 = `toe${i + 1}-1.${S}`;
      const nLast = `toe${i + 1}-${i === 0 ? 2 : 3}.${S}`;
      add(`${t}_01_${s}`, `ball_${s}`, H(n1), T(n1), WORLD_X);
      add(`${t}_02_${s}`, `${t}_01_${s}`, H(`toe${i + 1}-2.${S}`), T(nLast), WORLD_X);
    });

    // Twist helpers (UE5 naming). Placed along the parent; they only roll about the parent's axis.
    const tw = (name, parent, a, b, t) => {
      const p = byName.get(parent);
      const hd = lerp(a, b, t);
      const m = p.world.clone().setPosition(hd);
      const bone = { name, parent, head: hd, tail: lerp(a, b, Math.min(1, t + 0.2)), world: m, role: 'twist' };
      bones.push(bone);
      byName.set(name, bone);
    };
    tw(`upperarm_twist_01_${s}`, `upperarm_${s}`, sh, el, 0.25);
    tw(`upperarm_twist_02_${s}`, `upperarm_${s}`, sh, el, 0.6);
    tw(`lowerarm_twist_01_${s}`, `lowerarm_${s}`, el, wr, 0.4);
    tw(`lowerarm_twist_02_${s}`, `lowerarm_${s}`, el, wr, 0.8);
    tw(`thigh_twist_01_${s}`, `thigh_${s}`, hip, knee, 0.25);
    tw(`thigh_twist_02_${s}`, `thigh_${s}`, hip, knee, 0.6);
    tw(`calf_twist_01_${s}`, `calf_${s}`, knee, ankle, 0.45);
    tw(`calf_twist_02_${s}`, `calf_${s}`, knee, ankle, 0.8);
  }

  // UE IK helper bones (unweighted): used by retargeting, foot locking and weapon/hand IK.
  const helper = (name, parent, src) => {
    const m = src ? byName.get(src).world.clone() : new THREE.Matrix4();
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    bones.push({ name, parent, head: pos, tail: pos.clone().add(V(0, 0.05, 0)), world: m, role: 'ik' });
    byName.set(name, bones.at(-1));
  };
  helper('ik_foot_root', 'root', null);
  helper('ik_foot_l', 'ik_foot_root', 'foot_l');
  helper('ik_foot_r', 'ik_foot_root', 'foot_r');
  helper('ik_hand_root', 'root', null);
  helper('ik_hand_gun', 'ik_hand_root', 'hand_r');
  helper('ik_hand_l', 'ik_hand_gun', 'hand_l');
  helper('ik_hand_r', 'ik_hand_gun', 'hand_r');

  // Sort parents-before-children, keep a stable, readable order.
  const ordered = [];
  const visit = (name) => {
    const b = byName.get(name);
    ordered.push(b);
    for (const c of bones) if (c.parent === name) visit(c.name);
  };
  visit('root');
  ordered.forEach((b, i) => (b.index = i));
  for (const b of ordered) b.parentIndex = b.parent ? byName.get(b.parent).index : -1;
  return { bones: ordered, byName };
}

/** Local bind transforms (parent^-1 * world) for every bone. */
export function localBind(rig) {
  return rig.bones.map((b) => {
    const parent = b.parent ? rig.byName.get(b.parent).world : new THREE.Matrix4();
    return new THREE.Matrix4().copy(parent).invert().multiply(b.world);
  });
}
