// Runtime level of detail: picks LOD0-3 from the character's size on screen (with hysteresis) and
// swaps index buffers built at asset time (same vertices, so skinning and blendshapes are
// untouched). Small facial parts drop out at range; hair keeps its silhouette with fewer, wider
// strands.
import * as THREE from 'three';

const SCREEN = [0.55, 0.27, 0.08]; // character height / viewport height thresholds for LOD 1, 2, 3
const HAIR = [
  { count: 1, width: 1 },
  { count: 0.5, width: 1.45 },
  { count: 0.22, width: 2.4 },
  { count: 0.1, width: 3.8 },
];

export class LodManager {
  static async load(base, character, hair) {
    const meta = character.meta.lods;
    if (!meta) return null;
    const buf = await fetch(`${base}${meta.file}`).then((r) => r.arrayBuffer());
    return new LodManager(character, meta, buf, hair);
  }

  constructor(character, meta, buffer, hair) {
    this.character = character;
    this.hair = hair;
    this.entries = [];
    for (const mesh of character.meshes) {
      const e = meta.meshes[mesh.name];
      if (!e) continue;
      const levels = [mesh.geometry.index, ...e.levels.map((l) => (l ? new THREE.BufferAttribute(new Uint32Array(buffer, l.offset, l.count), 1) : null))];
      this.entries.push({ mesh, levels });
    }
    this.hairCount = hair.geometry.instanceCount;
    this.hairWidth = hair.material.userData.uniforms.strandWidth.value;
    this.level = 0;
    this.forced = null;
    this.screen = 1;
    this.triangles = 0;
    this.apply(0);
  }

  apply(level) {
    this.level = level;
    let tris = 0;
    for (const { mesh, levels } of this.entries) {
      const idx = levels[level];
      if (idx) {
        if (mesh.geometry.index !== idx) mesh.geometry.setIndex(idx);
        mesh.geometry.setDrawRange(0, Infinity);
        if (mesh.visible) tris += idx.count / 3;
      } else mesh.geometry.setDrawRange(0, 0);
    }
    const h = HAIR[level];
    this.hair.setCount(Math.round(this.hairCount * h.count));
    this.hair.material.userData.uniforms.strandWidth.value = this.hairWidth * h.width;
    this.triangles = tris;
  }

  /** @param center  world point at the character's mid height */
  update(camera, center) {
    const dist = Math.max(0.1, camera.position.distanceTo(center));
    // fraction of the viewport height covered by a 1.75 m character
    this.screen = 1.75 / dist / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    let target = this.level;
    if (this.forced !== null) target = this.forced;
    else {
      // hysteresis: switch down only 10 % past a threshold, back up 10 % before it
      const up = (l) => this.screen > SCREEN[l - 1] * 1.1;
      const down = (l) => this.screen < SCREEN[l] * 0.9;
      while (target < 3 && down(target)) target++;
      while (target > 0 && up(target)) target--;
    }
    if (target !== this.level) this.apply(target);
  }
}
