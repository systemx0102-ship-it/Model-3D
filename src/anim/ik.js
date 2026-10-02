// Inverse kinematics: analytic two-bone IK with exact hinge frames, soft reach limit, foot
// alignment to the ground, and a distributed look-at for spine/neck/head.
import * as THREE from 'three';
import { frameQuat } from './rig.js';

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();

/**
 * Two-bone IK in world space.
 * @param rig     Rig
 * @param chain   [upper, lower, end] bone names (e.g. thigh_l, calf_l, foot_l)
 * @param target  world position for the end bone's head (ankle / wrist)
 * @param pole    world direction the middle joint should point toward (knee forward, elbow back)
 * @param weight  0..1 blend with the current FK pose
 * @returns       achieved distance ratio (1 = reached)
 */
export function twoBoneIK(rig, chain, target, pole, weight = 1) {
  if (weight <= 0) return 1;
  const [U, L, E] = chain.map((n) => rig.bone(n));
  const a = rig.worldPos(chain[0], new THREE.Vector3());
  const L1 = U.userData.bindCSPos.distanceTo(L.userData.bindCSPos);
  const L2 = L.userData.bindCSPos.distanceTo(E.userData.bindCSPos);
  const toT = v1.subVectors(target, a);
  let D = toT.length();
  const dHat = toT.clone().divideScalar(D || 1);
  // soft reach: approach full extension asymptotically instead of snapping straight
  const maxR = L1 + L2;
  const soft = maxR * 0.97;
  if (D > soft) D = soft + (maxR - soft) * (1 - Math.exp(-(D - soft) / (maxR - soft)));
  D = Math.max(D, Math.abs(L1 - L2) + 1e-4);
  const cosA = THREE.MathUtils.clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const p = v2.copy(pole).addScaledVector(dHat, -pole.dot(dHat));
  if (p.lengthSq() < 1e-8) p.set(0, 0, 1).addScaledVector(dHat, -dHat.z);
  p.normalize();
  const knee = a.clone().addScaledVector(dHat, cosA * L1).addScaledVector(p, sinA * L1);
  const end = a.clone().addScaledVector(dHat, D);
  const hinge = v3.crossVectors(p, dHat).normalize();
  const qU = frameQuat(hinge, knee.clone().sub(a));
  const qL = frameQuat(hinge, end.clone().sub(knee));
  if (weight < 1) {
    qU.slerp(rig.worldQuat(chain[0]), 1 - weight);
  }
  rig.setWorldQuaternion(U, qU);
  U.updateMatrixWorld(true);
  if (weight < 1) qL.slerp(rig.worldQuat(chain[1]), 1 - weight);
  rig.setWorldQuaternion(L, qL);
  L.updateMatrixWorld(true);
  return D / Math.max(1e-6, toT.length());
}

/**
 * Orients a foot: forward along `forward` (horizontal facing), sole on the plane with normal `up`,
 * then pitched about the lateral axis by `pitch` (+ = toes down) around the ankle.
 */
export function alignFoot(rig, name, forward, up, pitch = 0, yawOffset = 0) {
  const b = rig.bone(name);
  const bindWorldFromCS = rig.object.quaternion; // CS -> world (yaw placement)
  // bind foot frame in world for an upright character facing `forward`
  const f = forward.clone().addScaledVector(up, -forward.dot(up)).normalize();
  if (yawOffset) f.applyAxisAngle(up, yawOffset);
  const side = new THREE.Vector3().crossVectors(up, f).normalize(); // character left (+X when facing +Z)
  // rotation taking the CS basis (X left, Y up, Z forward) to (side, up, f)
  const R = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, f));
  const pitchQ = new THREE.Quaternion().setFromAxisAngle(side, pitch);
  const q = pitchQ.multiply(R).multiply(b.userData.bindCSQ);
  rig.setWorldQuaternion(b, q);
  b.updateMatrixWorld(true);
  void bindWorldFromCS;
}

/**
 * Distributed look-at: yaw/pitch toward a world target, spread over a chain of bones with weights,
 * each bone rotating about world axes (head stays level), clamped to anatomical limits.
 */
export function lookAt(rig, target, chain, { maxYaw = 1.2, maxPitch = 0.7, weight = 1 } = {}) {
  if (weight <= 0) return { yaw: 0, pitch: 0 };
  const head = rig.bone('head');
  head.updateWorldMatrix(true, false);
  const eyeMid = new THREE.Vector3(0, 0.1, 0.08).applyMatrix4(head.matrixWorld);
  const dir = target.clone().sub(eyeMid);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.object.quaternion);
  // current head facing (bind head forward is +Z in CS)
  const hq = rig.worldQuat('head');
  const curFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(hq.clone().multiply(head.userData.bindCSQinv));
  const yawOf = (v) => Math.atan2(v.x, v.z);
  const pitchOf = (v) => Math.atan2(v.y, Math.hypot(v.x, v.z));
  let yaw = yawOf(dir) - yawOf(curFwd);
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  let pitch = pitchOf(dir) - pitchOf(curFwd);
  // limits relative to the body
  const bodyYaw = yawOf(dir) - yawOf(fwd);
  const wrapped = Math.atan2(Math.sin(bodyYaw), Math.cos(bodyYaw));
  const excess = Math.abs(wrapped) - maxYaw;
  if (excess > 0) yaw -= Math.sign(wrapped) * excess;
  pitch = THREE.MathUtils.clamp(pitch, -maxPitch, maxPitch);
  yaw *= weight;
  pitch *= weight;
  const total = chain.reduce((s, [, w]) => s + w, 0);
  for (const [name, w] of chain) {
    const b = rig.bone(name);
    const f = w / total;
    const wq = rig.worldQuat(name);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.object.quaternion).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw * 0.5);
    const dq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw * f).multiply(new THREE.Quaternion().setFromAxisAngle(side, -pitch * f));
    rig.setWorldQuaternion(b, dq.multiply(wq));
    b.updateMatrixWorld(true);
  }
  return { yaw, pitch };
}
