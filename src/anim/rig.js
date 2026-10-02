// Skeleton utilities for procedural animation on the UE5-style rig.
// Bone frames (from the build): local +Y along the bone, local +X the hinge axis (knee/elbow/finger
// flexion). Rotations are authored relative to the bind pose, with axes given in bind-pose
// character space ("CS": the space of the root bone), which keeps the code independent of
// individual bone rolls.
import * as THREE from 'three';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Rig {
  constructor(character) {
    this.character = character;
    this.object = character.root; // scene object carrying the world transform
    this.bones = character.bones;
    this.list = [...this.bones.values()];
    this.rootBone = this.bones.get('root');
    // bind data
    this.object.updateMatrixWorld(true);
    const rootInv = this.rootBone.matrixWorld.clone().invert();
    for (const b of this.list) {
      b.userData.bindQ = b.quaternion.clone();
      b.userData.bindP = b.position.clone();
      const cs = rootInv.clone().multiply(b.matrixWorld);
      b.userData.bindCSQ = new THREE.Quaternion().setFromRotationMatrix(cs);
      b.userData.bindCSQinv = b.userData.bindCSQ.clone().invert();
      b.userData.bindCSPos = new THREE.Vector3().setFromMatrixPosition(cs);
    }
    // limb lengths
    const len = (a, b) => this.bones.get(a).userData.bindCSPos.distanceTo(this.bones.get(b).userData.bindCSPos);
    this.legLength = len('thigh_l', 'calf_l') + len('calf_l', 'foot_l');
    this.hipHeight = this.bones.get('thigh_l').userData.bindCSPos.y;
    this.pelvisHeight = this.bones.get('pelvis').userData.bindCSPos.y;
    this.ankleHeight = this.bones.get('foot_l').userData.bindCSPos.y;
    this.hipWidth = this.bones.get('thigh_l').userData.bindCSPos.distanceTo(this.bones.get('thigh_r').userData.bindCSPos);
  }

  bone(name) {
    return this.bones.get(name);
  }

  resetPose() {
    for (const b of this.list) {
      b.quaternion.copy(b.userData.bindQ);
      b.position.copy(b.userData.bindP);
    }
  }

  /** Rotate a bone about an axis given in bind-pose character space (FK, hierarchical). */
  rotate(name, axisCS, angle) {
    if (!angle) return;
    const b = typeof name === 'string' ? this.bones.get(name) : name;
    _v.copy(axisCS).applyQuaternion(b.userData.bindCSQinv).normalize();
    b.quaternion.multiply(_q.setFromAxisAngle(_v, angle));
  }

  /** Sets a bone's WORLD orientation (parent world matrix must be current). */
  setWorldQuaternion(b, qWorld) {
    b.parent.updateWorldMatrix(true, false);
    const pq = new THREE.Quaternion().setFromRotationMatrix(_m.extractRotation(b.parent.matrixWorld));
    b.quaternion.copy(pq.invert().multiply(qWorld));
  }

  worldPos(name, out = new THREE.Vector3()) {
    const b = this.bones.get(name);
    b.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(b.matrixWorld);
  }

  worldQuat(name, out = new THREE.Quaternion()) {
    const b = this.bones.get(name);
    b.updateWorldMatrix(true, false);
    return out.setFromRotationMatrix(_m.extractRotation(b.matrixWorld));
  }

  /** Character-space (root bone space) direction -> world direction for the current placement. */
  csToWorldDir(v, out = new THREE.Vector3()) {
    return out.copy(v).applyQuaternion(this.object.quaternion);
  }

  /**
   * Twist distribution: measure the twist of `driver` relative to its bind pose around its own
   * bone axis (local Y) and spread it over helper bones (UE-style twist correctives).
   */
  distributeTwist(driverName, helpers) {
    const d = this.bones.get(driverName);
    const rel = d.userData.bindQ.clone().invert().multiply(d.quaternion);
    if (rel.w < 0) rel.set(-rel.x, -rel.y, -rel.z, -rel.w); // q and -q are the same rotation
    const twist = 2 * Math.atan2(rel.y, rel.w); // in (-pi, pi)
    for (const [name, factor] of helpers) {
      const h = this.bones.get(name);
      h.quaternion.copy(h.userData.bindQ).multiply(_q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), twist * factor));
    }
    return twist;
  }
}

/** Builds a world quaternion from bone-frame axes (X = hinge, Y = along the bone). */
export function frameQuat(x, y) {
  const X = x.clone().addScaledVector(y, -x.dot(y)).normalize();
  const Y = y.clone().normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}
