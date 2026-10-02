// BVH reader (hierarchy + frames). Rotations are returned as per-joint Euler channel lists.
import fs from 'node:fs';

export function readBvh(file) {
  const tokens = fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean);
  let i = 0;
  const joints = [];
  const stack = [];
  const next = () => tokens[i++];
  if (next() !== 'HIERARCHY') throw new Error('not a BVH file');
  while (i < tokens.length) {
    const t = next();
    if (t === 'ROOT' || t === 'JOINT') {
      const j = { name: next(), parent: stack.length ? stack.at(-1) : -1, offset: [0, 0, 0], channels: [], index: joints.length };
      joints.push(j);
      stack.push(j.index);
      next(); // {
    } else if (t === 'End') {
      next(); // Site
      next(); // {
      stack.push(-2);
    } else if (t === 'OFFSET') {
      const o = [+next(), +next(), +next()];
      if (stack.at(-1) >= 0) joints[stack.at(-1)].offset = o;
    } else if (t === 'CHANNELS') {
      const n = +next();
      const ch = [];
      for (let k = 0; k < n; k++) ch.push(next());
      joints[stack.at(-1)].channels = ch;
    } else if (t === '}') {
      stack.pop();
    } else if (t === 'MOTION') break;
  }
  next(); // Frames:
  const frameCount = +next();
  next(); next(); // Frame Time:
  const frameTime = +next();
  const width = joints.reduce((s, j) => s + j.channels.length, 0);
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const row = new Float32Array(width);
    for (let k = 0; k < width; k++) row[k] = +next();
    frames.push(row);
  }
  return { joints, frames, frameTime };
}
