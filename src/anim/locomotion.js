// Procedural locomotion: velocity-matched, phase-locked stepping with world-planted feet.
//
// One continuous system covers idle -> walk -> jog -> run -> sprint (all gait parameters are
// smooth functions of speed), starts and stops, directional/strafe/backward movement, turning
// (in place via corrective steps, and banked turns while moving), jumps, falls, soft and hard
// landings, crouch and crouch-walk, slopes and stairs. Stance feet are fixed in world space, so
// they cannot slide; stride length = speed / cadence keeps the body consistent with the feet.
import * as THREE from 'three';
import { twoBoneIK, alignFoot } from './ik.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

/** Piecewise-linear table lookup. */
function table(rows, x) {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++)
    if (x <= rows[i][0]) {
      const t = (x - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]);
      return rows[i - 1][1] + (rows[i][1] - rows[i - 1][1]) * t;
    }
  return rows.at(-1)[1];
}

// Gait parameters vs. speed (m/s). Walk ~0.5-1.8, jog ~1.8-3.2, run ~3.2-5.5, sprint ~5.5-7.
export const GAIT = {
  cadence: [[0, 0.8], [0.5, 0.85], [1.4, 1.0], [2.5, 1.3], [3.5, 1.42], [5, 1.5], [7, 1.66]], // cycles/s (x2 = steps/s)
  duty: [[0, 0.68], [1.4, 0.62], [2.2, 0.48], [3.2, 0.36], [5, 0.31], [7, 0.27]],
  clearance: [[0, 0.05], [1.4, 0.075], [3, 0.13], [5, 0.18], [7, 0.22]],
  heelKick: [[0, 0], [2, 0.03], [4, 0.14], [7, 0.26]],
  bob: [[0, 0.004], [1.4, 0.016], [2.5, 0.025], [4, 0.035], [7, 0.04]],
  runness: [[0, 0], [1.8, 0], [2.6, 1]], // inverted pendulum (walk) -> spring-mass (run)
  pelvisDrop: [[0, 0.0], [1.4, 0.012], [3, 0.025], [5, 0.035], [7, 0.05]],
  sway: [[0, 0.0], [0.6, 0.022], [1.4, 0.025], [3, 0.012], [7, 0.008]],
  pelvisYaw: [[0, 0.0], [1.4, 0.08], [4, 0.12], [7, 0.16]],
  pelvisRoll: [[0, 0.0], [1.4, 0.06], [4, 0.05], [7, 0.04]],
  lean: [[0, 0.02], [1.4, 0.05], [4, 0.12], [7, 0.22]],
  armSwing: [[0, 0.0], [1.4, 0.32], [3, 0.55], [5, 0.75], [7, 0.95]],
  elbow: [[0, 0.25], [1.4, 0.35], [2.2, 0.9], [4, 1.35], [7, 1.55]],
  heelStrike: [[0, 0.12], [1.4, 0.26], [2.5, 0.12], [4, 0.0], [7, -0.1]], // rad, toes up at contact
  toeOff: [[0, 0.35], [1.4, 0.6], [4, 0.8], [7, 0.9]],
};

export function smoothDamp(cur, target, vel, smoothTime, dt) {
  // critically damped spring (Game Programming Gems 4)
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Locomotion {
  constructor(rig, terrain) {
    this.rig = rig;
    this.terrain = terrain;
    this.pos = new THREE.Vector3(0, terrain.height(0, 0), 0);
    this.yaw = 0;
    this.speed = 0; // signed speed along the movement direction
    this.vel = new THREE.Vector3();
    this.moveDir = new THREE.Vector3(0, 0, 1);
    this.vy = 0;
    this.grounded = true;
    this.phase = 0;
    this.gaitWeight = 0; // 0 = standing, 1 = cyclic gait
    this.yawRate = 0;
    this.accel = 0;
    this.crouch = 0;
    this.crouchVel = { v: 0 };
    this.landing = 0; // compression after impact (0..1)
    this.landingHard = 0;
    this.anticipation = 0;
    this.airTime = 0;
    this.groundY = this.pos.y;
    this.groundVel = { v: 0 };
    this.leanVel = { v: 0 };
    this.lean = 0;
    this.bank = 0;
    this.bankVel = { v: 0 };
    this.stepCooldown = 0;
    this.exertion = 0; // drives breathing rate / flush
    this.mode = 'idle';
    this.events = [];
    const half = rig.hipWidth / 2;
    this.feet = {
      l: { side: 1, half, ground: new THREE.Vector3(half * 0.9, this.pos.y, 0.02), swing: null, pitch: 0, toe: 0, normal: new THREE.Vector3(0, 1, 0), yaw: 0 },
      r: { side: -1, half, ground: new THREE.Vector3(-half * 0.9, this.pos.y, 0.02), swing: null, pitch: 0, toe: 0, normal: new THREE.Vector3(0, 1, 0), yaw: 0 },
    };
    for (const f of Object.values(this.feet)) f.ground.y = terrain.height(f.ground.x, f.ground.z);
    // heel / ball pivots relative to the ankle in the flat-foot frame (CS units)
    const ankle = rig.bone('foot_l').userData.bindCSPos;
    const ball = rig.bone('ball_l').userData.bindCSPos;
    this.ankleH = ankle.y;
    this.heelPivot = new THREE.Vector3(0, -ankle.y, -0.045); // heel contact below/behind the ankle
    this.ballPivot = new THREE.Vector3(0, ball.y - ankle.y - 0.01, ball.z - ankle.z);
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Ideal standing position of a foot (ground point) for the current body placement. */
  idealFoot(f, out = new THREE.Vector3()) {
    const fw = this.forward(tmp2);
    const lateral = new THREE.Vector3(fw.z, 0, -fw.x); // character left
    out.copy(this.pos).addScaledVector(lateral, f.side * f.half * 0.92).addScaledVector(fw, 0.015 + 0.04 * this.crouch);
    this.terrain.safeFootPoint(out);
    out.y = this.terrain.height(out.x, out.z);
    return out;
  }

  /**
   * @param input { dir: Vector3 (world, horizontal, |dir|<=1), speed: m/s, strafe: bool,
   *                faceYaw: number (strafe facing), crouch: bool, jump: bool }
   */
  update(dt, input) {
    const desired = input.dir.clone().setY(0);
    const mag = Math.min(1, desired.length());
    if (mag > 1e-3) desired.divideScalar(desired.length());
    let target = mag * input.speed * (1 - 0.6 * this.crouch);
    if (this.crouch > 0.5) target = Math.min(target, 1.3);

    // crouch
    this.crouch = smoothDamp(this.crouch, input.crouch ? 1 : 0, this.crouchVel, 0.22, dt);

    // jump / fall / land ------------------------------------------------------------------
    if (this.grounded && input.jump && this.anticipation <= 0 && this.landing < 0.3 && this.crouch < 0.3) this.anticipation = 1e-4;
    if (this.anticipation > 0) {
      this.anticipation += dt;
      if (this.anticipation > 0.14) {
        this.anticipation = 0;
        this.grounded = false;
        this.vy = 3.5 + 0.15 * Math.abs(this.speed);
        this.airTime = 0;
        this.events.push('jump');
      }
    }
    const groundHere = this.terrain.height(this.pos.x, this.pos.z);
    if (this.grounded && groundHere < this.pos.y - 0.35) {
      // walked off a ledge
      this.grounded = false;
      this.vy = 0;
      this.airTime = 0;
    }
    if (!this.grounded) {
      this.airTime += dt;
      this.vy -= 9.81 * dt;
      this.pos.y += this.vy * dt;
      const g = this.terrain.height(this.pos.x, this.pos.z);
      if (this.pos.y <= g && this.vy < 0) {
        const impact = -this.vy;
        this.pos.y = g;
        this.grounded = true;
        this.landingHard = impact > 5.2 ? 1 : 0;
        this.landing = Math.min(1, 0.25 + impact / 7);
        this.vy = 0;
        this.events.push(this.landingHard ? 'hardLanding' : 'landing');
        // plant both feet where they are
        for (const f of Object.values(this.feet)) {
          f.swing = null;
          this.idealFoot(f, f.ground);
        }
        if (this.landingHard) this.speed *= 0.35;
      }
    }
    this.landing = Math.max(0, this.landing - dt * (this.landingHard ? 0.9 : 2.2));
    if (this.landing <= 0) this.landingHard = 0;

    // heading and speed ----------------------------------------------------------------------
    const prevSpeed = this.speed;
    const prevYaw = this.yaw;
    const canMove = this.grounded && this.landingHard < 0.5 ? 1 : this.grounded ? 0.3 : 0.15;
    if (input.strafe) {
      // directional locomotion: face the aim direction, move freely
      const faceErr = wrapAngle(input.faceYaw - this.yaw);
      this.yaw += THREE.MathUtils.clamp(faceErr, -6 * dt, 6 * dt);
      const vDes = desired.clone().multiplyScalar(Math.min(target, 3.2));
      const dv = vDes.sub(this.vel);
      const a = (dv.length() > 0 && vDes.length() > this.vel.length() ? 6 : 9) * dt * canMove;
      if (dv.length() > a) dv.setLength(a);
      this.vel.add(dv);
      this.speed = this.vel.length();
      if (this.speed > 1e-3) this.moveDir.copy(this.vel).divideScalar(this.speed);
    } else {
      if (mag <= 1e-3 && input.turnTo !== undefined && input.turnTo !== null) {
        // turn in place (90 / 180 degree turns): body rotates, feet re-plant with corrective steps
        const err = wrapAngle(input.turnTo - this.yaw);
        const rate = 3.2 * Math.min(1, Math.abs(err) * 2 + 0.25);
        this.yaw += THREE.MathUtils.clamp(err, -rate * dt, rate * dt);
      }
      if (mag > 1e-3) {
        const yawDes = Math.atan2(desired.x, desired.z);
        const err = wrapAngle(yawDes - this.yaw);
        const rate = this.speed < 0.3 ? 4.0 : THREE.MathUtils.lerp(9, 3.2, Math.min(1, this.speed / 7));
        this.yaw += THREE.MathUtils.clamp(err, -rate * dt, rate * dt);
        // slow down through sharp turns (180° turn = decelerate, pivot, accelerate)
        target *= Math.max(0, Math.cos(err)) ** 0.7;
      }
      const up = target > this.speed;
      const a = (up ? (this.speed > 4.5 ? 3.5 : 6.5) : 9) * dt * canMove;
      this.speed += THREE.MathUtils.clamp(target - this.speed, -a, a);
      this.moveDir.copy(this.forward());
      this.vel.copy(this.moveDir).multiplyScalar(this.speed);
    }
    this.yawRate = wrapAngle(this.yaw - prevYaw) / Math.max(dt, 1e-4);
    this.accel = (this.speed - prevSpeed) / Math.max(dt, 1e-4);
    this.exertion = Math.max(0, Math.min(1, this.exertion + dt * (this.speed > 3 ? (this.speed - 3) * 0.05 : -0.025)));

    // integrate position
    if (this.grounded) {
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y = this.terrain.height(this.pos.x, this.pos.z);
    } else {
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
    }

    // gait / stepping -----------------------------------------------------------------------
    const v = this.speed;
    const moving = this.grounded && v > 0.2 && this.anticipation === 0;
    this.gaitWeight = THREE.MathUtils.clamp(this.gaitWeight + (moving ? dt * 4 : -dt * 3), 0, 1);
    const cad = table(GAIT.cadence, v) * (1 - 0.25 * this.crouch);
    const duty = table(GAIT.duty, v);
    this.duty = duty;
    this.cadence = cad;
    if (moving) {
      if (this.mode !== 'gait') {
        // start: lift the foot that is further behind first
        const fw = this.moveDir;
        const behindL = this.feet.l.ground.clone().sub(this.pos).dot(fw);
        const behindR = this.feet.r.ground.clone().sub(this.pos).dot(fw);
        this.phase = behindL < behindR ? duty - 0.001 : duty + 0.499;
        this.mode = 'gait';
      }
      const prevPhase = this.phase;
      this.phase = (this.phase + cad * dt) % 1;
      for (const [key, f] of Object.entries(this.feet)) {
        const off = key === 'l' ? 0 : 0.5;
        const p0 = (prevPhase + off) % 1, p1 = (this.phase + off) % 1;
        const swingDur = (1 - duty) / cad;
        if (!f.swing && p0 < duty && p1 >= duty) this.beginSwing(f, swingDur, true);
        if (f.swing?.gait) {
          // keep re-predicting the landing so curved paths and speed changes are honoured
          const remain = ((1 - p1) % 1) / cad;
          this.predictLanding(f, remain + (duty / cad) * this.midFrac(), f.swing.to);
          f.swing.dur = f.swing.t + remain;
        }
      }
    } else if (this.grounded) {
      if (this.mode === 'gait') this.mode = 'idle';
      // corrective steps: stop steps, re-planting, turning in place
      this.stepCooldown -= dt;
      const swinging = this.feet.l.swing || this.feet.r.swing;
      if (!swinging && this.stepCooldown <= 0 && this.anticipation === 0 && this.landing < 0.4) {
        let worst = null, worstErr = 0;
        for (const f of Object.values(this.feet)) {
          const ideal = this.idealFoot(f, new THREE.Vector3());
          const posErr = ideal.distanceTo(f.ground);
          const yawErr = Math.abs(wrapAngle(this.yaw - f.yaw));
          const err = posErr + yawErr * 0.12;
          if (err > worstErr) (worstErr = err), (worst = f);
        }
        if (worst && worstErr > 0.09) {
          this.beginSwing(worst, 0.3 + 0.1 * this.crouch, false);
          this.stepCooldown = 0.05;
        }
      }
      for (const f of Object.values(this.feet)) if (f.swing && f.swing.gait) {
        // gait swing in progress while stopping: retarget to the standing position
        f.swing.gait = false;
        f.swing.dur = Math.max(f.swing.t + 0.12, Math.min(f.swing.dur, f.swing.t + 0.3));
      }
      for (const f of Object.values(this.feet)) if (f.swing && !f.swing.gait) this.idealFoot(f, f.swing.to);
    }
    // advance swings
    for (const f of Object.values(this.feet)) {
      if (!f.swing) continue;
      f.swing.t += dt;
      if (f.swing.t >= f.swing.dur) {
        f.ground.copy(f.swing.to);
        f.yaw = f.swing.yaw;
        f.swing = null;
        this.events.push('footstep');
      }
    }

    // smoothed ground reference for the body (stairs/slopes), lean and banking
    const feetY = (this.feet.l.ground.y + this.feet.r.ground.y) / 2;
    const refY = this.grounded ? Math.min(this.pos.y, feetY + 0.02) * 0.5 + Math.max(this.pos.y, feetY) * 0.5 : this.pos.y;
    this.groundY = this.grounded ? smoothDamp(this.groundY, refY, this.groundVel, 0.12, dt) : this.pos.y;
    this.lean = smoothDamp(this.lean, THREE.MathUtils.clamp(this.accel * 0.035, -0.22, 0.25), this.leanVel, 0.18, dt);
    this.bank = smoothDamp(this.bank, THREE.MathUtils.clamp(-this.yawRate * v * 0.035, -0.3, 0.3), this.bankVel, 0.15, dt);
    return this.events.splice(0);
  }

  beginSwing(f, dur, gait) {
    const to = new THREE.Vector3();
    if (gait) this.predictLanding(f, dur + (this.duty / this.cadence) * this.midFrac(), to);
    else this.idealFoot(f, to);
    f.swing = { from: f.ground.clone(), to, t: 0, dur, gait, yaw: this.yaw, height: gait ? table(GAIT.clearance, this.speed) : 0.045 + 0.03 * this.crouch };
  }

  /** Fraction of stance at which the hip passes over the foot: runners land closer under the
   *  body and push off further behind (asymmetric contact), walkers are symmetric. */
  midFrac() {
    return THREE.MathUtils.lerp(0.5, 0.36, table(GAIT.runness, this.speed));
  }

  /** Where the foot should land so the hip passes over it at mid-stance (velocity matched). */
  predictLanding(f, tMid, out) {
    const yawMid = this.yaw + this.yawRate * tMid * 0.8;
    const fw = new THREE.Vector3(Math.sin(yawMid), 0, Math.cos(yawMid));
    const lateral = new THREE.Vector3(fw.z, 0, -fw.x);
    const width = f.half * THREE.MathUtils.lerp(0.85, 0.35, Math.min(1, this.speed / 6)); // narrower base when running
    out.copy(this.pos).addScaledVector(this.vel, tMid).addScaledVector(lateral, f.side * width);
    this.terrain.safeFootPoint(out);
    out.y = this.terrain.height(out.x, out.z);
    if (f.swing) f.swing.yaw = yawMid;
    return out;
  }

  /** Current foot ground point (with swing arc) and pitch, in world space. */
  footState(key) {
    const f = this.feet[key];
    const v = this.speed;
    let p, lift = 0, pitch = 0, toe = 0;
    if (!this.grounded) {
      // airborne: feet tucked under the body
      const tuck = Math.min(1, this.airTime * 4) * (this.vy > 0 ? 1 : 0.6);
      p = this.idealFoot(f, new THREE.Vector3()).setY(this.pos.y);
      p.addScaledVector(this.forward(), (key === 'l' ? 0.08 : -0.05) * (1 + v * 0.2));
      lift = 0.12 + 0.18 * tuck;
      pitch = 0.35;
    } else if (f.swing) {
      const s = f.swing;
      const u = Math.min(1, s.t / s.dur);
      const e = u * u * (3 - 2 * u);
      p = s.from.clone().lerp(s.to, e);
      p.y = s.from.y + (s.to.y - s.from.y) * Math.min(1, e * 1.4);
      // clear stair edges: lift by any rise along the way
      const rise = Math.max(0, s.to.y - s.from.y);
      lift = s.height * Math.sin(Math.PI * u) + rise * Math.sin(Math.PI * Math.min(1, u * 1.3)) * 0.6;
      if (s.gait) {
        // heel kick at speed: foot rises behind the body in early swing
        const kick = table(GAIT.heelKick, v) * Math.sin(Math.PI * Math.min(1, u * 1.6));
        lift += kick;
        p.addScaledVector(this.moveDir, -kick * 0.6);
        pitch = THREE.MathUtils.lerp(table(GAIT.toeOff, v) * 0.6, -table(GAIT.heelStrike, v), e) * (1 - Math.sin(Math.PI * u) * 0.3);
      } else pitch = Math.sin(Math.PI * u) * 0.15;
    } else {
      p = f.ground.clone();
      if (this.mode === 'gait') {
        const ph = ((this.phase + (key === 'l' ? 0 : 0.5)) % 1) / this.duty; // 0..1 through stance
        // heel strike -> flat -> heel rise / toe-off
        const hs = table(GAIT.heelStrike, v) * (1 - THREE.MathUtils.smoothstep(ph, 0, 0.18));
        const to = table(GAIT.toeOff, v) * THREE.MathUtils.smoothstep(ph, 0.62, 1.0);
        pitch = -hs + to;
        toe = -to * 0.9;
      }
    }
    return { p, lift, pitch, toe, yaw: f.swing ? f.swing.yaw : f.yaw, normal: this.terrain.normal(p.x, p.z, new THREE.Vector3()) };
  }

  /** Writes the lower-body / root pose. Upper-body layers are applied by the animator. */
  applyPose(rig, layers = {}) {
    const v = this.speed;
    const obj = rig.object;
    // `pos` is the ground projection of the pelvis (centre of mass); the skeleton origin sits
    // mid-foot, ahead of the hips, so offset the placement by the bind-pose pelvis depth.
    const pz = rig.bone('pelvis').userData.bindCSPos.z;
    obj.position.set(this.pos.x - Math.sin(this.yaw) * pz, this.groundY, this.pos.z - Math.cos(this.yaw) * pz);
    obj.rotation.set(0, this.yaw, 0);
    rig.resetPose();
    const gw = this.gaitWeight;
    const ph = this.phase;
    const duty = this.duty ?? 0.6;
    const run = table(GAIT.runness, v);
    const cosB = Math.cos(2 * Math.PI * 2 * (ph - duty / 2));
    // pelvis translation (character space)
    const pelvis = rig.bone('pelvis');
    const bob = table(GAIT.bob, v) * (run > 0 ? -cosB * run + cosB * (1 - run) : cosB) * gw;
    const sway = table(GAIT.sway, v) * Math.cos(2 * Math.PI * (ph - duty / 2)) * gw;
    const crouchDrop = 0.3 * this.crouch;
    const land = this.landing * (this.landingHard ? 0.42 : 0.16);
    const antic = this.anticipation > 0 ? Math.sin((this.anticipation / 0.14) * Math.PI * 0.5) * 0.09 : 0;
    const air = this.grounded ? 0 : Math.min(0.06, this.airTime * 0.3) * (this.vy > 0 ? 1 : 0.5);
    const pOff = new THREE.Vector3(sway + (layers.pelvisShift ?? 0), -table(GAIT.pelvisDrop, v) * gw - crouchDrop - land - antic + air + bob + (layers.pelvisY ?? 0), -0.04 * this.crouch);
    pelvis.position.add(pOff.applyQuaternion(rig.rootBone.quaternion));
    // pelvis rotation
    const yawP = -table(GAIT.pelvisYaw, v) * Math.cos(2 * Math.PI * ph) * gw * (this.speed < 0 ? -1 : 1);
    const rollP = table(GAIT.pelvisRoll, v) * Math.cos(2 * Math.PI * (ph - duty / 2)) * gw + (layers.pelvisRoll ?? 0);
    const pitchP = (table(GAIT.lean, v) * 0.5 + this.crouch * 0.35 + land * 0.8 + antic * 1.5) * 1;
    rig.rotate('pelvis', UP, yawP);
    rig.rotate('pelvis', new THREE.Vector3(0, 0, 1), rollP + this.bank * 0.5);
    rig.rotate('pelvis', new THREE.Vector3(1, 0, 0), pitchP);
    this.pose = { yawP, rollP, pitchP, run, gw };
  }

  /** Leg IK and foot placement (after the upper body FK so hips are final). */
  solveLegs(rig) {
    rig.object.updateMatrixWorld(true);
    const fw = this.forward(new THREE.Vector3());
    // pelvis height correction so both legs can reach their targets (stairs, slopes, wide steps)
    const pelvis = rig.bone('pelvis');
    let lower = 0;
    const targets = {};
    for (const key of ['l', 'r']) {
      const st = this.footState(key);
      const lateralYaw = st.yaw;
      const ffw = new THREE.Vector3(Math.sin(lateralYaw), 0, Math.cos(lateralYaw));
      const side = new THREE.Vector3().crossVectors(st.normal, ffw).normalize();
      // pivot the ankle around the heel (pitch < 0) or the ball (pitch > 0)
      const pivot = st.pitch < 0 ? this.heelPivot : this.ballPivot;
      const toWorld = (v3) => new THREE.Vector3().addScaledVector(side, v3.x).addScaledVector(st.normal, v3.y).addScaledVector(ffw, v3.z);
      const ankleFlat = st.p.clone().addScaledVector(st.normal, this.ankleH);
      const pv = ankleFlat.clone().add(toWorld(pivot));
      const rel = ankleFlat.clone().sub(pv).applyAxisAngle(side, st.pitch);
      const ankle = pv.add(rel).addScaledVector(UP, st.lift);
      targets[key] = { ankle, st, ffw };
      const hip = rig.worldPos(`thigh_${key}`, new THREE.Vector3());
      const planted = this.grounded && !this.feet[key].swing;
      if (planted) {
        // only a planted foot may pull the pelvis down (stairs, slopes, long contact)
        const need = hip.distanceTo(ankle) - rig.legLength * 0.985;
        if (need > lower) lower = need;
      } else {
        // a swinging / airborne foot cannot drag the body: pull its target into reach
        const d = ankle.clone().sub(hip);
        const max = rig.legLength * 0.97;
        if (d.length() > max) ankle.copy(hip).add(d.setLength(max));
      }
    }
    this.debugLower = lower;
    if (lower > 0) {
      pelvis.position.y -= Math.min(lower, 0.35);
      rig.object.updateMatrixWorld(true);
    }
    for (const key of ['l', 'r']) {
      const { ankle, st, ffw } = targets[key];
      const knee = ffw.clone().addScaledVector(new THREE.Vector3(ffw.z, 0, -ffw.x), (key === 'l' ? 1 : -1) * 0.12).normalize();
      twoBoneIK(rig, [`thigh_${key}`, `calf_${key}`, `foot_${key}`], ankle, knee);
      alignFoot(rig, `foot_${key}`, ffw, st.normal, st.pitch);
      rig.rotate(`ball_${key}`, new THREE.Vector3(1, 0, 0), st.toe);
    }
    void fw;
    void tmp;
  }
}
