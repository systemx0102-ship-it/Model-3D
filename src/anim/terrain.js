// Analytic test terrain for locomotion and foot IK: flat plaza with subtle undulation, a 15° slope,
// a rocky bumpy patch, a flight of stairs onto a platform and a ledge to drop from.
import * as THREE from 'three';

const STAIRS = { x0: -4.6, x1: -3.0, z0: 1.0, steps: 8, rise: 0.16, run: 0.3 };
const PLATFORM = { x0: -4.6, x1: -3.0, z0: STAIRS.z0 + STAIRS.steps * STAIRS.run, z1: 5.2, h: STAIRS.steps * STAIRS.rise };

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export class Terrain {
  constructor() {
    this.stairs = STAIRS;
    this.platform = PLATFORM;
  }

  /** Ground height at (x, z). */
  height(x, z) {
    let h = 0;
    // gentle undulation everywhere (a few cm)
    h += (vnoise(x * 0.35, z * 0.35) - 0.5) * 0.05;
    // slope: 15 degrees up toward +x, plateau at 1 m
    if (x > 2.5) h += Math.min(1.0, (x - 2.5) * Math.tan((15 * Math.PI) / 180));
    // rocky patch
    if (z < -2 && z > -7 && Math.abs(x) < 2.5) {
      const w = Math.min(1, (-2 - z) / 0.6, (z + 7) / 0.6, (2.5 - Math.abs(x)) / 0.6);
      h += w * ((vnoise(x * 2.2, z * 2.2) - 0.5) * 0.16 + (vnoise(x * 6, z * 6) - 0.5) * 0.05);
    }
    // stairs + platform (exact boxes)
    const S = STAIRS, P = PLATFORM;
    if (x > S.x0 && x < S.x1) {
      if (z >= S.z0 && z < P.z0) h = Math.max(h, (Math.floor((z - S.z0) / S.run) + 1) * S.rise);
      else if (z >= P.z0 && z <= P.z1) h = Math.max(h, P.h);
    }
    return h;
  }

  normal(x, z, out = new THREE.Vector3()) {
    const e = 0.04;
    const hx = this.height(x + e, z) - this.height(x - e, z);
    const hz = this.height(x, z + e) - this.height(x, z - e);
    // steps are flat on top: avoid tilting the foot on a step edge
    if (Math.abs(hx) > 0.06 || Math.abs(hz) > 0.06) return out.set(0, 1, 0);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }

  /** Moves a foot target off step edges (a foot never lands half on a riser). */
  safeFootPoint(p) {
    const S = this.stairs;
    if (p.x > S.x0 && p.x < S.x1 && p.z > S.z0 - 0.05 && p.z < this.platform.z0 + 0.05) {
      const k = Math.round((p.z - S.z0) / S.run - 0.5);
      p.z = S.z0 + (k + 0.55) * S.run;
    }
    return p;
  }

  mesh() {
    const group = new THREE.Group();
    const size = 80, seg = 400;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      // keep the terrain mesh below the stairs volume (the boxes render those)
      const inStairs = x > STAIRS.x0 && x < STAIRS.x1 && z > STAIRS.z0 && z < PLATFORM.z1;
      pos.setY(i, inStairs ? 0 : this.height(x, z));
    }
    geo.computeVertexNormals();
    const tex = gridTexture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(size, size);
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, color: 0xb9b4ac }));
    ground.receiveShadow = true;
    group.add(ground);
    const mat = new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.8 });
    for (let k = 0; k < STAIRS.steps; k++) {
      const h = (k + 1) * STAIRS.rise;
      const box = new THREE.Mesh(new THREE.BoxGeometry(STAIRS.x1 - STAIRS.x0, h, STAIRS.run), mat);
      box.position.set((STAIRS.x0 + STAIRS.x1) / 2, h / 2, STAIRS.z0 + (k + 0.5) * STAIRS.run);
      box.castShadow = box.receiveShadow = true;
      group.add(box);
    }
    const plat = new THREE.Mesh(new THREE.BoxGeometry(PLATFORM.x1 - PLATFORM.x0, PLATFORM.h, PLATFORM.z1 - PLATFORM.z0), mat);
    plat.position.set((PLATFORM.x0 + PLATFORM.x1) / 2, PLATFORM.h / 2, (PLATFORM.z0 + PLATFORM.z1) / 2);
    plat.castShadow = plat.receiveShadow = true;
    group.add(plat);
    return group;
  }
}

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#8f8a82';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) {
    const v = 120 + Math.random() * 40;
    g.fillStyle = `rgba(${v},${v - 4},${v - 10},0.25)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = 'rgba(40,38,34,0.35)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
