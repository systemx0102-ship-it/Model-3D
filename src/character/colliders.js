// Body collision proxies (fitted at build time, bone-local) transformed to world each frame.
import * as THREE from 'three';

export class BodyColliders {
  constructor(character, list) {
    this.items = list.map((c) => ({
      ...c,
      bone: character.bone(c.bone),
      la: new THREE.Vector3(...c.a),
      lb: c.b ? new THREE.Vector3(...c.b) : null,
    }));
    this.inflate = 0.003; // clothing / hair-layer thickness
    this.tmp = new THREE.Vector3();
  }
  /** World-space collider list for the solvers. */
  world(filter) {
    const out = [];
    for (const c of this.items) {
      if (filter && !filter(c)) continue;
      const a = this.tmp.copy(c.la).applyMatrix4(c.bone.matrixWorld).toArray();
      if (c.type === 'sphere') out.push({ type: 'sphere', c: a, r: c.r + this.inflate, name: c.name });
      else out.push({ type: 'capsule', a, b: this.tmp.copy(c.lb).applyMatrix4(c.bone.matrixWorld).toArray(), r: c.r + this.inflate, name: c.name });
    }
    return out;
  }
  /** Debug visualisation. */
  helpers() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x33ff88, wireframe: true, transparent: true, opacity: 0.35 });
    for (const c of this.items) {
      const m = c.type === 'sphere' ? new THREE.Mesh(new THREE.SphereGeometry(c.r, 16, 10), mat) : new THREE.Mesh(new THREE.CapsuleGeometry(c.r, c.la.distanceTo(c.lb), 6, 12), mat);
      m.userData.collider = c;
      g.add(m);
    }
    g.update = () => {
      for (const m of g.children) {
        const c = m.userData.collider;
        const a = c.la.clone().applyMatrix4(c.bone.matrixWorld);
        if (c.type === 'sphere') m.position.copy(a);
        else {
          const b = c.lb.clone().applyMatrix4(c.bone.matrixWorld);
          m.position.copy(a).add(b).multiplyScalar(0.5);
          m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
        }
      }
    };
    return g;
  }
}
