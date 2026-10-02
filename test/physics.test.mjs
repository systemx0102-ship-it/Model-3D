// Cloth and hair solvers: frame-rate independence (30/60/120 FPS through the fixed-step driver),
// determinism, inextensibility and stability under violent input (no NaN, no explosion).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClothSim } from '../src/physics/cloth.js';
import { StrandSim } from '../src/physics/strands.js';
import { FixedStep, lerpRigid } from '../src/core/fixedstep.js';

// anchor bone trajectory: walking forward with sway and yaw oscillation (column-major 4x4)
function anchorAt(t, violent = false) {
  const yaw = violent ? 9 * Math.sin(3.1 * t) : 0.5 * Math.sin(1.5 * t);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const x = violent ? 1.5 * Math.sin(7 * t) : 0.06 * Math.sin(2 * t);
  const y = 1 + (violent ? 0.8 * Math.abs(Math.sin(5 * t)) : 0.03 * Math.sin(4 * t));
  const z = (violent ? 4 : 1.4) * t;
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1];
}

function makeCloth() {
  const W = 14, H = 12, dx = 0.03, L = 0.36;
  const rest = [];
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const a = Math.PI * (0.55 + (0.9 * c) / (W - 1)); // half ring behind the anchor
      rest.push(Math.cos(a) * 0.17, -r * (L / (H - 1)), Math.sin(a) * 0.17 - 0.02 * (c % 2));
    }
  return new ClothSim({ restLocal: Float32Array.from(rest), grid: { W, H, dx, lengths: Array(W).fill(L) }, pins: [...Array(W).keys()] });
}

function makeHair(G = 24, N = 16) {
  const guides = [];
  for (let g = 0; g < G; g++) {
    const rest = new Float32Array(N * 3);
    const a = (g / G) * Math.PI * 2;
    for (let i = 0; i < N; i++) {
      rest[i * 3] = Math.sin(a) * (0.09 + i * 0.002);
      rest[i * 3 + 1] = 0.05 - i * 0.02;
      rest[i * 3 + 2] = Math.cos(a) * (0.09 + i * 0.002) - i * 0.004;
    }
    guides.push({ rest, zone: 'back', seed: g + 1 });
  }
  return new StrandSim(guides, {}, { iterations: 3 });
}

// world colliders that follow the anchor (a "torso" capsule and two "thigh" capsules)
function collidersAt(t, violent) {
  const m = anchorAt(t, violent);
  const X = (x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  return [
    { type: 'capsule', a: X(0, -0.05, 0), b: X(0, 0.4, 0), r: 0.13 },
    { type: 'capsule', a: X(0.09, -0.1, 0), b: X(0.09, -0.5, 0.02), r: 0.075 },
    { type: 'capsule', a: X(-0.09, -0.1, 0), b: X(-0.09, -0.5, 0.02), r: 0.075 },
  ];
}

/** Drives a solver through FixedStep at the given render rate, like the runtime does. */
function run(sim, fps, seconds, { violent = false, wind = [0, 0, 0] } = {}) {
  const clock = new FixedStep(sim.dt ?? sim.p.dt);
  sim.wind = wind;
  let prevA = anchorAt(0, violent), prevC = collidersAt(0, violent);
  const m = new Array(16);
  const frames = Math.round(seconds * fps);
  for (let f = 1; f <= frames; f++) {
    const t = f / fps;
    const A = anchorAt(t, violent), C = collidersAt(t, violent);
    clock.advance(1 / fps, (u) => {
      lerpRigid(prevA, A, u, m);
      const L = (a, b) => a.map((x, i) => x + (b[i] - x) * u);
      sim.step(m, C.map((c, i) => ({ ...c, a: L(prevC[i].a, c.a), b: L(prevC[i].b, c.b) })));
    });
    prevA = A;
    prevC = C;
  }
  return sim.pos;
}

const meanDist = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 3) s += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
  return s / (a.length / 3);
};
const allFinite = (a) => a.every(Number.isFinite);

test('cloth: same motion gives the same drape at 30, 60 and 120 FPS', () => {
  const p60 = run(makeCloth(), 60, 3).slice();
  for (const fps of [30, 120]) {
    const p = run(makeCloth(), fps, 3);
    const d = meanDist(p, p60);
    assert.ok(d < 0.005, `cloth ${fps} FPS differs from 60 FPS by ${(d * 1000).toFixed(1)} mm on average`);
  }
});

test('cloth: deterministic and inextensible', () => {
  const a = run(makeCloth(), 60, 2).slice();
  const sim = makeCloth();
  const b = run(sim, 60, 2);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.ok(sim.maxStrain() < 0.02, `max strain ${sim.maxStrain()}`);
});

test('cloth: violent motion, gale-force wind and teleports stay finite and bounded', () => {
  const sim = makeCloth();
  run(sim, 30, 4, { violent: true, wind: [25, 0, -10] });
  assert.ok(allFinite(sim.pos), 'NaN in cloth');
  assert.ok(sim.maxStrain() < 0.05, `strain ${sim.maxStrain()}`);
  // teleport: the solver resets instead of slingshotting across the map
  const far = anchorAt(4, true);
  far[12] += 100;
  sim.step(far, []);
  assert.ok(allFinite(sim.pos));
  const { pos } = sim;
  for (let i = 0; i < pos.length; i += 3) assert.ok(Math.abs(pos[i] - far[12]) < 2, 'particle left behind after teleport');
});

test('hair: same motion gives the same result at 30, 60 and 120 FPS', () => {
  const p60 = run(makeHair(), 60, 3).slice();
  for (const fps of [30, 120]) {
    const d = meanDist(run(makeHair(), fps, 3), p60);
    assert.ok(d < 0.005, `hair ${fps} FPS differs from 60 FPS by ${(d * 1000).toFixed(1)} mm on average`);
  }
});

test('hair: strands keep their length and stay finite under violent motion', () => {
  const sim = makeHair();
  run(sim, 30, 4, { violent: true, wind: [30, 5, 0] });
  assert.ok(allFinite(sim.pos), 'NaN in hair');
  const { G, N, pos, restLen } = sim;
  let worst = 0;
  for (let g = 0; g < G; g++)
    for (let i = 1; i < N; i++) {
      const o = (g * N + i) * 3, p = o - 3;
      const d = Math.hypot(pos[o] - pos[p], pos[o + 1] - pos[p + 1], pos[o + 2] - pos[p + 2]);
      worst = Math.max(worst, Math.abs(d / restLen[g * N + i] - 1));
    }
  assert.ok(worst < 0.01, `segment stretch ${(worst * 100).toFixed(2)} %`);
});

test('hair: 60 Hz step reproduces the 120 Hz behaviour (converted per-step constants)', () => {
  const a = run(makeHair(), 60, 3).slice();
  const sim = makeHair();
  sim.setDt(1 / 60);
  const d = meanDist(run(sim, 60, 3), a);
  assert.ok(d < 0.03, `60 Hz vs 120 Hz solver: ${(d * 1000).toFixed(1)} mm`);
});

test('fixed step: substep count is independent of how frames are sliced', () => {
  let a = 0, b = 0;
  const ca = new FixedStep(1 / 120), cb = new FixedStep(1 / 120);
  for (let i = 0; i < 90; i++) ca.advance(1 / 30, () => a++);
  for (let i = 0; i < 360; i++) cb.advance(1 / 120, () => b++);
  assert.ok(Math.abs(a - b) <= 1, `${a} vs ${b}`);
});
