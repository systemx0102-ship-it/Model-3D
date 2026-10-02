// Skin weights: MakeHuman CC0 weights remapped onto the production skeleton, with the long
// limb bones re-partitioned onto twist helpers so forearm pronation / limb roll spreads
// smoothly along the limb instead of candy-wrapping at the joint.
import * as THREE from 'three';
import { weightMap } from './rig.mjs';

const hat = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));

// [boneWithWeights, [[helperOrSelf, tPeak]...]] — hat-function partition along the limb.
const TWIST_PLAN = [
  ['upperarm', 'upperarm', 'lowerarm', [['upperarm_twist_01', 0.3], ['upperarm_twist_02', 0.62], ['upperarm', 0.9]]],
  ['lowerarm', 'lowerarm', 'hand', [['lowerarm', 0.15], ['lowerarm_twist_01', 0.45], ['lowerarm_twist_02', 0.8]]],
  ['thigh', 'thigh', 'calf', [['thigh_twist_01', 0.3], ['thigh_twist_02', 0.6], ['thigh', 0.88]]],
  ['calf', 'calf', 'foot', [['calf', 0.2], ['calf_twist_01', 0.5], ['calf_twist_02', 0.8]]],
];

function partition(t, nodes) {
  // piecewise-linear "hat" basis through the node peaks; sums to 1
  const w = new Array(nodes.length).fill(0);
  if (t <= nodes[0][1]) w[0] = 1;
  else if (t >= nodes.at(-1)[1]) w[nodes.length - 1] = 1;
  else
    for (let i = 0; i + 1 < nodes.length; i++)
      if (t >= nodes[i][1] && t <= nodes[i + 1][1]) {
        const u = hat(t, nodes[i][1], nodes[i + 1][1]);
        w[i] = 1 - u;
        w[i + 1] = u;
      }
  return w;
}

/**
 * @returns per-source-vertex Map(boneName -> weight) for all MH vertices (sparse array)
 */
export function remapWeights(mhWeights, srcPositions, rig) {
  const map = weightMap();
  const perVertex = [];
  const unmapped = new Set();
  for (const [mhBone, list] of Object.entries(mhWeights)) {
    let target = map[mhBone];
    if (!target && map.__face.test(mhBone)) target = 'head';
    if (!target) {
      unmapped.add(mhBone);
      continue;
    }
    for (const [v, w] of list) {
      const m = (perVertex[v] ??= new Map());
      m.set(target, (m.get(target) ?? 0) + w);
    }
  }
  if (unmapped.size) throw new Error(`unmapped MH bones: ${[...unmapped].join(', ')}`);

  const p = new THREE.Vector3();
  for (const side of ['l', 'r']) {
    for (const [bone, from, to, nodes] of TWIST_PLAN) {
      const name = `${bone}_${side}`;
      const a = rig.byName.get(`${from}_${side}`).head;
      const b = rig.byName.get(`${to}_${side}`).head;
      const ab = new THREE.Vector3().subVectors(b, a);
      const len2 = ab.lengthSq();
      perVertex.forEach((m, v) => {
        const W = m?.get(name);
        if (!W) return;
        p.fromArray(srcPositions, v * 3).sub(a);
        const t = Math.min(1, Math.max(0, p.dot(ab) / len2));
        m.delete(name);
        partition(t, nodes).forEach((wi, i) => {
          if (wi <= 0) return;
          const n = `${nodes[i][0]}_${side}`;
          m.set(n, (m.get(n) ?? 0) + W * wi);
        });
      });
    }
  }
  return perVertex;
}

/** Top-4 influences, renormalised; vertices without data are bound rigidly to `fallback`. */
export function packWeights(perVertex, srcIndices, rig, fallback = 'head') {
  const n = srcIndices.length;
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    const m = perVertex[srcIndices[i]];
    let entries = m ? [...m.entries()].filter(([, w]) => w > 1e-4) : [];
    if (!entries.length) entries = [[fallback, 1]];
    entries.sort((x, y) => y[1] - x[1]);
    if (entries.length > 4) dropped += entries.slice(4).reduce((s, [, w]) => s + w, 0);
    entries = entries.slice(0, 4);
    const sum = entries.reduce((s, [, w]) => s + w, 0);
    entries.forEach(([b, w], k) => {
      const bone = rig.byName.get(b);
      if (!bone) throw new Error(`weight on unknown bone ${b}`);
      joints[i * 4 + k] = bone.index;
      weights[i * 4 + k] = w / sum;
    });
  }
  return { joints, weights, droppedWeight: dropped };
}
