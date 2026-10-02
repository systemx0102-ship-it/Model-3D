// MakeHuman .target files: sparse per-vertex offsets ("index dx dy dz" per line).
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

export function loadTarget(file) {
  if (cache.has(file)) return cache.get(file);
  const idx = [];
  const d = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line[0] === '#') continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    idx.push(+p[0]);
    d.push(+p[1], +p[2], +p[3]);
  }
  const t = { name: path.basename(file, '.target'), idx: Int32Array.from(idx), d: Float32Array.from(d) };
  cache.set(file, t);
  return t;
}

export function applyTarget(positions, target, weight) {
  if (!weight) return;
  const { idx, d } = target;
  for (let i = 0; i < idx.length; i++) {
    const o = idx[i] * 3;
    positions[o] += d[i * 3] * weight;
    positions[o + 1] += d[i * 3 + 1] * weight;
    positions[o + 2] += d[i * 3 + 2] * weight;
  }
}

/** Dense delta array (n*3) of a weighted sum of targets — used to bake blendshapes. */
export function denseDelta(vertexCount, entries) {
  const out = new Float32Array(vertexCount * 3);
  for (const [target, w] of entries) applyTarget(out, target, w);
  return out;
}
