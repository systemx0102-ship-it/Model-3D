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
import { regionMasks, vertexLighting, bakeTile, writeTile } from './lib/bakeset.mjs';
import { V, VCOUNT } from './lib/skinbake.mjs';
import { skinContext } from './lib/landmarks.mjs';
import { bakeEye } from './lib/eyebake.mjs';
import { bakeMicroNormal } from './lib/micro.mjs';
import { fitColliders, bindPoseColliders } from './lib/colliders.mjs';
import { buildGroom } from './lib/groom.mjs';
import { scalp as scalpInfo } from '../character/hairline.mjs';
import { buildOutfit } from './lib/outfit.mjs';
import { bakeFabricDetails } from './lib/fabric.mjs';
import { buildOvershirt, bakeFlannel } from './lib/overshirt.mjs';
import { bakeGarment, writeGarmentSet, boundaryField, tankShader, pantsShader, bootShader } from './lib/clothbake.mjs';
import { recipe } from '../character/recipe.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const TEX = +opt('tex', 2048);
const FORMATS = opt('png', false) ? ['png', 'webp'] : ['webp'];
const SKIP_TEX = !!opt('notex', false);
const SKIP_CLOTH = !!opt('nocloth', false);
const CLOTH_TEX = +opt('clothtex', Math.min(TEX, 2048));

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
// Rest lip seal: MakeHuman's neutral mouth is parted ~1 mm; a relaxed closed mouth is sealed.
for (const v of bodyVerts) for (let k = 0; k < 3; k++) world[v * 3 + k] += 0.45 * shapes.mouthClose[v * 3 + k];

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
// metres of surface per UV unit, per tile (drives the micro-normal tiling in the shader)
const metresPerUV = bodyParts.map((m) => {
  let s3 = 0, s2 = 0;
  for (let i = 0; i < m.indices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = m.indices[i + k], b = m.indices[i + ((k + 1) % 3)];
      s3 += Math.hypot(m.positions[a * 3] - m.positions[b * 3], m.positions[a * 3 + 1] - m.positions[b * 3 + 1], m.positions[a * 3 + 2] - m.positions[b * 3 + 2]);
      s2 += Math.hypot(m.uvs[a * 2] - m.uvs[b * 2], m.uvs[a * 2 + 1] - m.uvs[b * 2 + 1]);
    }
  return s3 / s2;
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
offset(dent.upper, 0, -0.0012, -0.0012);
offset(dent.gum_upper, 0, -0.0012, -0.0012);
offset(dent.lower, 0, 0, -0.0012);
offset(dent.gum_lower, 0, 0, -0.0012);
// vertex colour: enamel shade from cervical (warmer) to incisal edge (greyer, translucent),
// darkened toward the back of the mouth (cavity occlusion)
const mouthFront = Math.max(...dent.upper.positions.filter((_, i) => i % 3 === 2));
const occl = (z) => 0.3 + 0.7 * THREE.MathUtils.smoothstep(z, mouthFront - 0.042, mouthFront - 0.004);
function shadeVerts(geom, fn) {
  const n = geom.positions.length / 3;
  geom.colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = fn(i, geom.uvs ? geom.uvs[i * 2 + 1] : 0);
    const o = occl(geom.positions[i * 3 + 2]);
    geom.colors.set([c[0] * o, c[1] * o, c[2] * o, 1], i * 4);
  }
}
const enamel = (i, v) => {
  const t = THREE.MathUtils.smoothstep(v, 0.05, 0.55), e = THREE.MathUtils.smoothstep(v, 0.82, 1.0);
  return [0.8 + 0.1 * t - 0.08 * e, 0.69 + 0.17 * t - 0.04 * e, 0.5 + 0.27 * t + 0.03 * e];
};
shadeVerts(dent.upper, enamel);
shadeVerts(dent.lower, enamel);
shadeVerts(dent.gum_upper, () => [0.72, 0.3, 0.32]);
shadeVerts(dent.gum_lower, () => [0.72, 0.3, 0.32]);
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
shadeVerts(tongue, () => [0.62, 0.26, 0.27]);

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

// 10b. Body colliders + hair groom ----------------------------------------------------------
const vattr = regionMasks(MH, world.length / 3);
const dominant = (v) => {
  let best = null, bw = -1;
  for (const [b, w] of perVertex[v] ?? []) if (w > bw) (bw = w), (best = b);
  return best;
};
const eyeMidW = eyes.l.center.clone().add(eyes.r.center).multiplyScalar(0.5);
const scalpVerts = [...new Set(packed.parts.head.faces.flatMap((f) => f.v))].filter((v) => scalpInfo([world[v * 3] - eyeMidW.x, world[v * 3 + 1] - eyeMidW.y, world[v * 3 + 2] - eyeMidW.z], vattr[v * VCOUNT + V.EAR]).scalp > 0.6);
const colliders = fitColliders({ rig, world, verts: bodyVerts, dominant, eyes, scalpVerts, bodyTris });
log(`colliders: ${colliders.length} (${colliders.filter((c) => c.type === 'sphere').length} spheres)`);
const earMask = Float32Array.from({ length: world.length / 3 }, (_, v) => vattr[v * VCOUNT + V.EAR]);
const groom = buildGroom({ world, headTris: headSet.t, normals: restNormals, earMask, eyes, colliders: bindPoseColliders(colliders, 0.003), rng: random });
log(`hair: ${groom.guides.length} guides x ${groom.NP} points, ${groom.strands.guides.length / 3} render strands, ${groom.baby.length} baby hairs`);
const babyHair = strandMesh(groom.baby);
{
  // guides in head-bone local space; strand interpolation tables
  const headInv = rig.byName.get('head').world.clone().invert();
  const G = groom.guides.length, NP = groom.NP;
  const rest = new Float32Array(G * NP * 3);
  const v = new THREE.Vector3();
  groom.guides.forEach((g, gi) => {
    for (let k = 0; k < NP; k++) {
      v.fromArray(g.rest, k * 3).applyMatrix4(headInv);
      rest.set(v.toArray(), (gi * NP + k) * 3);
    }
  });
  const arrays = { guideRest: rest, ...groom.strands };
  const layout = {};
  let offset = 0;
  const chunks = [];
  for (const [name, arr] of Object.entries(arrays)) {
    layout[name] = { offset, length: arr.length };
    chunks.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    offset += arr.byteLength;
  }
  fs.writeFileSync(path.join(OUT, 'hair.bin'), Buffer.concat(chunks));
  var hairMeta = {
    file: 'hair.bin', layout, guides: G, points: NP, strands: groom.strands.guides.length / 3,
    zones: groom.guides.map((g) => g.zone), lengths: groom.guides.map((g) => +g.length.toFixed(4)),
    neighbors: (() => {
      // guide adjacency for volume preservation (pairs within 2.2 cm at the root)
      const out = [];
      for (let a = 0; a < G; a++)
        for (let b = a + 1; b < G; b++) {
          const d = groom.guides[a].root.p.distanceTo(groom.guides[b].root.p);
          if (d < 0.022) out.push([a, b, +Math.max(0.006, d * 0.7).toFixed(4)]);
        }
      return out;
    })(),
  };
}

// 10c. Outfit ---------------------------------------------------------------------------------
const bodySet = new TriangleSet(world, bodyTris);
const outfit = buildOutfit({ rig, world, normals: restNormals, faces: bodyFaces, uvs: packed.uvs, tileOfVt: packed.tileOfVt, perVertex, bodySet, dominant, bodyTris });
{
  // pouch hangs from its own bone so engines can drive it with a spring (AnimDynamics etc.)
  const a = outfit.belt.pouchAnchor;
  const pelvisB = rig.byName.get('pelvis');
  const pouchBone = { name: 'pouch_r', parent: 'pelvis', head: a.clone(), tail: a.clone().add(new THREE.Vector3(0, -0.1, 0)), role: 'accessory', world: new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1)).setPosition(a) };
  pouchBone.index = rig.bones.length;
  pouchBone.parentIndex = pelvisB.index;
  rig.bones.push(pouchBone);
  rig.byName.set('pouch_r', pouchBone);
}
// waist-tied flannel shirt: static tie (skinned) + simulated body and sleeve ends (runtime cloth)
const shirt = buildOvershirt({ outfit, rig });
const locals2 = localBind(rig);
locals.length = 0;
locals.push(...locals2);
// transfer breathing to the garments that cover the torso
function garmentMorphs(gm, names) {
  const n = gm.positions.length / 3;
  const res = [];
  for (const name of names) {
    const d = new Float32Array(n * 3);
    let any = false;
    for (let i = 0; i < n; i++) {
      const sv = gm.shell.srcIdx[gm.shellVertex[i]];
      for (let k = 0; k < 3; k++) {
        const x = shapes[name][sv * 3 + k];
        if (Math.abs(x) > 1e-5) (d[i * 3 + k] = x), (any = true);
      }
    }
    if (any) res.push({ name, position: d });
  }
  return res;
}
outfit.tank.morphs = garmentMorphs(outfit.tank, ['breatheChest', 'breatheBelly']);
outfit.pants.morphs = garmentMorphs(outfit.pants, ['breatheBelly']);
outfit.boots.normals = computeNormals(outfit.boots.positions, outfit.boots.indices, outfit.boots.weld);
for (const gm of [outfit.tank, outfit.pants, outfit.boots]) gm.tangents = computeTangents(gm.positions, gm.normals, gm.uvs, gm.indices);
// belt / buckle weights from the nearest trouser shell vertex
{
  const sp = outfit.pants.shell;
  const pantW = garmentWeightsLookup(outfit.pants);
  for (const part of [outfit.belt, outfit.belt.buckle, shirt.tie]) {
    const n = part.positions.length / 3;
    part.joints = new Uint16Array(n * 4);
    part.weights = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < sp.srcIdx.length; j++) {
        const d = (sp.pos[j * 3] - part.positions[i * 3]) ** 2 + (sp.pos[j * 3 + 1] - part.positions[i * 3 + 1]) ** 2 + (sp.pos[j * 3 + 2] - part.positions[i * 3 + 2]) ** 2;
        if (d < bd) (bd = d), (best = j);
      }
      part.joints.set(pantW.joints.subarray(best * 4, best * 4 + 4), i * 4);
      part.weights.set(pantW.weights.subarray(best * 4, best * 4 + 4), i * 4);
    }
  }
  const pb = outfit.belt.pouch;
  const n = pb.positions.length / 3;
  pb.joints = new Uint16Array(n * 4).map((_, i) => (i % 4 === 0 ? rig.byName.get('pouch_r').index : 0));
  pb.weights = new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0));
}
/** Weld key by identical position (closes UV seams for normal computation). */
function positionWeld(pos) {
  const map = new Map();
  return Int32Array.from({ length: pos.length / 3 }, (_, i) => {
    const k = `${pos[i * 3].toFixed(6)},${pos[i * 3 + 1].toFixed(6)},${pos[i * 3 + 2].toFixed(6)}`;
    if (!map.has(k)) map.set(k, i);
    return map.get(k);
  });
}
function garmentWeightsLookup(gm) {
  // per shell vertex weights (outer layer render vertices map 1:1 to shell vertices)
  const n = gm.shell.srcIdx.length;
  return { joints: gm.joints.subarray(0, n * 4), weights: gm.weights.subarray(0, n * 4) };
}
// body coverage masks (skin hidden under garments; one ring inside each hem stays visible)
const coverage = {};
coverage.boots = outfit.boots.covered;
for (const [key, gm] of [['tank', outfit.tank], ['pants', outfit.pants]]) {
  const sh = gm.shell;
  const keep = new Set();
  sh.srcIdx.forEach((v, i) => {
    if (sh.onBoundary[i]) return;
    if (sh.adj[i].some((j) => sh.onBoundary[j])) return;
    keep.add(v);
  });
  coverage[key] = keep;
}
for (const m of bodyParts) {
  const n = m.src.length;
  const mask = new Float32Array(n * 4);
  m.src.forEach((v, i) => {
    mask[i * 4] = coverage.tank.has(v) ? 1 : 0;
    mask[i * 4 + 1] = coverage.pants.has(v) ? 1 : 0;
    mask[i * 4 + 2] = coverage.boots.has(v) ? 1 : 0;
  });
  m.custom = { _MASK: { array: mask, type: 'VEC4' } };
}
log(`outfit: tank ${outfit.tank.indices.length / 3} tris, trousers ${outfit.pants.indices.length / 3}, boots ${outfit.boots.indices.length / 3} (pivot clearance ${(outfit.boots.pivotClearance * 1000).toFixed(1)} mm), belt + pouch`);

// Skin textures -------------------------------------------------------------------------
const TEXDIR = path.join(OUT, 'textures');
fs.mkdirSync(TEXDIR, { recursive: true });
const textureFiles = {};
if (!SKIP_TEX) {
  const nV = world.length / 3;
  const adjacency = new Map();
  for (const f of bodyFaces)
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)).add(b);
      (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)).add(a);
    }
  const lit = vertexLighting(world, restNormals, bodyTris, bodyVerts, adjacency);
  const headVerts = new Set(packed.parts.head.faces.concat(packed.parts.mouth.faces, ...packed.parts.sockets.map((s) => s.faces)).flatMap((f) => f.v));
  for (let v = 0; v < nV; v++) {
    vattr[v * VCOUNT + V.AO] = lit.ao[v];
    vattr[v * VCOUNT + V.THICK] = lit.thick[v];
    vattr[v * VCOUNT + V.CURV] = Math.abs(lit.curv[v]);
    vattr[v * VCOUNT + V.HEAD] = headVerts.has(v) ? 1 : 0;
    vattr[v * VCOUNT + V.BROW] = 0;
  }
  // brow follicle density from the actual brow strand roots (Gaussian splat, sigma 1.6 mm)
  const headList = [...headVerts];
  let maxD = 0;
  for (const st of browStrands) {
    const r = st.root;
    for (const v of headList) {
      const d2 = (world[v * 3] - r.x) ** 2 + (world[v * 3 + 1] - r.y) ** 2 + (world[v * 3 + 2] - r.z) ** 2;
      if (d2 < 0.000025) vattr[v * VCOUNT + V.BROW] += Math.exp(-d2 / (2 * 0.0016 ** 2));
    }
  }
  for (const v of headList) maxD = Math.max(maxD, vattr[v * VCOUNT + V.BROW]);
  for (const v of headList) vattr[v * VCOUNT + V.BROW] = Math.min(1, vattr[v * VCOUNT + V.BROW] / (maxD * 0.6));
  // lash line: dark band where the lashes emerge (sigma 0.8 mm), stored in the NAVEL channel's slot
  for (const v of headList) vattr[v * VCOUNT + V.NAVEL] = 0;
  for (const st of lashStrands) {
    const r = st.root;
    for (const v of headList) {
      const d2 = (world[v * 3] - r.x) ** 2 + (world[v * 3 + 1] - r.y) ** 2 + (world[v * 3 + 2] - r.z) ** 2;
      if (d2 < 0.000009) vattr[v * VCOUNT + V.NAVEL] = Math.max(vattr[v * VCOUNT + V.NAVEL], Math.exp(-d2 / (2 * 0.0009 ** 2)) * (st.kind === 'upper' ? 1 : 0.5));
    }
  }
  log(`vertex AO / thickness / curvature traced for ${bodyVerts.size} vertices`);
  const ctx = skinContext({ rig, eyes, world, bodyVerts, skinTone: recipe.skin.tone, lipTone: recipe.skin.lips });
  const regionOfFace = new Map();
  for (const f of packed.parts.mouth.faces) regionOfFace.set(f, 1);
  for (const sck of packed.parts.sockets) for (const f of sck.faces) regionOfFace.set(f, 2);
  for (const m of bodyParts) {
    const faces = tiles[m.tile];
    m.region = new Int8Array(m.indices.length / 3);
    let t = 0;
    faces.forEach((f) => {
      for (let k = 0; k < f.v.length - 2; k++) m.region[t++] = regionOfFace.get(f) ?? 0;
    });
    const set = bakeTile(m, TEX, vattr, ctx, { head: m.tile === TILE.HEAD });
    textureFiles[TILE_NAMES[m.tile]] = await writeTile(set, TEXDIR, TILE_NAMES[m.tile], { formats: FORMATS });
    log(`baked ${TILE_NAMES[m.tile]} texture set at ${TEX}px`);
  }
  textureFiles.Eye = { BaseColor: await bakeEye(TEXDIR, Math.min(TEX, 1024), FORMATS) };
  textureFiles.Micro = { Normal: await bakeMicroNormal(TEXDIR, 1024, FORMATS) };
}
if (!SKIP_CLOTH) {
  textureFiles.Fabric = await bakeFabricDetails(TEXDIR, 512, FORMATS);
  textureFiles.Flannel = await bakeFlannel(TEXDIR, 1024, FORMATS);
  const loops = outfit.pants.shell.loops;
  const meanY = (L) => L.reduce((a, v) => a + outfit.pants.shell.pos[v * 3 + 1], 0) / L.length;
  const topLoop = loops.indexOf(loops.reduce((a, L) => (meanY(L) > meanY(a) ? L : a)));
  const jobs = [
    ['Tank', outfit.tank, boundaryField(outfit.tank), 4, tankShader(outfit.tank)],
    ['Pants', outfit.pants, boundaryField(outfit.pants, (L, li) => li === topLoop), 4, pantsShader(outfit.pants, rig)],
    ['Boots', outfit.boots, outfit.boots.st, 2, bootShader(outfit.boots)],
  ];
  for (const [name, gm, attrs, K, shade] of jobs) {
    const set = bakeGarment(gm, CLOTH_TEX, attrs, K, shade);
    textureFiles[name] = await writeGarmentSet(set, TEXDIR, name, FORMATS);
    log(`baked ${name} cloth texture set at ${CLOTH_TEX}px`);
  }
}

// 11. Write --------------------------------------------------------------------------------
const g = new CharacterGltf(recipe.name);
g.addSkeleton(rig, locals);
const M = {
  skin: TILE_NAMES.map((t, i) => g.material(`M_Skin_${t}`, { color: [0.8, 0.62, 0.53, 1], roughness: 0.5, extras: { shader: 'skin', tile: t, metresPerUV: metresPerUV[i] } })),
  eye: g.material('M_Eye', { color: [1, 1, 1, 1], roughness: 0.05, extras: { shader: 'eye', ...EYE } }),
  tear: g.material('M_Tearline', { color: [1, 1, 1, 0.0], roughness: 0.02, alphaMode: 'BLEND', extras: { shader: 'tearline' } }),
  teeth: g.material('M_Teeth', { color: [0.93, 0.9, 0.82, 1], roughness: 0.22, extras: { shader: 'teeth' } }),
  gum: g.material('M_Gums', { color: [0.78, 0.36, 0.38, 1], roughness: 0.35, extras: { shader: 'mouth' } }),
  tongue: g.material('M_Tongue', { color: [0.72, 0.36, 0.38, 1], roughness: 0.4, extras: { shader: 'mouth' } }),
  lash: g.material('M_Eyelashes', { color: [0.04, 0.03, 0.025, 1], roughness: 0.5, alphaMode: 'MASK', alphaCutoff: 0.3, doubleSided: true, extras: { shader: 'strand' } }),
  tank: g.material('M_Cloth_Tank', { color: [1, 1, 1, 1], roughness: 1, extras: { shader: 'cloth', fabric: 'rib', maps: 'Tank' } }),
  pants: g.material('M_Cloth_Pants', { color: [1, 1, 1, 1], roughness: 1, extras: { shader: 'cloth', fabric: 'twill', maps: 'Pants' } }),
  boots: g.material('M_Leather_Boots', { color: [1, 1, 1, 1], roughness: 1, extras: { shader: 'cloth', fabric: 'leather', maps: 'Boots' } }),
  sole: g.material('M_Rubber_Sole', { color: [0.035, 0.032, 0.03, 1], roughness: 0.8, extras: { shader: 'cloth', fabric: 'rubber' } }),
  belt: g.material('M_Leather_Belt', { color: [0.06, 0.035, 0.02, 1], roughness: 0.5, extras: { shader: 'cloth', fabric: 'leather' } }),
  metal: g.material('M_Metal_Buckle', { color: [0.55, 0.53, 0.5, 1], roughness: 0.32, metallic: 1, extras: { shader: 'metal' } }),
  pouch: g.material('M_Cloth_Pouch', { color: [0.075, 0.08, 0.06, 1], roughness: 0.85, extras: { shader: 'cloth', fabric: 'cordura' } }),
  flannel: g.material('M_Flannel', { color: [1, 1, 1, 1], roughness: 0.92, extras: { shader: 'flannel' } }),
  baby: g.material('M_BabyHair', { color: [0.06, 0.04, 0.025, 1], roughness: 0.6, alphaMode: 'MASK', alphaCutoff: 0.3, doubleSided: true, extras: { shader: 'strand' } }),
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
g.addMesh({ name: 'SK_BabyHair', ...babyHair, material: M.baby });
g.addMesh({ ...outfit.tank, name: 'SK_Tank', material: M.tank });
g.addMesh({ ...outfit.pants, name: 'SK_Pants', material: M.pants });
g.addMesh({ ...outfit.boots, name: 'SK_Boots', material: M.boots });
outfit.soles.forEach((so, i) => g.addMesh({ name: `SK_Sole_${i ? 'r' : 'l'}`, ...so, normals: computeNormals(so.positions, so.indices, Int32Array.from({ length: so.positions.length / 3 }, (_, k) => k)), material: M.sole }));
g.addMesh({ name: 'SK_Belt', ...outfit.belt, material: M.belt });
g.addMesh({ name: 'SK_Buckle', ...outfit.belt.buckle, material: M.metal });
g.addMesh({ name: 'SK_Pouch', ...outfit.belt.pouch, material: M.pouch });
g.addMesh({ name: 'SK_ShirtTie', ...shirt.tie, normals: computeNormals(shirt.tie.positions, shirt.tie.indices, positionWeld(shirt.tie.positions)), material: M.flannel });
fs.writeFileSync(path.join(OUT, 'hero.glb'), await g.write());

const sidecar = {
  name: recipe.name,
  height,
  units: 'meters',
  up: '+Y',
  forward: '+Z',
  blendshapes: shapeNames,
  eyes: Object.fromEntries(Object.entries(eyes).map(([s, e]) => [s, { center: e.center.toArray(), gaze: e.gaze.toArray(), radius: e.R, ...EYE }])),
  bones: rig.bones.map((b) => ({ name: b.name, parent: b.parent, role: b.role, head: b.head.toArray(), tail: b.tail.toArray() })),
  textures: textureFiles,
  hair: hairMeta,
  outfit: { sole: +(-Math.min(...outfit.soles.map((so) => so.bottomY))).toFixed(4), // body lift so the soles stand on the ground
    garments: ['Tank', 'Pants', 'Boots'], mask: { Tank: 0, Pants: 1, Boots: 2 } },
  // simulated cloth: particle layout in the bind pose (metres), fabric rest dimensions, pins
  overshirt: {
    bone: 'pelvis', W: shirt.W, H: shirt.H, dx: +shirt.dx.toFixed(5), lengths: shirt.lengths.map((l) => +l.toFixed(4)),
    rest: shirt.rest.flatMap((p) => p.toArray().map((x) => +x.toFixed(5))), uv: shirt.uv.map((x) => +x.toFixed(4)),
    pins: shirt.pins, tails: shirt.tails,
  },
  // eye rotation (radians) that each ARKit eyeLook* shape was authored with (lids follow gaze)
  eyeLook: Object.fromEntries([['up', 'eyeLookUpLeft'], ['down', 'eyeLookDownLeft'], ['in', 'eyeLookInLeft'], ['out', 'eyeLookOutLeft']].map(([k, n]) => [k, +(2 * Math.acos(Math.min(1, Math.abs(eyeRot[n].l.w)))).toFixed(4)])),
  colliders: colliders.map(({ world: _w, ...c }) => c),
  textureSize: TEX,
  recipe: { macro: recipe.macro, targets: applied },
};
fs.writeFileSync(path.join(OUT, 'character.json'), JSON.stringify(sidecar, null, 1));
log(`wrote ${path.relative(root, OUT)}/hero.glb (${(fs.statSync(path.join(OUT, 'hero.glb')).size / 1e6).toFixed(2)} MB)`);
void TILE;
