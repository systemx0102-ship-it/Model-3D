// MakeHuman skeleton (CC0 data): joint positions are centroids of reference vertices,
// so they follow every shape target applied to the base mesh.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

export function loadMhSkeleton(mhDir) {
  const skel = JSON.parse(fs.readFileSync(path.join(mhDir, 'rigs/default.mhskel'), 'utf8'));
  const weights = JSON.parse(fs.readFileSync(path.join(mhDir, 'rigs/default_weights.mhw'), 'utf8')).weights;
  return { skel, weights };
}

export function jointPosition(skel, positions, jointName) {
  const refs = skel.joints[jointName];
  if (!refs) throw new Error(`unknown MH joint ${jointName}`);
  const p = new THREE.Vector3();
  for (const i of refs) p.x += positions[i * 3], p.y += positions[i * 3 + 1], p.z += positions[i * 3 + 2];
  return p.multiplyScalar(1 / refs.length);
}

/** {name: {head, tail, parent, planeNormal}} in mesh coordinates for every MH bone. */
export function mhBones(skel, positions) {
  const out = {};
  for (const [name, b] of Object.entries(skel.bones)) {
    const head = jointPosition(skel, positions, b.head);
    const tail = jointPosition(skel, positions, b.tail);
    let planeNormal = null;
    const plane = skel.planes[b.rotation_plane];
    if (plane) {
      const [a, c, d] = plane.map((j) => jointPosition(skel, positions, j));
      planeNormal = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(d, c)).normalize();
    }
    out[name] = { name, head, tail, parent: b.parent, planeNormal };
  }
  return out;
}
