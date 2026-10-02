// Builds the hero character asset (GLB + runtime sidecar JSON) from the recipe and the
// vendored CC0 MakeHuman data. Run: npm run build:character
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { readObj } from './lib/obj.mjs';
import { composeShape } from './lib/shape.mjs';
import { loadMhSkeleton, mhBones } from './lib/mhskel.mjs';
import { buildRig, localBind } from './lib/rig.mjs';
import { remapWeights, packWeights } from './lib/weights.mjs';
import { assemble, triangulate, computeNormals, computeTangents, bounds } from './lib/mesh.mjs';
import { CharacterGltf } from './lib/gltf.mjs';
import { bakeShapes, ARKIT, EXTRAS } from './lib/face.mjs';
import { repack, TILE, TILE_NAMES } from './lib/uvpack.mjs';
import { eyeFrame, eyeballMesh, tearlineStrip, EYE, ringsAround, fitEye, unitSurface } from './lib/eyes.mjs';
import { buildDentition } from './lib/teeth.mjs';
import { TriangleSet, bindGroup, boundDeltas, bindWeights } from './lib/binding.mjs';
import { eyelashes, eyebrows } from './lib/facehair.mjs';
import { ribbons, rng } from './lib/ribbons.mjs';
import { recipe } from '../character/recipe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const MH = path.join(root, 'third_party/makehuman');
const OUT = path.join(root, 'public/character');
fs.mkdirSync(OUT, { recursive: true });
const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const random = rng(0x5eed1);

// 1. Shape ---------------------------------------------------------------------------------
const base = readObj(path.join(MH, '3dobjs/base.obj'));
const { positions: shaped, applied } = composeShape(MH, base.positions, recipe);
log(`composed shape from ${applied.length} targets`);

// 2. Place in world: metres, soles on y=0, origin between the feet, facing +Z ----------------
const bodyFaces = base.faces.filter((f) => f.g === 'body');
const bodyVerts = new Set(bodyFaces.flatMap((f) => f.v));
let groundY = Infinity;
for (const v of bodyVerts) groundY = Math.min(groundY, shaped[v * 3 + 1]);
let footMinZ = Infinity, footMaxZ = -Infinity;
for (const v of bodyVerts) {
  if (shaped[v * 3 + 1] > groundY + 0.6) continue;
  footMinZ = Math.min(footMinZ, shaped[v * 3 + 2]);
  footMaxZ = Math.max(footMaxZ, shaped[v * 3 + 2]);
}
const originZ = (footMinZ + footMaxZ) / 2;
const world = new Float32Array(shaped.length);
for (let i = 0; i < shaped.length; i += 3) {
  world[i] = shaped[i] * recipe.unitScale;
  world[i + 1] = (shaped[i + 1] - groundY) * recipe.unitScale;
  world[i + 2] = (shaped[i + 2] - originZ) * recipe.unitScale;
}
const P = (v) => new THREE.Vector3(world[v * 3], world[v * 3 + 1], world[v * 3 + 2]);
const groupPoints = (g) => [...new Set(base.faces.filter((f) => f.g === g).flatMap((f) => f.v))].map(P);

// 3. UV layout: head / body / limbs texture sets ---------------------------------------------
const packed = repack(bodyFaces, base.uvs, base.positions);
log(`uv texel scale vs. source: head ${packed.report.head.toFixed(2)}x, body ${packed.report.body.toFixed(2)}x, limbs ${packed.report.limbs.toFixed(2)}x`);

// 4. Eyes: fit an anatomical eyeball against the inner lid surface ---------------------------
const { skel, weights: mhW } = loadMhSkeleton(MH);
const mh = mhBones(skel, world);
const eyes = {};
const eyeFits = {};
for (const sock of packed.parts.sockets) {
  const side = sock.meanX > 0 ? 'l' : 'r';
  const S = side.toUpperCase();
  const center0 = mh[`eye.${S}`].head.clone();
  const gaze = new THREE.Vector3().subVectors(mh[`eye.${S}`].tail, center0).normalize();
  const frame0 = eyeFrame(center0, gaze);
  const inv0 = frame0.clone().invert();
  // ring 0 = socket boundary, 1-2 = inner (conjunctival) lid surface, 3 = anterior lid margin
  const rings = ringsAround(sock.faces, bodyFaces, 5);
  const contact = [...rings[1], ...rings[2]].map((v) => P(v).applyMatrix4(inv0));
  eyeFits[side] = fitEye(contact);
  eyes[side] = { gaze, frame0, rings };
}
// Eyes are the same size even when sockets are not: share R, refit the offsets at that R.
const R = Math.min(eyeFits.l.R, eyeFits.r.R);
for (const side of ['l', 'r']) {
  const e = eyes[side];
  const contact = [...e.rings[1], ...e.rings[2]].map((v) => P(v).applyMatrix4(e.frame0.clone().invert()));
  const fit = fitEye(contact, { rMin: R, rMax: R });
  e.center = new THREE.Vector3(0, 0, fit.offset).applyMatrix4(e.frame0);
  e.frame = eyeFrame(e.center, e.gaze);
  e.R = R;
  log(`eye_${side}: R ${(R * 1000).toFixed(2)} mm, moved ${(fit.offset * 1000).toFixed(2)} mm forward, min lid clearance ${(fit.minGap * 1000).toFixed(2)} mm`);
}

// 5. Skeleton + weights ----------------------------------------------------------------------
const rig = buildRig(mh, { eyeCenter: { l: eyes.l.center, r: eyes.r.center } });
const locals = localBind(rig);
const perVertex = remapWeights(mhW, world, rig);
const boneIndex = (n) => rig.byName.get(n).index;
log(`rig: ${rig.bones.length} bones`);

// 6. Dentition (needed before the bake so the lower teeth can ride the jaw) -------------------
const dent = buildDentition(groupPoints('helper-upper-teeth'), groupPoints('helper-lower-teeth'), random);

// 7. Facial blendshapes (ARKit 52 + extras), baked on this exact face -------------------------
const { shapes, rigid, eyeRot } = bakeShapes({
  mhDir: MH, restPositions: world, mhBones: mh, skel, mhWeights: mhW, unitScale: recipe.unitScale,
  defs: { ...ARKIT, ...EXTRAS },
  rigid: { lowerTeeth: { bone: 'jaw', points: dent.lower.positions }, lowerGum: { bone: 'jaw', points: dent.gum_lower.positions } },
});
const shapeNames = Object.keys(shapes);
log(`baked ${shapeNames.length} blendshapes`);

// Lids conform to the eyeball: any posed lid vertex that would enter the (possibly rotated)
// eye surface is pushed back out radially, so blinks and squints never cut through the cornea.
{
  let fixed = 0;
  const near = { l: [], r: [] };
  for (const v of bodyVerts)
    for (const side of ['l', 'r']) if (P(v).distanceTo(eyes[side].center) < eyes[side].R * 2.2) near[side].push(v);
  const p = new THREE.Vector3();
  for (const name of shapeNames)
    for (const side of ['l', 'r']) {
      const e = eyes[side];
      const rot = eyeRot[name][side];
      const frame = e.frame.clone().multiply(new THREE.Matrix4().makeRotationFromQuaternion(
        // eye rotation is a world-space delta about the eye centre; express it in the eye frame
        new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(e.frame)).invert().multiply(rot).multiply(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(e.frame))),
      ));
      const inv = frame.clone().invert();
      const d = shapes[name];
      for (const v of near[side]) {
        if (!d[v * 3] && !d[v * 3 + 1] && !d[v * 3 + 2]) continue;
        p.set(world[v * 3] + d[v * 3], world[v * 3 + 1] + d[v * 3 + 1], world[v * 3 + 2] + d[v * 3 + 2]).applyMatrix4(inv);
        const dist = p.length();
        const theta = Math.acos(THREE.MathUtils.clamp(p.z / dist, -1, 1));
        const surf = e.R * unitSurface(theta) + 0.00012;
        if (dist >= surf || p.z < 0) continue;
        p.multiplyScalar(surf / dist).applyMatrix4(frame);
        d[v * 3] = p.x - world[v * 3]; d[v * 3 + 1] = p.y - world[v * 3 + 1]; d[v * 3 + 2] = p.z - world[v * 3 + 2];
        fixed++;
      }
    }
  log(`lid/eyeball conformity: corrected ${fixed} posed lid vertices`);
}

// Full-body smooth normals per source vertex (so tile seams shade continuously).
const bodyTris = triangulate(bodyFaces.map((f) => f.v));
const identity = Int32Array.from({ length: world.length / 3 }, (_, i) => i);
const restNormals = computeNormals(world, bodyTris, identity);
const shapeNormalDelta = {};
for (const name of shapeNames) {
  const moved = Float32Array.from(world, (v, i) => v + shapes[name][i]);
  const n = computeNormals(moved, bodyTris, identity);
  shapeNormalDelta[name] = Float32Array.from(n, (v, i) => v - restNormals[i]);
}

/** Morph targets for a mesh whose vertices map to MH vertices through `src`. */
function morphsBySrc(src, names = shapeNames) {
  const out = [];
  for (const name of names) {
    const full = shapes[name];
    const position = new Float32Array(src.length * 3);
    const normal = new Float32Array(src.length * 3);
    let any = false;
    src.forEach((s, i) => {
      for (let k = 0; k < 3; k++) {
        const d = full[s * 3 + k];
        if (Math.abs(d) > 1e-5) position[i * 3 + k] = d;
        if (Math.abs(d) > 5e-5) any = true;
        const dn = shapeNormalDelta[name][s * 3 + k];
        if (Math.abs(dn) > 1e-4) normal[i * 3 + k] = dn;
      }
    });
    if (any) out.push({ name, position, normal });
  }
  return out;
}

// 7. Body: one primitive per texture set ---------------------------------------------------
const tiles = [[], [], []];
for (const f of bodyFaces) tiles[packed.tileOfFace.get(f)].push(f);
const bodyParts = tiles.map((faces, tile) => {
  const m = assemble(world, packed.uvs, faces);
  m.indices = triangulate(m.polys);
  m.normals = Float32Array.from({ length: m.src.length * 3 }, (_, i) => restNormals[m.src[(i / 3) | 0] * 3 + (i % 3)]);
  m.tangents = computeTangents(m.positions, m.normals, m.uvs, m.indices);
  Object.assign(m, packWeights(perVertex, m.src, rig));
  m.morphs = morphsBySrc(m.src);
  m.tile = tile;
  return m;
});
const bb = bounds(world.filter((_, i) => bodyVerts.has((i / 3) | 0)));
const height = bb.max[1] - bb.min[1];
log(`body: ${bodyParts.reduce((s, m) => s + m.src.length, 0)} verts, ${bodyFaces.length} quads, height ${height.toFixed(3)} m`);

// Head surface for bindings / raycasts (indices are MH vertex indices).
const headFaceList = [...packed.parts.head.faces];
const headSet = new TriangleSet(world, triangulate(headFaceList.map((f) => f.v)));
const headMesh = new THREE.Mesh(
  new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(world, 3)).setIndex(new THREE.BufferAttribute(headSet.t, 1)),
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
);
const raycaster = new THREE.Raycaster();
const raycastSkin = (origin, dir) => {
  raycaster.set(origin, dir);
  const hit = raycaster.intersectObject(headMesh, false)[0];
  if (!hit) return null;
  const n = hit.face.normal.clone();
  if (n.dot(dir) > 0) n.negate();
  return { point: hit.point, normal: n };
};

// Per-MH-vertex packed weights, so bound geometry can interpolate skin weights.
const allWeights = packWeights(perVertex, identity, rig);

/** Builds a skinned mesh from geometry bound to the head surface (ribbons, strips). */
function boundMesh(geom, groups) {
  // groups: [{binding, vertexIndices}]
  const n = geom.positions.length / 3;
  const joints = new Uint16Array(n * 4);
  const weights = new Float32Array(n * 4);
  const morphPos = Object.fromEntries(shapeNames.map((s) => [s, new Float32Array(n * 3)]));
  for (const { binding, verts } of groups) {
    const { J, W } = bindWeights(headSet, binding, allWeights.joints, allWeights.weights);
    for (const v of verts) for (let k = 0; k < 4; k++) (joints[v * 4 + k] = J[k]), (weights[v * 4 + k] = W[k]);
    for (const s of shapeNames) {
      const d = boundDeltas(headSet, binding, shapes[s]);
      verts.forEach((v, i) => {
        morphPos[s][v * 3] = d[i].x; morphPos[s][v * 3 + 1] = d[i].y; morphPos[s][v * 3 + 2] = d[i].z;
      });
    }
  }
  const morphs = [];
  for (const s of shapeNames) {
    const a = morphPos[s];
    let any = false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i]) > 5e-5) any = true;
      if (Math.abs(a[i]) < 1e-5) a[i] = 0;
    }
    if (any) morphs.push({ name: s, position: a });
  }
  return { ...geom, joints, weights, morphs };
}

// 8. Eye geometry -----------------------------------------------------------------------
for (const side of ['l', 'r']) {
  const e = eyes[side];
  const ball = eyeballMesh(e.frame, e.R);
  const n = ball.positions.length / 3;
  ball.joints = new Uint16Array(n * 4).map((_, i) => (i % 4 === 0 ? boneIndex(`eye_${side}`) : 0));
  ball.weights = new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0));
  ball.tangents = computeTangents(ball.positions, ball.normals, ball.uvs, ball.indices);
  // tear line (lacrimal meniscus) sits where the inner lid surface meets the eye, rides the lids
  const loopIdx = e.rings[1];
  const loop = loopIdx.map(P);
  const strip = tearlineStrip(loop, e.center, e.R);
  const vtx = (i) => new THREE.Vector3().fromArray(strip.positions, i * 3);
  const groups = loop.map((p, i) => ({ binding: bindGroup(headSet, [vtx(i * 2), vtx(i * 2 + 1)], p), verts: [i * 2, i * 2 + 1] }));
  e.tear = boundMesh(strip, groups);
  e.ball = ball;
  // lashes emerge from the anterior lid margin, between rings 2 and 3
  e.margin = e.rings[3].map((v, i) => {
    const q = P(v);
    const r2 = e.rings[2][i] !== undefined ? P(e.rings[2][i]) : q;
    return q.distanceTo(r2) < 0.004 ? q.lerp(r2, 0.35) : q;
  });
}

// 9. Mouth: teeth, gums, tongue ----------------------------------------------------------
function rigidMesh(geom, bone, morphSource) {
  const n = geom.positions.length / 3;
  geom.normals ??= computeNormals(geom.positions, geom.indices, Int32Array.from({ length: n }, (_, i) => i));
  geom.joints = new Uint16Array(n * 4).map((_, i) => (i % 4 === 0 ? boneIndex(bone) : 0));
  geom.weights = new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0));
  geom.morphs = [];
  if (morphSource)
    for (const s of shapeNames) {
      const d = morphSource[s];
      if (d.some((x) => Math.abs(x) > 5e-5)) geom.morphs.push({ name: s, position: d.map((x) => (Math.abs(x) < 1e-5 ? 0 : x)) });
    }
  return geom;
}
// small rest offsets so ~1.5 mm of upper incisor shows when the lips part, tongue rests low
const offset = (geom, dx, dy, dz) => { for (let i = 0; i < geom.positions.length; i += 3) (geom.positions[i] += dx), (geom.positions[i + 1] += dy), (geom.positions[i + 2] += dz); };
offset(dent.upper, 0, -0.0012, 0);
offset(dent.gum_upper, 0, -0.0012, 0);
const teethUpper = rigidMesh(dent.upper, 'head');
const teethLower = rigidMesh(dent.lower, 'head', rigid.lowerTeeth);
const gumUpper = rigidMesh(dent.gum_upper, 'head');
const gumLower = rigidMesh(dent.gum_lower, 'head', rigid.lowerGum);
const tongueFaces = base.faces.filter((f) => f.g === 'helper-tongue');
const tongue = assemble(world, base.uvs, tongueFaces);
offset(tongue, 0, -0.0022, -0.0015);
tongue.indices = triangulate(tongue.polys);
tongue.normals = computeNormals(tongue.positions, tongue.indices, tongue.src);
Object.assign(tongue, packWeights(perVertex, tongue.src, rig));
tongue.morphs = morphsBySrc(tongue.src).map((m) => ({ name: m.name, position: m.position }));

// 10. Eyelashes and eyebrows ---------------------------------------------------------------
function strandMesh(strands) {
  const geom = ribbons(strands);
  const groups = strands.map((s, si) => {
    const verts = [];
    for (let v = 0; v < geom.strandOf.length; v++) if (geom.strandOf[v] === si) verts.push(v);
    const pts = verts.map((v) => new THREE.Vector3().fromArray(geom.positions, v * 3));
    return { binding: bindGroup(headSet, pts, s.root), verts };
  });
  return boundMesh(geom, groups);
}
const lashStrands = [];
const browStrands = [];
for (const side of ['l', 'r']) {
  const e = eyes[side];
  lashStrands.push(...eyelashes(e.margin, e.center, e.frame, e.R, random, side === 'l' ? 1 : -1));
  browStrands.push(...eyebrows(e.center, side === 'l' ? 1 : -1, raycastSkin, random));
}
const lashes = strandMesh(lashStrands);
const brows = strandMesh(browStrands);
log(`face hair: ${lashStrands.length} lashes, ${browStrands.length} brow hairs`);

// 11. Write --------------------------------------------------------------------------------
const g = new CharacterGltf(recipe.name);
g.addSkeleton(rig, locals);
const M = {
  skin: TILE_NAMES.map((t) => g.material(`M_Skin_${t}`, { color: [0.8, 0.62, 0.53, 1], roughness: 0.5, extras: { shader: 'skin', tile: t } })),
  eye: g.material('M_Eye', { color: [1, 1, 1, 1], roughness: 0.05, extras: { shader: 'eye', ...EYE } }),
  tear: g.material('M_Tearline', { color: [1, 1, 1, 0.0], roughness: 0.02, alphaMode: 'BLEND', extras: { shader: 'tearline' } }),
  teeth: g.material('M_Teeth', { color: [0.93, 0.9, 0.82, 1], roughness: 0.22, extras: { shader: 'teeth' } }),
  gum: g.material('M_Gums', { color: [0.78, 0.36, 0.38, 1], roughness: 0.35, extras: { shader: 'mouth' } }),
  tongue: g.material('M_Tongue', { color: [0.72, 0.36, 0.38, 1], roughness: 0.4, extras: { shader: 'mouth' } }),
  lash: g.material('M_Eyelashes', { color: [0.04, 0.03, 0.025, 1], roughness: 0.5, alphaMode: 'MASK', alphaCutoff: 0.3, doubleSided: true, extras: { shader: 'strand' } }),
  brow: g.material('M_Eyebrows', { color: [0.11, 0.075, 0.05, 1], roughness: 0.55, alphaMode: 'MASK', alphaCutoff: 0.3, doubleSided: true, extras: { shader: 'strand' } }),
};
for (const m of bodyParts) g.addMesh({ name: `SK_Body_${TILE_NAMES[m.tile]}`, ...m, material: M.skin[m.tile] });
for (const side of ['l', 'r']) {
  g.addMesh({ name: `SK_Eye_${side}`, ...eyes[side].ball, material: M.eye, nodeExtras: { radius: eyes[side].R, side } });
  g.addMesh({ name: `SK_Tearline_${side}`, ...eyes[side].tear, material: M.tear });
}
g.addMesh({ name: 'SK_Teeth_Upper', ...teethUpper, material: M.teeth });
g.addMesh({ name: 'SK_Teeth_Lower', ...teethLower, material: M.teeth });
g.addMesh({ name: 'SK_Gums_Upper', ...gumUpper, material: M.gum });
g.addMesh({ name: 'SK_Gums_Lower', ...gumLower, material: M.gum });
g.addMesh({ name: 'SK_Tongue', ...tongue, material: M.tongue });
g.addMesh({ name: 'SK_Eyelashes', ...lashes, material: M.lash });
g.addMesh({ name: 'SK_Eyebrows', ...brows, material: M.brow });
fs.writeFileSync(path.join(OUT, 'hero.glb'), await g.write());

const sidecar = {
  name: recipe.name,
  height,
  units: 'meters',
  up: '+Y',
  forward: '+Z',
  blendshapes: shapeNames,
  eyes: Object.fromEntries(Object.entries(eyes).map(([s, e]) => [s, { center: e.center.toArray(), radius: e.R, ...EYE }])),
  bones: rig.bones.map((b) => ({ name: b.name, parent: b.parent, role: b.role, head: b.head.toArray(), tail: b.tail.toArray() })),
  recipe: { macro: recipe.macro, targets: applied },
};
fs.writeFileSync(path.join(OUT, 'character.json'), JSON.stringify(sidecar, null, 1));
log(`wrote ${path.relative(root, OUT)}/hero.glb (${(fs.statSync(path.join(OUT, 'hero.glb')).size / 1e6).toFixed(2)} MB)`);
void TILE;
