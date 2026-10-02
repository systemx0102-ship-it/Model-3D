// Facial blendshapes: the CC0 MakeHuman face pose units (bone poses authored on the 163-bone
// MH face rig) are evaluated on *this* character's mesh with linear-blend skinning and baked
// into per-vertex deltas, then combined into the ARKit 52 set (plus a few runtime extras).
import path from 'node:path';
import fs from 'node:fs';
import * as THREE from 'three';
import { readBvh } from './bvh.mjs';
import { loadTarget } from './targets.mjs';

// BVH files are Blender Z-up, -Y forward. Mesh is Y-up, +Z forward: (x, y, z) -> (x, z, -y).
const C = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
const Cinv = C.clone().invert();

export function loadPoseUnits(mhDir) {
  const bvh = readBvh(path.join(mhDir, 'poseunits/face-poseunits.bvh'));
  const names = JSON.parse(fs.readFileSync(path.join(mhDir, 'poseunits/face-poseunits.json'), 'utf8')).framemapping;
  const units = new Map();
  names.forEach((unit, f) => {
    const row = bvh.frames[f];
    let k = 0;
    const global = [];
    const deltas = new Map();
    for (const j of bvh.joints) {
      const q = new THREE.Quaternion();
      for (const ch of j.channels) {
        const v = row[k++];
        if (!ch.endsWith('rotation')) continue;
        const axis = ch[0] === 'X' ? new THREE.Vector3(1, 0, 0) : ch[0] === 'Y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(v)));
      }
      const g = j.parent >= 0 ? global[j.parent].clone().multiply(q) : q;
      global.push(g);
      const m = new THREE.Matrix4().makeRotationFromQuaternion(g);
      const meshSpace = new THREE.Matrix4().multiplyMatrices(C, m).multiply(Cinv);
      const dq = new THREE.Quaternion().setFromRotationMatrix(meshSpace);
      if (Math.abs(dq.w) < 0.999999) deltas.set(j.name, dq);
    }
    units.set(unit, deltas);
  });
  return units;
}

/**
 * Linear-blend skinning of every MH vertex for one pose unit. `mhBones` are rest heads in the
 * mesh frame; world deltas rotate about each joint head and propagate translation down the chain.
 */
export function bakeUnit(restPositions, mhBones, skel, mhWeights, deltas) {
  const posedHead = new Map();
  const worldDelta = new Map();
  const order = Object.keys(skel.bones);
  const resolve = (name) => {
    if (worldDelta.has(name)) return;
    const b = mhBones[name];
    const parent = b.parent;
    let dParent = new THREE.Quaternion();
    let hParent = null;
    if (parent) {
      resolve(parent);
      dParent = worldDelta.get(parent);
      hParent = posedHead.get(parent);
    }
    const h = parent
      ? new THREE.Vector3().subVectors(b.head, mhBones[parent].head).applyQuaternion(dParent).add(hParent)
      : b.head.clone();
    posedHead.set(name, h);
    // deltas hold the BVH *global* rotation of every joint, so absence means identity
    worldDelta.set(name, deltas.get(name)?.clone() ?? new THREE.Quaternion());
  };
  for (const n of order) resolve(n);

  const out = new Float32Array(restPositions.length);
  const v = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const touched = new Float32Array(restPositions.length / 3);
  for (const [bone, list] of Object.entries(mhWeights)) {
    const d = worldDelta.get(bone);
    const h0 = mhBones[bone].head;
    const h1 = posedHead.get(bone);
    const isIdentity = Math.abs(d.w) > 0.9999999 && h0.distanceToSquared(h1) < 1e-14;
    for (const [vi, w] of list) {
      v.fromArray(restPositions, vi * 3);
      if (isIdentity) tmp.copy(v);
      else tmp.subVectors(v, h0).applyQuaternion(d).add(h1);
      out[vi * 3] += (tmp.x - v.x) * w;
      out[vi * 3 + 1] += (tmp.y - v.y) * w;
      out[vi * 3 + 2] += (tmp.z - v.z) * w;
      touched[vi] += w;
    }
  }
  return { delta: out, worldDelta, posedHead };
}

// ARKit 52 (subject's left = +X) as weighted sums of MH units / expression targets.
// side: 'L' | 'R' masks a symmetric source to one half of the face.
const U = (unit, w = 1, side) => ({ unit, w, side });
const T = (target, w = 1, side) => ({ target, w, side });
export const ARKIT = {
  browDownLeft: [U('LeftBrowDown')],
  browDownRight: [U('RightBrowDown')],
  browInnerUp: [U('LeftInnerBrowUp'), U('RightInnerBrowUp')],
  browOuterUpLeft: [U('LeftOuterBrowUp')],
  browOuterUpRight: [U('RightOuterBrowUp')],
  cheekPuff: [U('CheeksPump')],
  cheekSquintLeft: [U('LeftCheekUp')],
  cheekSquintRight: [U('RightCheekUp')],
  eyeBlinkLeft: [U('LeftUpperLidClosed'), U('LeftLowerLidUp', 0.15)],
  eyeBlinkRight: [U('RightUpperLidClosed'), U('RightLowerLidUp', 0.15)],
  eyeLookDownLeft: [U('LeftEyeDown')],
  eyeLookDownRight: [U('RightEyeDown')],
  eyeLookInLeft: [U('LeftEyeturnRight')],
  eyeLookInRight: [U('RightEyeturnLeft')],
  eyeLookOutLeft: [U('LeftEyeturnLeft')],
  eyeLookOutRight: [U('RightEyeturnRight')],
  eyeLookUpLeft: [U('LeftEyeUp')],
  eyeLookUpRight: [U('RightEyeUp')],
  eyeSquintLeft: [U('LeftLowerLidUp')],
  eyeSquintRight: [U('RightLowerLidUp')],
  eyeWideLeft: [U('LeftUpperLidOpen')],
  eyeWideRight: [U('RightUpperLidOpen')],
  jawForward: [U('ChinForward')],
  jawLeft: [U('ChinLeft')],
  jawOpen: [U('JawDrop')],
  jawRight: [U('ChinRight')],
  mouthClose: [U('lowerLipUp', 0.7), U('UpperLipForward', 0.2)],
  mouthDimpleLeft: [U('MouthLeftPullSide', 0.6)],
  mouthDimpleRight: [U('MouthRightPullSide', 0.6)],
  mouthFrownLeft: [U('MouthLeftPullDown')],
  mouthFrownRight: [U('MouthRightPullDown')],
  mouthFunnel: [U('LipsKiss', 0.55), U('lowerLipForward', 0.45), U('UpperLipForward', 0.45), U('JawDrop', 0.12)],
  mouthLeft: [U('MouthMoveLeft')],
  mouthLowerDownLeft: [U('lowerLipDown', 1, 'L')],
  mouthLowerDownRight: [U('lowerLipDown', 1, 'R')],
  mouthPressLeft: [T('expression/units/caucasian/mouth-compression', 0.8, 'L')],
  mouthPressRight: [T('expression/units/caucasian/mouth-compression', 0.8, 'R')],
  mouthPucker: [U('LipsKiss')],
  mouthRight: [U('MouthMoveRight')],
  mouthRollLower: [U('lowerLipBackward')],
  mouthRollUpper: [U('UpperLipBackward')],
  mouthShrugLower: [U('lowerLipUp')],
  mouthShrugUpper: [U('UpperLipForward', 0.5), U('UpperLipUp', 0.3)],
  mouthSmileLeft: [U('MouthLeftPullUp')],
  mouthSmileRight: [U('MouthRightPullUp')],
  mouthStretchLeft: [U('MouthLeftPlatysma')],
  mouthStretchRight: [U('MouthRightPlatysma')],
  mouthUpperUpLeft: [U('UpperLipUp', 1, 'L')],
  mouthUpperUpRight: [U('UpperLipUp', 1, 'R')],
  noseSneerLeft: [U('NoseWrinkler', 1, 'L')],
  noseSneerRight: [U('NoseWrinkler', 1, 'R')],
  tongueOut: [U('TongueOut')],
};

// Extra runtime shapes (not ARKit) used by the idle/breathing/swallow systems.
export const EXTRAS = {
  noseFlare: [T('nose/nose-flaring-incr', 0.7)],
  breatheChest: [T('measure/measure-underbust-circ-incr', 0.35), T('measure/measure-bust-circ-incr', 0.15)],
  breatheBelly: [T('stomach/stomach-pregnant-incr', 0.09)],
};

export function sideMask(x, side, width = 0.012) {
  if (!side) return 1;
  const t = Math.min(1, Math.max(0, (x / width + 1) / 2));
  const s = t * t * (3 - 2 * t);
  return side === 'L' ? s : 1 - s;
}

/** Bakes all shapes into dense deltas over the full MH vertex array (metres). */
export function bakeShapes({ mhDir, restPositions, mhBones, skel, mhWeights, unitScale, defs, rigid = {} }) {
  const units = loadPoseUnits(mhDir);
  const cache = new Map();
  const unitDelta = (name) => {
    if (!cache.has(name)) {
      const d = units.get(name);
      if (!d) throw new Error(`unknown pose unit ${name}`);
      cache.set(name, bakeUnit(restPositions, mhBones, skel, mhWeights, d));
    }
    return cache.get(name);
  };
  const out = {};
  const rigidOut = Object.fromEntries(Object.keys(rigid).map((k) => [k, {}]));
  const eyeRot = {};
  const p = new THREE.Vector3();
  for (const [shape, terms] of Object.entries(defs)) {
    const acc = new Float32Array(restPositions.length);
    const racc = Object.fromEntries(Object.entries(rigid).map(([k, r]) => [k, new Float32Array(r.points.length)]));
    const er = { l: new THREE.Quaternion(), r: new THREE.Quaternion() };
    for (const term of terms) {
      if (term.unit) {
        const baked = unitDelta(term.unit);
        const d = baked.delta;
        for (const [k, S] of [['l', 'L'], ['r', 'R']])
          er[k].premultiply(new THREE.Quaternion().slerp(baked.worldDelta.get(`eye.${S}`), term.w));
        // geometry rigidly attached to an MH bone (e.g. lower teeth on the jaw) follows that bone
        for (const [k, r] of Object.entries(rigid)) {
          const q = baked.worldDelta.get(r.bone), h0 = mhBones[r.bone].head, h1 = baked.posedHead.get(r.bone);
          for (let i = 0; i < r.points.length; i += 3) {
            const m = term.w * sideMask(r.points[i], term.side);
            p.fromArray(r.points, i).sub(h0).applyQuaternion(q).add(h1);
            racc[k][i] += (p.x - r.points[i]) * m; racc[k][i + 1] += (p.y - r.points[i + 1]) * m; racc[k][i + 2] += (p.z - r.points[i + 2]) * m;
          }
        }
        for (let i = 0; i < d.length; i += 3) {
          const m = term.w * sideMask(restPositions[i], term.side);
          if (!m) continue;
          acc[i] += d[i] * m; acc[i + 1] += d[i + 1] * m; acc[i + 2] += d[i + 2] * m;
        }
      } else {
        const t = loadTarget(path.join(mhDir, 'targets', `${term.target}.target`));
        for (let k = 0; k < t.idx.length; k++) {
          const i = t.idx[k] * 3;
          const m = term.w * unitScale * sideMask(restPositions[i], term.side);
          acc[i] += t.d[k * 3] * m; acc[i + 1] += t.d[k * 3 + 1] * m; acc[i + 2] += t.d[k * 3 + 2] * m;
        }
      }
    }
    out[shape] = acc;
    for (const k of Object.keys(rigid)) rigidOut[k][shape] = racc[k];
    eyeRot[shape] = er;
  }
  return { shapes: out, rigid: rigidOut, eyeRot };
}
