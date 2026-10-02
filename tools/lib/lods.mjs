// Levels of detail.
//  * Runtime (web): LOD1-3 are alternative index buffers over the LOD0 vertices (meshoptimizer,
//    borders locked so separate body tiles never crack), written to lods.bin. Switching LOD is an
//    index-buffer swap: skinning, blendshapes and materials are untouched.
//  * Engines: standalone hero_LOD1..3.glb with compacted vertices (gltf-transform + meshoptimizer);
//    LOD2/3 drop the facial blendshapes and the small facial parts that cannot be seen at range.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, Logger } from '@gltf-transform/core';
import { simplify, weld, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

export const LOD_LEVELS = [
  { ratio: 0.5, error: 0.004 },
  { ratio: 0.25, error: 0.012 },
  { ratio: 0.1, error: 0.04 },
];
// parts hidden from a given LOD on (small and facial detail)
const HIDE_FROM = [
  [/^SK_(Tearline|BabyHair|Eyelashes)/, 2],
  [/^SK_Eyebrows/, 2],
  [/^SK_(Teeth|Gums|Tongue)/, 3],
];
const hiddenAt = (name, lod) => HIDE_FROM.some(([re, from]) => re.test(name) && lod >= from);

export async function buildLods(glbFile, outDir) {
  await MeshoptSimplifier.ready;
  const io = new NodeIO();
  const doc = await io.read(glbFile);
  // ---- runtime index LODs ---------------------------------------------------------------------
  const chunks = [];
  let offset = 0;
  const meshes = {};
  for (const mesh of doc.getRoot().listMeshes()) {
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute('POSITION').getArray();
    const idx = Uint32Array.from(prim.getIndices().getArray());
    const levels = [];
    for (let l = 0; l < LOD_LEVELS.length; l++) {
      const lod = l + 1;
      if (hiddenAt(mesh.getName(), lod)) {
        levels.push(null);
        continue;
      }
      const { ratio, error } = LOD_LEVELS[l];
      const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3);
      const mask = prim.getAttribute('_MASK')?.getArray();
      let out, err;
      if (mask) {
        // skin under garments: keep the coverage boundary exactly (locked vertices) and weigh the
        // mask as an attribute, so no simplified triangle straddles covered and visible skin
        const nv = pos.length / 3;
        const lock = new Uint8Array(nv);
        const covered = (v) => mask[v * 4] + mask[v * 4 + 1] + mask[v * 4 + 2] > 0.5;
        for (let t = 0; t < idx.length; t += 3) {
          const c = [covered(idx[t]), covered(idx[t + 1]), covered(idx[t + 2])];
          if (c[0] !== c[1] || c[1] !== c[2]) for (let k = 0; k < 3; k++) lock[idx[t + k]] = 1;
        }
        [out, err] = MeshoptSimplifier.simplifyWithAttributes(idx, Float32Array.from(pos), 3, Float32Array.from(mask), 4, [1, 1, 1, 1], lock, target, error, ['LockBorder']);
      } else [out, err] = MeshoptSimplifier.simplify(idx, Float32Array.from(pos), 3, target, error, ['LockBorder']);
      const res = Uint32Array.from(out);
      chunks.push(Buffer.from(res.buffer));
      levels.push({ offset, count: res.length, error: +err.toFixed(5) });
      offset += res.byteLength;
    }
    meshes[mesh.getName()] = { lod0: idx.length, levels };
  }
  fs.writeFileSync(path.join(outDir, 'lods.bin'), Buffer.concat(chunks));

  // ---- engine LOD files -----------------------------------------------------------------------
  const files = [];
  for (let l = 0; l < LOD_LEVELS.length; l++) {
    const lod = l + 1;
    const d = await io.read(glbFile);
    d.setLogger(new Logger(Logger.Verbosity.WARN));
    for (const node of d.getRoot().listNodes()) {
      const m = node.getMesh();
      if (!m) continue;
      if (hiddenAt(m.getName(), lod)) {
        node.dispose();
        m.dispose();
        continue;
      }
      m.setName(`${m.getName()}_LOD${lod}`);
      if (lod >= 2)
        for (const p of m.listPrimitives()) {
          for (const t of p.listTargets()) t.dispose();
          m.setWeights([]);
          const ex = m.getExtras();
          if (ex?.targetNames) m.setExtras({ ...ex, targetNames: [] });
        }
    }
    const { ratio, error } = LOD_LEVELS[l];
    await d.transform(prune(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: true }), prune());
    const file = `hero_LOD${lod}.glb`;
    await io.write(path.join(outDir, file), d);
    files.push(file);
  }
  return { file: 'lods.bin', levels: LOD_LEVELS, meshes, engineFiles: files };
}
