// Keyboard input (WASD relative to the camera) and a scripted demo "tour" that exercises every
// locomotion state without user input.
import * as THREE from 'three';

export const SPEEDS = { walk: 1.45, jog: 2.6, run: 4.2, sprint: 6.4 };

export class KeyboardInput {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.crouch = false;
    this.aim = false;
    this.turnTo = null;
  }
  read(camera, loco) {
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const camF = new THREE.Vector3();
    camera.getWorldDirection(camF);
    camF.y = 0;
    camF.normalize();
    const camR = new THREE.Vector3(-camF.z, 0, camF.x);
    const dir = camF.multiplyScalar(f).addScaledVector(camR, r);
    if (dir.lengthSq() > 1) dir.normalize();
    if (this.pressed.has('KeyC')) this.crouch = !this.crouch;
    if (this.pressed.has('KeyF')) this.aim = !this.aim;
    if (this.pressed.has('KeyQ')) this.turnTo = loco.yaw + Math.PI / 2;
    if (this.pressed.has('KeyE')) this.turnTo = loco.yaw - Math.PI / 2;
    if (this.pressed.has('KeyT')) this.turnTo = loco.yaw + Math.PI;
    if (dir.lengthSq() > 0) this.turnTo = null;
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? SPEEDS.sprint : k.has('ControlLeft') || k.has('AltLeft') ? SPEEDS.walk : this.defaultSpeed ?? SPEEDS.run;
    const jump = this.pressed.has('Space');
    this.pressed.clear();
    const camYaw = Math.atan2(camF.x, camF.z);
    return { dir, speed, jump, crouch: this.crouch, aim: this.aim, strafe: this.aim, faceYaw: camYaw, turnTo: this.turnTo, aimPitch: 0 };
  }
  get active() {
    return this.keys.size > 0;
  }
}

/** Scripted tour: idle -> walk -> jog -> run -> sprint -> stop -> turns -> stairs -> ledge drop -> crouch walk -> combat strafe. */
export class Tour {
  constructor() {
    this.t = 0;
    const P = (x, z) => new THREE.Vector3(x, 0, z);
    this.script = [
      { d: 3.0, label: 'Idle (breathing, weight shift, blinks, saccades)' },
      { d: 3.5, label: 'Walk', to: P(0, 3), speed: SPEEDS.walk },
      { d: 3.0, label: 'Jog', to: P(2.2, 7), speed: SPEEDS.jog },
      { d: 3.0, label: 'Run', to: P(-1, 9), speed: SPEEDS.run },
      { d: 2.4, label: 'Sprint', to: P(-6, 6), speed: SPEEDS.sprint },
      { d: 2.0, label: 'Stop', speed: 0 },
      { d: 1.8, label: 'Turn 90°', turn: Math.PI / 2 },
      { d: 2.2, label: 'Turn 180°', turn: Math.PI },
      { d: 6.0, label: 'Stairs up', to: P(-3.8, 4.2), speed: SPEEDS.walk, via: [P(-3.8, -0.2)] },
      { d: 2.6, label: 'Walk off the ledge: fall + hard landing', to: P(-3.8, 7.5), speed: SPEEDS.jog },
      { d: 2.0, label: 'Recover', speed: 0 },
      { d: 4.0, label: 'Crouch walk', to: P(-1, 2), speed: SPEEDS.walk, crouch: true },
      { d: 2.0, label: 'Jump', to: P(1, -1), speed: SPEEDS.run, jumpAt: 0.6 },
      { d: 4.0, label: 'Rocky ground (foot IK)', to: P(0.5, -5.5), speed: SPEEDS.walk },
      { d: 4.0, label: 'Slope (15°)', to: P(5.5, -4), speed: SPEEDS.jog },
      { d: 4.5, label: 'Combat strafe (aim, directional locomotion)', strafe: true, to: P(3, -1), speed: SPEEDS.walk },
      { d: 3.0, label: 'Combat idle', strafe: true, speed: 0 },
      { d: 2.5, label: 'Back to centre', to: P(0, 0), speed: SPEEDS.jog },
    ];
    this.i = 0;
    this.stepT = 0;
    this.turnTarget = null;
  }
  get label() {
    return this.script[this.i]?.label ?? '';
  }
  read(dt, loco) {
    const s = this.script[this.i];
    this.stepT += dt;
    if (this.stepT >= s.d) {
      this.i = (this.i + 1) % this.script.length;
      this.stepT = 0;
      this.turnTarget = null;
      this.viaIndex = 0;
    }
    const cur = this.script[this.i];
    const input = { dir: new THREE.Vector3(), speed: cur.speed ?? 0, jump: false, crouch: !!cur.crouch, aim: !!cur.strafe, strafe: !!cur.strafe, faceYaw: loco.yaw, turnTo: null, aimPitch: 0 };
    if (cur.turn !== undefined) {
      if (this.turnTarget === null) this.turnTarget = loco.yaw + cur.turn;
      input.turnTo = this.turnTarget;
    }
    const goal = cur.via && (this.viaIndex ?? 0) < cur.via.length ? cur.via[this.viaIndex ?? 0] : cur.to;
    if (goal && input.speed > 0) {
      const d = goal.clone().sub(loco.pos).setY(0);
      if (d.length() < 0.35) {
        if (cur.via && (this.viaIndex ?? 0) < cur.via.length) this.viaIndex = (this.viaIndex ?? 0) + 1;
        else input.speed = 0;
      } else input.dir.copy(d.normalize());
      if (cur.strafe) input.faceYaw = Math.atan2(-loco.pos.x, -loco.pos.z) + Math.PI; // keep facing outward while strafing
    }
    if (cur.jumpAt !== undefined && this.stepT >= cur.jumpAt && this.stepT - dt < cur.jumpAt) input.jump = true;
    return input;
  }
}
