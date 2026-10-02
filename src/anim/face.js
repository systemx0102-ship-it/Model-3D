// Facial animation: eyes (blinks, saccades, pursuit, vergence, lid follow), emotional
// expressions, micro-expressions and viseme lip sync. Output is a set of ARKit-named blendshape
// weights plus per-eye yaw/pitch (radians, relative to the head).
import * as THREE from 'three';

export const EXPRESSIONS = {
  neutral: {},
  subtleSmile: { mouthSmileLeft: 0.5, mouthSmileRight: 0.4, cheekSquintLeft: 0.2, cheekSquintRight: 0.15, eyeSquintLeft: 0.12, eyeSquintRight: 0.09, mouthDimpleLeft: 0.2, mouthPressLeft: 0.08 },
  happy: { mouthSmileLeft: 1.0, mouthSmileRight: 0.94, cheekSquintLeft: 0.62, cheekSquintRight: 0.56, eyeSquintLeft: 0.36, eyeSquintRight: 0.32, mouthUpperUpLeft: 0.32, mouthUpperUpRight: 0.28, mouthLowerDownLeft: 0.18, mouthLowerDownRight: 0.16, jawOpen: 0.16, mouthDimpleLeft: 0.3, mouthDimpleRight: 0.25, mouthStretchLeft: 0.12, mouthStretchRight: 0.1, browInnerUp: 0.08 },
  sad: { browInnerUp: 0.78, browDownLeft: 0.12, browDownRight: 0.15, mouthFrownLeft: 0.55, mouthFrownRight: 0.5, mouthShrugLower: 0.32, mouthPressLeft: 0.15, mouthPressRight: 0.12, eyeSquintLeft: 0.15, eyeSquintRight: 0.18, eyeLookDownLeft: 0.12, eyeLookDownRight: 0.12 },
  angry: { browDownLeft: 0.85, browDownRight: 0.8, eyeSquintLeft: 0.35, eyeSquintRight: 0.38, eyeWideLeft: 0.18, eyeWideRight: 0.15, noseSneerLeft: 0.35, noseSneerRight: 0.3, mouthPressLeft: 0.45, mouthPressRight: 0.4, jawForward: 0.12, mouthFrownLeft: 0.2, mouthFrownRight: 0.22 },
  surprised: { browInnerUp: 0.85, browOuterUpLeft: 0.78, browOuterUpRight: 0.82, eyeWideLeft: 0.75, eyeWideRight: 0.72, jawOpen: 0.38, mouthFunnel: 0.15 },
  afraid: { browInnerUp: 0.9, browOuterUpLeft: 0.4, browOuterUpRight: 0.36, browDownLeft: 0.15, browDownRight: 0.15, eyeWideLeft: 0.82, eyeWideRight: 0.8, mouthStretchLeft: 0.55, mouthStretchRight: 0.5, jawOpen: 0.16 },
  disgusted: { noseSneerLeft: 0.75, noseSneerRight: 0.62, mouthUpperUpLeft: 0.55, mouthUpperUpRight: 0.4, browDownLeft: 0.42, browDownRight: 0.35, eyeSquintLeft: 0.4, eyeSquintRight: 0.35, cheekSquintLeft: 0.3, cheekSquintRight: 0.25, mouthFrownLeft: 0.3, mouthShrugLower: 0.2 },
  confused: { browDownLeft: 0.5, browOuterUpRight: 0.55, browInnerUp: 0.15, mouthLeft: 0.25, mouthPressRight: 0.2, eyeSquintLeft: 0.22, mouthRollLower: 0.1 },
  pain: { browDownLeft: 0.6, browDownRight: 0.55, browInnerUp: 0.5, eyeSquintLeft: 0.7, eyeSquintRight: 0.65, eyeBlinkLeft: 0.35, eyeBlinkRight: 0.3, noseSneerLeft: 0.5, noseSneerRight: 0.45, mouthStretchLeft: 0.5, mouthStretchRight: 0.45, mouthUpperUpLeft: 0.3, mouthUpperUpRight: 0.28, cheekSquintLeft: 0.5, cheekSquintRight: 0.45, jawOpen: 0.1 },
};
export const EXPRESSION_HEAD = { confused: { roll: 0.09, pitch: -0.03 }, sad: { pitch: 0.08 }, angry: { pitch: 0.05 }, afraid: { pitch: -0.03 }, happy: { roll: -0.03 } };

// Oculus/Meta viseme set -> ARKit weights
export const VISEMES = {
  sil: {},
  PP: { mouthPressLeft: 0.55, mouthPressRight: 0.55, mouthRollLower: 0.18, mouthRollUpper: 0.12, mouthClose: 0.15 },
  FF: { mouthRollLower: 0.5, mouthUpperUpLeft: 0.18, mouthUpperUpRight: 0.18, jawOpen: 0.06 },
  TH: { tongueOut: 0.35, jawOpen: 0.14 },
  DD: { jawOpen: 0.14, mouthStretchLeft: 0.12, mouthStretchRight: 0.12 },
  kk: { jawOpen: 0.2, mouthStretchLeft: 0.16, mouthStretchRight: 0.16 },
  CH: { mouthFunnel: 0.45, mouthPucker: 0.2, jawOpen: 0.1, mouthShrugUpper: 0.15 },
  SS: { mouthStretchLeft: 0.32, mouthStretchRight: 0.32, jawOpen: 0.05, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 },
  nn: { jawOpen: 0.13, mouthStretchLeft: 0.08, mouthStretchRight: 0.08 },
  RR: { mouthFunnel: 0.28, mouthPucker: 0.25, jawOpen: 0.12 },
  aa: { jawOpen: 0.52, mouthLowerDownLeft: 0.18, mouthLowerDownRight: 0.18 },
  E: { jawOpen: 0.3, mouthStretchLeft: 0.32, mouthStretchRight: 0.32, mouthSmileLeft: 0.14, mouthSmileRight: 0.14 },
  ih: { jawOpen: 0.2, mouthStretchLeft: 0.24, mouthStretchRight: 0.24, mouthSmileLeft: 0.1, mouthSmileRight: 0.1 },
  oh: { jawOpen: 0.36, mouthFunnel: 0.5, mouthPucker: 0.1 },
  ou: { mouthPucker: 0.72, mouthFunnel: 0.32, jawOpen: 0.12 },
};

/** Rough English grapheme -> viseme timeline (seconds). */
export function textToVisemes(text, rate = 1) {
  const rules = [
    [/^(th)/, 'TH', 0.09], [/^(sh|ch|tch|j|ge)/, 'CH', 0.1], [/^(ee|ea|ie|y$)/, 'ih', 0.12], [/^(oo|ou|w|ew)/, 'ou', 0.12],
    [/^(oa|ow|o)/, 'oh', 0.12], [/^(ai|ay|a)/, 'aa', 0.12], [/^(e)/, 'E', 0.1], [/^(i)/, 'ih', 0.09], [/^(u)/, 'oh', 0.1],
    [/^[pbm]/, 'PP', 0.08], [/^[fv]/, 'FF', 0.08], [/^[td]/, 'DD', 0.06], [/^[kgcq]/, 'kk', 0.07], [/^[szx]/, 'SS', 0.08],
    [/^[nl]/, 'nn', 0.07], [/^r/, 'RR', 0.08], [/^h/, 'sil', 0.05], [/^y/, 'ih', 0.06],
  ];
  const out = [];
  let t = 0.05;
  let s = text.toLowerCase();
  while (s.length) {
    if (/^[\s]/.test(s)) {
      t += 0.06 / rate;
      s = s.slice(1);
      continue;
    }
    if (/^[.,!?;:]/.test(s)) {
      out.push({ v: 'sil', t, d: 0.22 / rate });
      t += 0.24 / rate;
      s = s.slice(1);
      continue;
    }
    let matched = false;
    for (const [re, v, d] of rules) {
      const m = s.match(re);
      if (m) {
        out.push({ v, t, d: d / rate });
        t += (d * 0.85) / rate;
        s = s.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) s = s.slice(1);
  }
  out.push({ v: 'sil', t, d: 0.2 });
  return { events: out, duration: t + 0.25 };
}

const lerp = THREE.MathUtils.lerp;

export class FaceController {
  constructor(meta, rng = Math.random) {
    this.rng = rng;
    this.lookAngles = meta.eyeLook ?? { up: 0.42, down: 0.45, in: 0.5, out: 0.5 };
    this.weights = {};
    this.expr = {}; // current smoothed expression weights
    this.exprTarget = 'neutral';
    this.exprIntensity = 1;
    this.t = 0;
    this.nextBlink = 1 + rng() * 2;
    this.blinks = []; // active blink envelopes {t, amp, lag}
    this.eyes = { yaw: 0, pitch: 0, yawR: 0, pitchR: 0 };
    this.sacc = null;
    this.fix = new THREE.Vector2(); // fixation offset around the look target (radians)
    this.nextFix = 0.5;
    this.micro = null;
    this.nextMicro = 3 + rng() * 4;
    this.speech = null;
    this.pupil = 0.33;
    this.restLid = 0.07;
  }

  setExpression(name, intensity = 1) {
    this.exprTarget = name;
    this.exprIntensity = intensity;
    if (name !== 'neutral' && this.rng() < 0.7) this.triggerBlink(0.15);
  }

  speak(text, rate = 1) {
    this.speech = { ...textToVisemes(text, rate), t: 0 };
    return this.speech.duration;
  }

  triggerBlink(delay = 0) {
    const r = this.rng;
    this.blinks.push({ t: -delay, amp: 0.96 + 0.04 * r(), lagR: 0.004 + 0.012 * r(), dur: 0.22 + 0.08 * r() });
  }

  /**
   * @param dt
   * @param gaze { yaw, pitch, distance } of the look target relative to the head (radians, m)
   * @param ctx  { exertion, light (0..1 scene brightness), talking }
   */
  update(dt, gaze, ctx = {}) {
    const r = this.rng;
    this.t += dt;
    const W = {};
    const add = (k, v) => (W[k] = (W[k] ?? 0) + v);

    // ---- expression (each weight springs toward its target: no popping) -----------------
    const target = EXPRESSIONS[this.exprTarget] ?? {};
    const keys = new Set([...Object.keys(target), ...Object.keys(this.expr)]);
    for (const k of keys) {
      const goal = (target[k] ?? 0) * this.exprIntensity;
      const cur = this.expr[k] ?? 0;
      this.expr[k] = cur + (goal - cur) * (1 - Math.exp(-dt / 0.12));
      if (Math.abs(this.expr[k]) < 1e-4 && !target[k]) delete this.expr[k];
      else add(k, this.expr[k]);
    }

    // ---- micro-expressions: small, brief, asymmetric ---------------------------------------
    this.nextMicro -= dt;
    if (this.nextMicro <= 0) {
      this.nextMicro = 3.5 + r() * 6;
      const set = [
        { browInnerUp: 0.09 }, { browOuterUpLeft: 0.12 }, { mouthSmileLeft: 0.08, mouthSmileRight: 0.04 },
        { mouthPressLeft: 0.12, mouthPressRight: 0.1 }, { noseSneerLeft: 0.06 }, { mouthRollLower: 0.1 }, { cheekSquintRight: 0.07 },
        { mouthLeft: 0.06 }, { browDownRight: 0.08 },
      ];
      this.micro = { w: set[Math.floor(r() * set.length)], t: 0, d: 0.5 + r() * 0.9 };
    }
    if (this.micro) {
      this.micro.t += dt;
      const u = this.micro.t / this.micro.d;
      if (u >= 1) this.micro = null;
      else for (const [k, v] of Object.entries(this.micro.w)) add(k, v * Math.sin(u * Math.PI));
    }

    // ---- gaze: fixations, saccades (main sequence), micro-saccades, drift, vergence ----------
    this.nextFix -= dt;
    if (this.nextFix <= 0) {
      const big = r() < 0.12;
      this.nextFix = big ? 0.6 + r() * 0.8 : 0.35 + r() * 1.6;
      const amp = big ? 0.18 + r() * 0.25 : 0.015 + r() * 0.05;
      const a = r() * Math.PI * 2;
      this.fix.set(Math.cos(a) * amp, Math.sin(a) * amp * 0.6);
      if (big && r() < 0.5) this.triggerBlink(0.02);
    }
    const tgtYaw = THREE.MathUtils.clamp(gaze.yaw + this.fix.x, -0.6, 0.6);
    const tgtPitch = THREE.MathUtils.clamp(gaze.pitch + this.fix.y, -0.5, 0.42);
    const e = this.eyes;
    const err = Math.hypot(tgtYaw - e.yaw, tgtPitch - e.pitch);
    if (!this.sacc && err > 0.012) {
      const deg = (err * 180) / Math.PI;
      this.sacc = { t: 0, d: 0.022 + 0.0024 * deg, y0: e.yaw, p0: e.pitch, y1: tgtYaw, p1: tgtPitch };
    }
    if (this.sacc) {
      const s = this.sacc;
      s.t += dt;
      const u = Math.min(1, s.t / s.d);
      const m = u * u * u * (10 - 15 * u + 6 * u * u); // minimum-jerk profile
      e.yaw = lerp(s.y0, s.y1, m);
      e.pitch = lerp(s.p0, s.p1, m);
      if (u >= 1) this.sacc = null;
    } else {
      // smooth pursuit of a slowly moving target + fixational drift
      const k = 1 - Math.exp(-dt / 0.06);
      e.yaw += (tgtYaw - e.yaw) * k + (r() - 0.5) * 0.0006;
      e.pitch += (tgtPitch - e.pitch) * k + (r() - 0.5) * 0.0006;
    }
    // vergence: each eye converges on the target (interocular ~6 cm)
    const verg = Math.atan2(0.031, Math.max(0.25, gaze.distance ?? 2));
    this.eyeAngles = { l: { yaw: e.yaw - verg, pitch: e.pitch }, r: { yaw: e.yaw + verg, pitch: e.pitch } };
    // lids follow the eyes (ARKit eyeLook* carry the lid deformation authored with the eye unit)
    for (const [side, S, outSign] of [['l', 'Left', 1], ['r', 'Right', -1]]) {
      const a = this.eyeAngles[side];
      add(`eyeLookUp${S}`, Math.max(0, a.pitch) / this.lookAngles.up);
      add(`eyeLookDown${S}`, Math.max(0, -a.pitch) / this.lookAngles.down);
      const outward = a.yaw * outSign;
      add(`eyeLookOut${S}`, Math.max(0, outward) / this.lookAngles.out);
      add(`eyeLookIn${S}`, Math.max(0, -outward) / this.lookAngles.in);
    }

    // ---- blinks: irregular (log-normal intervals), occasional doubles, left/right offset -----
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      const n = Math.exp(Math.log(3.2) + 0.55 * gauss(r));
      this.nextBlink = THREE.MathUtils.clamp(n, 0.8, 10) * (ctx.talking ? 0.8 : 1);
      this.triggerBlink();
      if (r() < 0.1) this.triggerBlink(0.32);
    }
    let bl = 0, br = 0;
    this.blinks = this.blinks.filter((b) => {
      b.t += dt;
      const env = (t) => {
        if (t < 0) return 0;
        const close = b.dur * 0.3, hold = b.dur * 0.12;
        if (t < close) return Math.sin((t / close) * Math.PI * 0.5) ** 2;
        if (t < close + hold) return 1;
        const o = (t - close - hold) / (b.dur - close - hold);
        return o >= 1 ? 0 : 1 - o * o * (3 - 2 * o);
      };
      bl = Math.max(bl, env(b.t) * b.amp);
      br = Math.max(br, env(b.t - b.lagR) * b.amp * 0.985);
      return b.t < b.dur + 0.05;
    });
    // relaxed upper lids sit slightly lower; lids also drop a little when looking down
    const rest = this.restLid + 0.04 * (ctx.exertion ?? 0);
    add('eyeBlinkLeft', Math.max(bl, rest));
    add('eyeBlinkRight', Math.max(br, rest * 1.08));

    // ---- speech (visemes with coarticulation: overlapping raised-cosine envelopes) -----------
    if (this.speech) {
      const sp = this.speech;
      sp.t += dt;
      for (const ev of sp.events) {
        const a = sp.t - ev.t;
        const half = ev.d * 0.9;
        if (a < -half || a > ev.d + half) continue;
        const u = (a + half) / (ev.d + 2 * half);
        const env = Math.sin(u * Math.PI) ** 2;
        for (const [k, v] of Object.entries(VISEMES[ev.v] ?? {})) add(k, v * env);
      }
      if (sp.t > sp.duration) this.speech = null;
    }

    // ---- pupil: light adaptation + arousal, with hippus -------------------------------------
    const light = ctx.light ?? 0.6;
    const arousal = ['surprised', 'afraid', 'angry', 'pain'].includes(this.exprTarget) ? 0.08 : 0;
    const goal = THREE.MathUtils.clamp(0.48 - 0.24 * light + arousal + 0.06 * (ctx.exertion ?? 0), 0.24, 0.55);
    this.pupil += (goal - this.pupil) * (1 - Math.exp(-dt / 0.35));
    this.pupilOut = this.pupil + 0.006 * Math.sin(this.t * 3.1);

    for (const k in W) W[k] = THREE.MathUtils.clamp(W[k], 0, 1);
    this.weights = W;
    this.headOffset = EXPRESSION_HEAD[this.exprTarget] ?? {};
    return W;
  }
}

function gauss(r) {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
