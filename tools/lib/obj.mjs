// Minimal Wavefront OBJ reader that keeps groups and per-corner UV indices
// (MakeHuman meshes are quad-dominant and rely on group names for parts/helpers).
import fs from 'node:fs';

export function readObj(file) {
  const text = fs.readFileSync(file, 'utf8');
  const pos = [];
  const uv = [];
  const faces = []; // { v: int[], t: int[], g: string }
  const groupOrder = [];
  let group = 'default';
  for (const line of text.split('\n')) {
    if (line.length < 2) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 35) continue; // '#'
    const parts = line.trim().split(/\s+/);
    switch (parts[0]) {
      case 'v':
        pos.push(+parts[1], +parts[2], +parts[3]);
        break;
      case 'vt':
        uv.push(+parts[1], +parts[2]);
        break;
      case 'g':
        group = parts[1] ?? 'default';
        if (!groupOrder.includes(group)) groupOrder.push(group);
        break;
      case 'f': {
        const v = [];
        const t = [];
        for (let i = 1; i < parts.length; i++) {
          const [a, b] = parts[i].split('/');
          v.push(+a - 1);
          t.push(b ? +b - 1 : -1);
        }
        faces.push({ v, t, g: group });
        break;
      }
      default:
        break;
    }
  }
  return { positions: Float32Array.from(pos), uvs: Float32Array.from(uv), faces, groups: groupOrder };
}

/** Vertex indices referenced by faces of groups matching `test`. */
export function groupVertices(obj, test) {
  const set = new Set();
  for (const f of obj.faces) if (test(f.g)) for (const v of f.v) set.add(v);
  return [...set].sort((a, b) => a - b);
}
