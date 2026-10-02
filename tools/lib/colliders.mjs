// Body collision proxies for hair and cloth: spheres and capsules attached to bones, with radii
// fitted to the actual mesh (distance quantiles of the vertices each bone dominates).
import * as THREE from 'three';
import { SKULL_CENTER } from '../../character/hairline.mjs';

const quantile = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
};

/**
 * @param world      MH-indexed rest positions
 * @param verts      iterable of body vertex indices
 * @param dominant   (v) -> name of the bone with the largest skin weight
 * @returns [{name, type, bone, a, b?, r}] with a/b in bone-local bind space
 */
export function fitColliders({ rig, world, verts, dominant, eyes, scalpVerts, bodyTris }) {
  const B = (n) => rig.byName.get(n);
  const P = (v) => new THREE.Vector3(world[v * 3], world[v * 3 + 1], world[v * 3 + 2]);
  const byBone = new Map();
  for (const v of verts) {
    const b = dominant(v);
    (byBone.get(b) ?? byBone.set(b, []).get(b)).push(v);
  }
  const pick = (bones, filter = () => true) => bones.flatMap((b) => byBone.get(b) ?? []).filter((v) => filter(P(v)));
  const segDist = (p, a, b) => new THREE.Line3(a, b).closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p);
  const out = [];
  const capsule = (name, bone, a, b, vs, q, scale = 1) => {
    const r = quantile(vs.map((v) => segDist(P(v), a, b)), q) * scale;
    out.push({ name, type: 'capsule', bone, a, b, r });
  };
  const sphere = (name, bone, c, vs, q, scale = 1) => {
    const r = quantile(vs.map((v) => P(v).distanceTo(c)), q) * scale;
    out.push({ name, type: 'sphere', bone, a: c, r });
  };

  const eyeMid = eyes.l.center.clone().add(eyes.r.center).multiplyScalar(0.5);
  const skull = eyeMid.clone().add(new THREE.Vector3(...SKULL_CENTER));
  // cranium as three overlapping spheres along the front-back axis (heads are longer than wide)
  for (const [k, dz] of [['front', 0.035], ['mid', -0.005], ['back', -0.045]]) {
    const c = skull.clone().add(new THREE.Vector3(0, dz > 0 ? -0.004 : 0, dz));
    const local = scalpVerts.filter((v) => Math.abs(world[v * 3 + 2] - c.z) < 0.025);
    sphere(`cranium_${k}`, 'head', c, local, 0.25, 0.99);
  }
  const faceC = eyeMid.clone().add(new THREE.Vector3(0, -0.028, -0.012));
  sphere('face', 'head', faceC, pick(['head'], (p) => p.z > eyeMid.z - 0.01 && p.y < eyeMid.y + 0.02 && p.y > eyeMid.y - 0.09), 0.25, 0.97);
  // face shield: keeps locks from swinging through the face (slightly inside the cheeks)
  out.push({ name: 'face_shield', type: 'capsule', bone: 'head', a: eyeMid.clone().add(new THREE.Vector3(0, 0.025, -0.012)), b: eyeMid.clone().add(new THREE.Vector3(0, -0.095, -0.02)), r: 0.066 });
  const jawC = eyeMid.clone().add(new THREE.Vector3(0, -0.075, -0.035));
  sphere('jaw', 'head', jawC, pick(['head'], (p) => p.y < eyeMid.y - 0.05), 0.3, 0.95);
  capsule('neck', 'neck_01', B('neck_01').head.clone(), B('head').head.clone(), pick(['neck_01', 'neck_02']), 0.45);

  const shL = B('upperarm_l').head;
  // Torso: spheres sampled on the actual skin (back grid, trapezius, upper chest). A capsule's
  // circular cross-section cannot hug a wide, flat back; a sphere set tangent to the surface can.
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(world, 3)).setIndex(new THREE.BufferAttribute(bodyTris, 1)),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  const ray = new THREE.Raycaster();
  const nearestVert = (p) => {
    let best = -1, bd = Infinity;
    for (const v of verts) {
      const d = (world[v * 3] - p.x) ** 2 + (world[v * 3 + 1] - p.y) ** 2 + (world[v * 3 + 2] - p.z) ** 2;
      if (d < bd) (bd = d), (best = v);
    }
    return best;
  };
  const surfaceSphere = (name, origin, dir, r) => {
    ray.set(origin, dir);
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit) return;
    const n = dir.clone().negate(); // inward along the ray: robust on curved, sloped skin
    const c = hit.point.clone().addScaledVector(n, -r);
    out.push({ name, type: 'sphere', bone: dominant(nearestVert(hit.point)), a: c, r });
  };
  const topY = shL.y + 0.02;
  for (let i = 0; i < 5; i++)
    for (const x of [-0.12, -0.06, 0, 0.06, 0.12]) {
      const y = topY - 0.035 - i * 0.065;
      surfaceSphere(`back_${i}_${x}`, new THREE.Vector3(x, y, -0.6), new THREE.Vector3(0, 0, 1), 0.06);
    }
  for (const x of [-0.15, -0.1, -0.05, 0.05, 0.1, 0.15])
    surfaceSphere(`trapezius_${x}`, new THREE.Vector3(x, topY + 0.25, -0.02), new THREE.Vector3(0, -1, 0), 0.045);
  for (let i = 0; i < 2; i++)
    for (const x of [-0.1, -0.035, 0.035, 0.1]) surfaceSphere(`chest_${i}_${x}`, new THREE.Vector3(x, topY - 0.04 - i * 0.06, 0.6), new THREE.Vector3(0, 0, -1), 0.06);
  // hips / seat / belly: spheres tangent to the skin, found by rays cast from inside the pelvis
  // outward (the first hit is the skin itself, never a hanging arm). Used by waist-hung cloth.
  const insideSphere = (name, origin, dir, r) => {
    ray.set(origin, dir);
    ray.far = 0.4;
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit) return;
    out.push({ name, type: 'sphere', bone: dominant(nearestVert(hit.point)), a: hit.point.clone().addScaledVector(dir, -r), r });
  };
  const pc = B('pelvis').head, hipY = B('thigh_l').head.y;
  for (const [i, dy] of [[0, 0.09], [1, 0.045], [2, 0.0]])
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      insideSphere(`pelvis_${i}_${k}`, new THREE.Vector3(0, hipY + dy, pc.z - 0.01), new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), 0.06);
    }
  for (const sx of [1, -1])
    for (const [j, dy] of [[0, -0.04], [1, -0.08]])
      for (const a of [Math.PI * 0.8, Math.PI, Math.PI * 1.2])
        insideSphere(`pelvis_seat_${sx}_${j}_${a.toFixed(2)}`, new THREE.Vector3(sx * 0.075, hipY + dy, pc.z - 0.02), new THREE.Vector3(Math.sin(a) * sx, 0, Math.cos(a)), 0.055);
  for (const s of ['l', 'r']) {
    sphere(`breast_${s}`, `breast_${s}`, B(`breast_${s}`).head.clone(), pick([`breast_${s}`]), 0.85);
    sphere(`shoulder_${s}`, `upperarm_${s}`, B(`upperarm_${s}`).head.clone(), pick([`clavicle_${s}`, `upperarm_${s}`, `upperarm_twist_01_${s}`], (p) => p.distanceTo(B(`upperarm_${s}`).head) < 0.08), 0.8);
    capsule(`upperarm_${s}`, `upperarm_${s}`, B(`upperarm_${s}`).head.clone(), B(`lowerarm_${s}`).head.clone(), pick([`upperarm_${s}`, `upperarm_twist_01_${s}`, `upperarm_twist_02_${s}`]), 0.5);
    capsule(`forearm_${s}`, `lowerarm_${s}`, B(`lowerarm_${s}`).head.clone(), B(`hand_${s}`).head.clone(), pick([`lowerarm_${s}`, `lowerarm_twist_01_${s}`, `lowerarm_twist_02_${s}`]), 0.5);
    capsule(`thigh_${s}`, `thigh_${s}`, B(`thigh_${s}`).head.clone(), B(`calf_${s}`).head.clone(), pick([`thigh_${s}`, `thigh_twist_01_${s}`, `thigh_twist_02_${s}`]), 0.5);
    capsule(`calf_${s}`, `calf_${s}`, B(`calf_${s}`).head.clone(), B(`foot_${s}`).head.clone(), pick([`calf_${s}`, `calf_twist_01_${s}`, `calf_twist_02_${s}`]), 0.5);
  }
  // express in bone-local bind space
  return out.map((c) => {
    const inv = B(c.bone).world.clone().invert();
    const o = { name: c.name, type: c.type, bone: c.bone, r: c.r, a: c.a.clone().applyMatrix4(inv).toArray() };
    if (c.b) o.b = c.b.clone().applyMatrix4(inv).toArray();
    o.world = { a: c.a.toArray(), b: c.b?.toArray() };
    return o;
  });
}

/** World-space collider list (bind pose) for build-time simulation. */
export function bindPoseColliders(list, inflate = 0) {
  return list.map((c) => (c.type === 'sphere' ? { type: 'sphere', c: c.world.a, r: c.r + inflate } : { type: 'capsule', a: c.world.a, b: c.world.b, r: c.r + inflate }));
}
