// Per-frame animation composition (layer order matters):
//   locomotion (root, pelvis, gait schedule) + idle layer (additive)
//   -> upper body FK: spine counter-rotation, lean, breathing, clavicles, arm swing, fingers
//   -> aim offset / hand IK (combat mode, object holding)
//   -> leg IK with foot alignment and pelvis height adaptation
//   -> twist bone distribution
//   -> look-at (spine/neck/head) for head stabilisation, then eyes (saccades, vergence)
//   -> face weights, breathing blendshapes, secondary springs
import * as THREE from 'three';
import { Rig } from './rig.js';
import { Locomotion, smoothDamp } from './locomotion.js';
import { IdleLayer } from './idle.js';
import { FaceController } from './face.js';
import { twoBoneIK, lookAt } from './ik.js';
import { skinGlobals } from '../render/skin.js';

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const FINGERS = ['index', 'middle', 'ring', 'pinky'];

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Animator {
  constructor(character, terrain, { seed = 7 } = {}) {
    this.character = character;
    this.rig = new Rig(character);
    this.loco = new Locomotion(this.rig, terrain, { sole: character.meta.outfit?.sole ?? 0 });
    const rng = mulberry(seed);
    this.idle = new IdleLayer(rng);
    this.face = new FaceController(character.meta, rng);
    this.lookTarget = new THREE.Vector3(0, 1.6, 3);
    this.aim = 0;
    this.aimVel = { v: 0 };
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.prop = null; // held object (Object3D) in combat mode
    this.reach = null; // { target: Vector3, side: 'l'|'r', weight }
    this.reachW = { l: 0, r: 0 };
    this.springs = { l: { x: 0, v: 0 }, r: { x: 0, v: 0 } };
    this.prevChest = null;
    this.prevChestVel = new THREE.Vector3();
    this.relaxed = this.computeRelaxedArms();
    this.flexSign = this.calibrateFingerFlex();
  }

  /** Arms hanging naturally beside the thighs, solved once with IK from the A-pose. */
  computeRelaxedArms() {
    const rig = this.rig;
    rig.object.position.set(0, 0, 0);
    rig.object.rotation.set(0, 0, 0);
    rig.resetPose();
    rig.object.updateMatrixWorld(true);
    const out = {};
    for (const [s, side] of [['l', 1], ['r', -1]]) {
      const hip = rig.worldPos(`thigh_${s}`, new THREE.Vector3());
      const target = hip.clone().add(new THREE.Vector3(side * 0.085, -0.12, 0.045));
      twoBoneIK(rig, [`upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`], target, new THREE.Vector3(side * 0.35, -0.1, -1).normalize());
      // relaxed wrist: palm toward the thigh, slight flexion
      out[s] = { upper: rig.bone(`upperarm_${s}`).quaternion.clone(), lower: rig.bone(`lowerarm_${s}`).quaternion.clone() };
    }
    rig.resetPose();
    return out;
  }

  /** Finger flexion sign per side: rotate index_02 and check the tip moves toward the palm. */
  calibrateFingerFlex() {
    const rig = this.rig;
    const res = {};
    rig.resetPose();
    rig.object.updateMatrixWorld(true);
    for (const s of ['l', 'r']) {
      const iM = rig.bone(`index_metacarpal_${s}`).userData.bindCSPos, pM = rig.bone(`pinky_metacarpal_${s}`).userData.bindCSPos, m1 = rig.bone(`middle_01_${s}`).userData.bindCSPos;
      const thumb = rig.bone(`thumb_03_${s}`).userData.bindCSPos;
      const center = rig.bone(`hand_${s}`).userData.bindCSPos.clone().lerp(m1, 0.55);
      const palmar = new THREE.Vector3().subVectors(pM, iM).cross(new THREE.Vector3().subVectors(m1, iM)).normalize();
      if (palmar.dot(thumb.clone().sub(center)) < 0) palmar.negate();
      const b = rig.bone(`index_02_${s}`);
      const tip0 = rig.worldPos(`index_03_${s}`, new THREE.Vector3());
      b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, 0.3));
      rig.object.updateMatrixWorld(true);
      const tip1 = rig.worldPos(`index_03_${s}`, new THREE.Vector3());
      res[s] = tip1.sub(tip0).dot(palmar) > 0 ? 1 : -1;
      rig.resetPose();
    }
    rig.object.updateMatrixWorld(true);
    return res;
  }

  /** Rotation about a character-space axis applied in CS (pre-multiplied), hierarchical. */
  rotateCS(name, axis, angle) {
    if (!angle) return;
    const rig = this.rig;
    const b = rig.bone(name);
    const wq = rig.worldQuat(name);
    const ax = axis.clone().applyQuaternion(rig.object.quaternion);
    rig.setWorldQuaternion(b, new THREE.Quaternion().setFromAxisAngle(ax, angle).multiply(wq));
    b.updateMatrixWorld(true);
  }

  update(dt, input, ctx = {}) {
    const { rig, loco } = this;
    const events = loco.update(dt, input);
    const still = 1 - loco.gaitWeight;
    const idle = this.idle.update(dt, loco.exertion, still * (loco.grounded ? 1 : 0));
    this.aim = smoothDamp(this.aim, input.aim ? 1 : 0, this.aimVel, 0.18, dt);
    loco.applyPose(rig, { pelvisShift: idle.pelvisShift * (1 - 0.5 * this.aim), pelvisRoll: idle.pelvisRoll * (1 - 0.6 * this.aim), pelvisY: idle.pelvisY - 0.03 * this.aim });
    const P = loco.pose;
    const v = loco.speed;
    const gw = loco.gaitWeight;
    const ph = loco.phase;

    // ---- spine: counter-rotation, lean (speed + acceleration + crouch), sway, breathing ------
    const counterYaw = -P.yawP * 1.15;
    const lean = (loco.lean + 0.03 * gw * Math.min(1, v / 4)) * 1 + 0.25 * loco.crouch + (loco.grounded ? 0 : -0.05) + 0.06 * this.aim;
    const breathExt = -0.018 * idle.breath;
    const spine = [['spine_01', 0.12], ['spine_02', 0.18], ['spine_03', 0.22], ['spine_04', 0.24], ['spine_05', 0.24]];
    for (const [n, w] of spine) {
      rig.rotate(n, Y, counterYaw * w + idle.spineTwist * w);
      rig.rotate(n, Z, -P.rollP * 0.75 * w + idle.swayRoll * w - loco.bank * 0.4 * w);
      rig.rotate(n, X, lean * w + idle.swayPitch * w + (n === 'spine_04' || n === 'spine_05' ? breathExt : 0));
    }
    rig.rotate('neck_01', X, -lean * 0.35 + idle.swallow * 0.02);
    rig.rotate('head', X, idle.swallow * 0.05);

    // ---- clavicles: breathing lift, shoulder roll, arm-swing protraction ----------------------
    const swingAmp = THREE.MathUtils.lerp(0.04, 1, gw) * this.gaitArm(v);
    for (const [s, side] of [['l', 1], ['r', -1]]) {
      const lift = 0.03 * idle.breath + 0.05 * idle.shoulderRoll + 0.04 * loco.landing;
      rig.rotate(`clavicle_${s}`, Z, side * lift);
      const armPhase = Math.cos(2 * Math.PI * ph) * (s === 'l' ? 1 : -1);
      rig.rotate(`clavicle_${s}`, Y, side * -0.06 * swingAmp * armPhase);
    }

    // ---- arms: relaxed base + pendulum swing opposite to the legs, elbow flexion -----------
    rig.object.updateMatrixWorld(true);
    const elbow = this.gaitElbow(v) * Math.max(gw, 0.25 * loco.crouch) + 0.12 * still;
    for (const [s, side] of [['l', 1], ['r', -1]]) {
      rig.bone(`upperarm_${s}`).quaternion.copy(this.relaxed[s].upper);
      rig.bone(`lowerarm_${s}`).quaternion.copy(this.relaxed[s].lower);
      rig.bone(`upperarm_${s}`).updateMatrixWorld(true);
      const armPhase = Math.cos(2 * Math.PI * ph) * (s === 'l' ? 1 : -1) * (loco.speed < 0 ? -1 : 1);
      const swing = swingAmp * armPhase + idle.armSway * still;
      // + = arm back; slight outward (abduction) at speed and in the air
      this.rotateCS(`upperarm_${s}`, X, swing * 0.9 + (loco.grounded ? 0 : -0.5 * Math.min(1, loco.airTime * 3)) - 0.15 * loco.crouch);
      this.rotateCS(`upperarm_${s}`, Z, side * -(0.06 * gw * Math.min(1, v / 4) + 0.25 * loco.landingHard * loco.landing + (loco.grounded ? 0 : 0.3)));
      const flex = elbow + Math.max(0, -armPhase) * 0.35 * gw;
      rig.bone(`lowerarm_${s}`).quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, flex));
      // fingers: relaxed curl, tighter when running, tiny idle motion
      this.poseFingers(s, 0.35 + 0.45 * Math.min(1, v / 5) * gw + idle.fingers + 0.1 * this.aim, idle.fingerSpread);
    }

    // ---- combat / aim: upper body aims, hands hold the prop -------------------------------
    if (this.aim > 0.01) this.applyAim(input, dt);
    if (this.reach) this.applyReach(dt);

    // ---- legs ------------------------------------------------------------------------------
    loco.solveLegs(rig);

    // ---- twist helpers ---------------------------------------------------------------------
    for (const s of ['l', 'r']) {
      rig.distributeTwist(`upperarm_${s}`, [[`upperarm_twist_01_${s}`, -0.6], [`upperarm_twist_02_${s}`, -0.3]]);
      rig.distributeTwist(`hand_${s}`, [[`lowerarm_twist_01_${s}`, 0.33], [`lowerarm_twist_02_${s}`, 0.66]]);
      rig.distributeTwist(`thigh_${s}`, [[`thigh_twist_01_${s}`, -0.6], [`thigh_twist_02_${s}`, -0.3]]);
    }

    // ---- head look-at (stabilises the head against bob and counter-rotation) ----------------
    rig.object.updateMatrixWorld(true);
    const look = this.currentLookTarget(input);
    const ho = this.face.headOffset ?? {};
    lookAt(rig, look, [['spine_05', 0.12], ['neck_01', 0.22], ['neck_02', 0.26], ['head', 0.4]], { maxYaw: 1.1, maxPitch: 0.6, weight: 0.85 });
    rig.rotate('head', Z, (ho.roll ?? 0) + idle.headNoise[0]);
    rig.rotate('head', X, (ho.pitch ?? 0) + idle.headNoise[1]);
    rig.object.updateMatrixWorld(true);

    // ---- eyes ------------------------------------------------------------------------------
    const head = rig.bone('head');
    const hq = rig.worldQuat('head').multiply(head.userData.bindCSQinv);
    const eyeC = rig.worldPos('eye_l', new THREE.Vector3()).add(rig.worldPos('eye_r', new THREE.Vector3())).multiplyScalar(0.5);
    const dirHead = this.eyeTarget(look).sub(eyeC).applyQuaternion(hq.clone().invert());
    const gaze = { yaw: Math.atan2(dirHead.x, dirHead.z), pitch: Math.atan2(dirHead.y, Math.hypot(dirHead.x, dirHead.z)), distance: dirHead.length() };
    const W = this.face.update(dt, gaze, { exertion: loco.exertion, light: ctx.light, talking: !!this.face.speech });
    for (const s of ['l', 'r']) {
      const a = this.face.eyeAngles[s];
      rig.rotate(`eye_${s}`, Y, THREE.MathUtils.clamp(a.yaw, -0.6, 0.6));
      rig.rotate(`eye_${s}`, X, -THREE.MathUtils.clamp(a.pitch, -0.5, 0.42));
    }

    // ---- breathing / exertion blendshapes, skin flush ------------------------------------------
    W.breatheChest = idle.breathChest;
    W.breatheBelly = idle.breathBelly;
    W.noseFlare = Math.max(W.noseFlare ?? 0, idle.breath * loco.exertion * 0.8);
    W.jawOpen = Math.max(W.jawOpen ?? 0, loco.exertion * 0.12 * idle.breath);
    W.mouthPressLeft = (W.mouthPressLeft ?? 0) + idle.swallow * 0.35;
    W.mouthPressRight = (W.mouthPressRight ?? 0) + idle.swallow * 0.3;
    this.character.weights = W;
    skinGlobals.flush.value = loco.exertion * 0.75;
    skinGlobals.blush.value = ['happy', 'pain', 'angry'].includes(this.face.exprTarget) ? 0.25 : 0;

    // ---- subtle secondary motion (breast tissue), heavily damped -------------------------------
    this.secondary(dt);
    rig.object.updateMatrixWorld(true);
    this.lastEvents = events;
    return events;
  }

  gaitArm(v) {
    const rows = [[0, 0], [1.4, 0.32], [3, 0.55], [5, 0.75], [7, 0.95]];
    return interp(rows, v);
  }
  gaitElbow(v) {
    const rows = [[0, 0.1], [1.4, 0.2], [2.2, 0.75], [4, 1.2], [7, 1.4]];
    return interp(rows, v);
  }

  poseFingers(s, curl, spread) {
    const rig = this.rig;
    const sign = this.flexSign[s];
    FINGERS.forEach((f, i) => {
      const k = 1 + i * 0.12; // pinky curls more
      rig.bone(`${f}_01_${s}`).quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, sign * curl * 0.45 * k));
      rig.bone(`${f}_02_${s}`).quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, sign * curl * 0.75 * k));
      rig.bone(`${f}_03_${s}`).quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, sign * curl * 0.45 * k));
      rig.bone(`${f}_01_${s}`).quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Z, (i - 1.5) * spread));
    });
    rig.bone(`thumb_02_${s}`).quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, sign * curl * 0.25));
    rig.bone(`thumb_03_${s}`).quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(X, sign * curl * 0.35));
  }

  currentLookTarget(input) {
    const loco = this.loco;
    if (input.lookAt) this.lookTarget.copy(input.lookAt);
    // while moving, look where we are going (blend with the external target)
    const ahead = loco.pos.clone().addScaledVector(loco.moveDir, 4 + loco.speed).setY(loco.groundY + 1.55 - 0.3 * loco.crouch);
    const t = this.lookTarget.clone().lerp(ahead, Math.min(1, loco.gaitWeight * 0.85));
    if (this.aim > 0.01) {
      const aimPt = loco.pos.clone().add(new THREE.Vector3(Math.sin(this.aimYaw), Math.tan(this.aimPitch), Math.cos(this.aimYaw)).multiplyScalar(6)).setY(loco.groundY + 1.5 + Math.tan(this.aimPitch) * 6);
      t.lerp(aimPt, this.aim);
    }
    return t;
  }

  eyeTarget(look) {
    return look.clone();
  }

  applyAim(input, dt) {
    const rig = this.rig;
    this.aimYaw = input.faceYaw ?? this.loco.yaw;
    this.aimPitch = input.aimPitch ?? 0;
    rig.object.updateMatrixWorld(true);
    // aim offset: distribute the aim pitch over the spine
    for (const n of ['spine_03', 'spine_04', 'spine_05']) this.rotateCS(n, X, -this.aimPitch * 0.25 * this.aim);
    if (!this.prop) return;
    // two-handed hold: right hand grips, left hand supports; prop placed in front of the chest
    const chest = rig.worldPos('spine_05', new THREE.Vector3());
    const fw = new THREE.Vector3(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
    const aimDir = fw.clone().multiplyScalar(Math.cos(this.aimPitch)).setY(Math.sin(this.aimPitch)).normalize();
    const right = new THREE.Vector3(-fw.z, 0, fw.x);
    const grip = chest.clone().addScaledVector(aimDir, 0.36).addScaledVector(right, 0.06).add(new THREE.Vector3(0, -0.08, 0));
    this.prop.position.copy(grip);
    this.prop.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), aimDir);
    this.prop.visible = this.aim > 0.5;
    const support = grip.clone().addScaledVector(aimDir, 0.05).addScaledVector(right, -0.035).add(new THREE.Vector3(0, -0.035, 0));
    twoBoneIK(rig, ['upperarm_r', 'lowerarm_r', 'hand_r'], grip.clone().addScaledVector(aimDir, -0.07), right.clone().add(new THREE.Vector3(0, -1, 0)), this.aim);
    twoBoneIK(rig, ['upperarm_l', 'lowerarm_l', 'hand_l'], support.clone().addScaledVector(aimDir, -0.06), right.clone().negate().add(new THREE.Vector3(0, -1, 0)), this.aim);
    for (const s of ['l', 'r']) {
      const hb = rig.bone(`hand_${s}`);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), aimDir);
      const cur = rig.worldQuat(`hand_${s}`);
      rig.setWorldQuaternion(hb, cur.slerp(q.multiply(hb.userData.bindCSQ.clone().premultiply(new THREE.Quaternion())).normalize(), 0.0));
      this.poseFingers(s, 0.9 * this.aim, 0);
    }
    void dt;
  }

  /** Environmental interaction: reach a hand toward a world point (e.g. touch a wall / door). */
  applyReach(dt) {
    const { target, side } = this.reach;
    const k = 1 - Math.exp(-dt / 0.2);
    for (const s of ['l', 'r']) this.reachW[s] += ((s === side && this.reach.active ? 1 : 0) - this.reachW[s]) * k;
    for (const s of ['l', 'r']) {
      if (this.reachW[s] < 0.01) continue;
      const sideSign = s === 'l' ? 1 : -1;
      twoBoneIK(this.rig, [`upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`], target, new THREE.Vector3(sideSign * 0.5, -1, -0.3).normalize(), this.reachW[s]);
    }
  }

  secondary(dt) {
    const rig = this.rig;
    const chest = rig.worldPos('spine_04', new THREE.Vector3());
    if (!this.prevChest) this.prevChest = chest.clone();
    const vel = chest.clone().sub(this.prevChest).divideScalar(Math.max(dt, 1e-4));
    const acc = vel.clone().sub(this.prevChestVel).divideScalar(Math.max(dt, 1e-4));
    this.prevChest.copy(chest);
    this.prevChestVel.copy(vel);
    const h = Math.min(dt, 1 / 30);
    for (const s of ['l', 'r']) {
      const sp = this.springs[s];
      // spring-damper on vertical tissue lag (critically damped-ish, tiny amplitude)
      const k = 260, c = 26;
      const a = -k * sp.x - c * sp.v - THREE.MathUtils.clamp(acc.y, -40, 40) * 0.0035;
      sp.v += a * h;
      sp.x += sp.v * h;
      sp.x = THREE.MathUtils.clamp(sp.x, -0.04, 0.04);
      rig.rotate(`breast_${s}`, X, sp.x);
    }
  }
}

function interp(rows, x) {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++)
    if (x <= rows[i][0]) return rows[i - 1][1] + ((rows[i][1] - rows[i - 1][1]) * (x - rows[i - 1][0])) / (rows[i][0] - rows[i - 1][0]);
  return rows.at(-1)[1];
}
