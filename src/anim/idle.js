// Living idle: breathing, weight shifts, postural sway, shoulder/arm micro-motion, fingers,
// occasional swallowing. Everything is driven by smooth noise and randomised timers so the
// character never repeats or freezes. Values are consumed by the animator as additive offsets.
import { smoothDamp } from './locomotion.js';

// 1D smooth value noise
function noise1(t, seed) {
  const i = Math.floor(t), f = t - i;
  const h = (n) => {
    const s = Math.sin((n + seed * 17.13) * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = f * f * (3 - 2 * f);
  return (h(i) * (1 - u) + h(i + 1) * u) * 2 - 1;
}

export class IdleLayer {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.t = 0;
    this.breathPhase = 0;
    this.breath = 0;
    this.shift = 0.2;
    this.shiftTarget = 0.2;
    this.shiftVel = { v: 0 };
    this.nextShift = 4 + rng() * 5;
    this.nextSwallow = 18 + rng() * 25;
    this.swallow = 0;
    this.nextShoulder = 6 + rng() * 10;
    this.shoulderRoll = 0;
  }

  /**
   * @param dt
   * @param exertion  0..1 (recent running) -> faster, deeper breathing
   * @param still     0..1 how much the character is standing (fades weight shifts while moving)
   */
  update(dt, exertion, still) {
    const r = this.rng;
    this.t += dt;
    // breathing: 12-14 bpm at rest, up to ~40 bpm after sprinting; inhale shorter than exhale
    const bpm = 13 + 27 * exertion;
    this.breathPhase = (this.breathPhase + (bpm / 60) * dt) % 1;
    const p = this.breathPhase;
    const inhale = 0.42;
    const b = p < inhale ? 0.5 - 0.5 * Math.cos((p / inhale) * Math.PI) : 0.5 + 0.5 * Math.cos(((p - inhale) / (1 - inhale)) * Math.PI);
    this.breath = b;
    this.depth = 0.55 + 0.45 * exertion + 0.08 * noise1(this.t * 0.07, 3);

    // weight shifts between feet
    this.nextShift -= dt;
    if (this.nextShift <= 0) {
      this.nextShift = 5 + r() * 7;
      const choices = [-1, -0.6, 0.15, 0.6, 1];
      this.shiftTarget = choices[Math.floor(r() * choices.length)];
    }
    this.shift = smoothDamp(this.shift, this.shiftTarget, this.shiftVel, 1.1, dt);

    // swallowing every ~20-45 s (larynx rise, slight chin dip, lips press)
    this.nextSwallow -= dt;
    if (this.nextSwallow <= 0 && this.swallow === 0) {
      this.swallow = 1e-4;
      this.nextSwallow = 20 + r() * 25;
    }
    if (this.swallow > 0) {
      this.swallow += dt / 0.75;
      if (this.swallow >= 1) this.swallow = 0;
    }
    this.nextShoulder -= dt;
    if (this.nextShoulder <= 0) {
      this.nextShoulder = 8 + r() * 14;
      this.shoulderRoll = 1e-4;
    }
    if (this.shoulderRoll > 0) {
      this.shoulderRoll += dt / 1.6;
      if (this.shoulderRoll >= 1) this.shoulderRoll = 0;
    }

    const t = this.t;
    const w = still;
    const swallowCurve = this.swallow > 0 ? Math.sin(this.swallow * Math.PI) : 0;
    return {
      breath: b * this.depth,
      breathChest: Math.min(1, Math.max(0, (b - 0.25) / 0.75)) * this.depth,
      breathBelly: Math.min(1, b / 0.6) * this.depth,
      pelvisShift: (this.shift * 0.032 + noise1(t * 0.13, 1) * 0.006) * w,
      pelvisRoll: this.shift * 0.045 * w,
      pelvisY: -Math.abs(this.shift) * 0.006 * w,
      swayPitch: noise1(t * 0.11, 2) * 0.012 + 0.006 * Math.sin(t * 0.4),
      swayRoll: noise1(t * 0.09, 4) * 0.008,
      spineTwist: noise1(t * 0.07, 5) * 0.02 * w,
      shoulderRoll: this.shoulderRoll > 0 ? Math.sin(this.shoulderRoll * Math.PI) : 0,
      armSway: noise1(t * 0.23, 6) * 0.02,
      fingers: noise1(t * 0.35, 7) * 0.06,
      fingerSpread: noise1(t * 0.21, 8) * 0.04,
      swallow: swallowCurve,
      headNoise: [noise1(t * 0.31, 9) * 0.012, noise1(t * 0.27, 10) * 0.01],
    };
  }
}
