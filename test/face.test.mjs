// Facial animation data: every expression / viseme drives real ARKit blendshapes of the asset,
// the text-to-viseme timeline is well formed, and the controller output stays in range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EXPRESSIONS, VISEMES, textToVisemes, FaceController } from '../src/anim/face.js';
import { ARKIT } from '../tools/lib/face.mjs';

const metaFile = new URL('../public/character/character.json', import.meta.url);
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;

test('the asset carries all 52 ARKit blendshapes', { skip: !meta && 'run npm run build:character first' }, () => {
  const names = Object.keys(ARKIT);
  assert.equal(names.length, 52);
  for (const n of names) assert.ok(meta.blendshapes.includes(n), `missing blendshape ${n}`);
});

test('expressions and visemes only use ARKit names', () => {
  const valid = new Set(Object.keys(ARKIT));
  for (const [name, w] of Object.entries({ ...EXPRESSIONS, ...VISEMES }))
    for (const [k, v] of Object.entries(w)) {
      assert.ok(valid.has(k), `${name} uses unknown shape ${k}`);
      assert.ok(v >= 0 && v <= 1, `${name}.${k} = ${v}`);
    }
  for (const e of ['neutral', 'happy', 'sad', 'angry', 'surprised', 'afraid', 'disgusted', 'confused', 'pain', 'subtleSmile']) assert.ok(EXPRESSIONS[e], `expression ${e}`);
});

test('text to visemes: ordered timeline of known visemes, ends in silence', () => {
  const { events, duration } = textToVisemes('Hello there, follow me to the boat!');
  assert.ok(events.length > 10);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t >= events[i - 1].t);
  for (const e of events) assert.ok(VISEMES[e.v], `unknown viseme ${e.v}`);
  assert.equal(events.at(-1).v, 'sil');
  assert.ok(duration > events.at(-1).t);
  // bilabials close the lips
  assert.ok(events.some((e) => e.v === 'PP'));
});

test('face controller: blinks happen, weights stay in [0, 1], speech moves the jaw', () => {
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const face = new FaceController(meta ?? {}, rng);
  face.setExpression('happy');
  face.speak('Open the gate and wait for me');
  let maxBlink = 0, maxJaw = 0;
  for (let i = 0; i < 600; i++) {
    face.update(1 / 60, { yaw: 0.2 * Math.sin(i / 50), pitch: 0, distance: 1.5 });
    for (const [k, v] of Object.entries(face.weights)) assert.ok(v >= -1e-6 && v <= 1 + 1e-6 && Number.isFinite(v), `${k} = ${v}`);
    maxBlink = Math.max(maxBlink, face.weights.eyeBlinkLeft ?? 0);
    maxJaw = Math.max(maxJaw, face.weights.jawOpen ?? 0);
  }
  assert.ok(maxBlink > 0.8, 'no full blink in 10 s');
  assert.ok(maxJaw > 0.25, 'speech never opened the jaw');
});
