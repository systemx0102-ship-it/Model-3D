// Re-packs the MakeHuman single-tile body UVs into three texture sets (UDIM-style):
//   0 HEAD  – head (incl. ears), mouth interior, eye sockets
//   1 BODY  – torso / arms / legs island
//   2 LIMBS – hands and feet (high texel density for fingers and nails)
// Islands are moved and uniformly scaled only, so the authored UV flow is preserved.

export const TILE = { HEAD: 0, BODY: 1, LIMBS: 2 };
export const TILE_NAMES = ['Head', 'Body', 'Limbs'];

export function islands(faces, uvs) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const f of faces) for (const t of f.t) if (!parent.has(t)) parent.set(t, t);
  for (const f of faces)
    for (let i = 1; i < f.t.length; i++) {
      const a = find(f.t[0]), b = find(f.t[i]);
      if (a !== b) parent.set(a, b);
    }
  const map = new Map();
  for (const f of faces) {
    const r = find(f.t[0]);
    if (!map.has(r)) map.set(r, { id: r, faces: [], vts: new Set(), min: [Infinity, Infinity], max: [-Infinity, -Infinity] });
    const I = map.get(r);
    I.faces.push(f);
    for (const t of f.t) {
      I.vts.add(t);
      I.min[0] = Math.min(I.min[0], uvs[t * 2]); I.min[1] = Math.min(I.min[1], uvs[t * 2 + 1]);
      I.max[0] = Math.max(I.max[0], uvs[t * 2]); I.max[1] = Math.max(I.max[1], uvs[t * 2 + 1]);
    }
  }
  return [...map.values()];
}

/**
 * @param positions  source positions (any units; only relative height/side is used)
 * @returns {uvs: Float32Array (new, per vt index), tileOfVt: Int8Array, tileOfFace: Map(face->tile)}
 */
export function repack(faces, uvs, positions) {
  const isl = islands(faces, uvs);
  for (const I of isl) {
    let y = 0, x = 0, n = 0;
    for (const f of I.faces) for (const v of f.v) (y += positions[v * 3 + 1]), (x += positions[v * 3]), n++;
    I.meanY = y / n; I.meanX = x / n; I.size = [I.max[0] - I.min[0], I.max[1] - I.min[1]];
    I.count = I.faces.length;
  }
  // Classify islands by where their geometry lives (positions in MakeHuman base units).
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) (minY = Math.min(minY, positions[i])), (maxY = Math.max(maxY, positions[i]));
  const H = maxY - minY;
  const body = isl.reduce((a, b) => (b.count > a.count ? b : a));
  const others = isl.filter((I) => I !== body);
  const head = others.filter((I) => I.meanY > body.meanY + 0.25 * H).reduce((a, b) => (b.count > a.count ? b : a));
  const rest = others.filter((I) => I !== head);
  const hands = rest.filter((I) => Math.abs(I.meanX) > 0.25 * H).sort((a, b) => a.meanX - b.meanX);
  const feet = rest.filter((I) => I.meanY < body.meanY - 0.25 * H).sort((a, b) => a.meanX - b.meanX);
  const sockets = rest
    .filter((I) => !hands.includes(I) && !feet.includes(I) && I.meanY > head.meanY - 0.05 * H && Math.abs(I.meanX) > 0.01 * H)
    .sort((a, b) => a.meanX - b.meanX);
  const mouth = rest.filter((I) => !hands.includes(I) && !feet.includes(I) && !sockets.includes(I));
  if (hands.length !== 2 || feet.length !== 2 || sockets.length !== 2 || mouth.length !== 1)
    throw new Error(`uvpack: unexpected island classification h${hands.length} f${feet.length} s${sockets.length} m${mouth.length}`);

  const out = new Float32Array(uvs.length);
  const tileOfVt = new Int8Array(uvs.length / 2).fill(-1);
  const place = (I, tile, s, ox, oy) => {
    if ((I.size[0] * s + ox) > 1.0001 || (I.size[1] * s + oy) > 1.0001) throw new Error('uvpack: island exceeds tile');
    I.tile = tile; I.scale = s;
    for (const t of I.vts) {
      out[t * 2] = (uvs[t * 2] - I.min[0]) * s + ox;
      out[t * 2 + 1] = (uvs[t * 2 + 1] - I.min[1]) * s + oy;
      tileOfVt[t] = tile;
    }
  };
  const m = 0.012; // gutter
  // HEAD tile
  const sH = (1 - 2 * m) / head.size[1];
  place(head, TILE.HEAD, sH, m, m);
  const colX = m + head.size[0] * sH + 2 * m;
  place(mouth[0], TILE.HEAD, sH, colX, 1 - m - mouth[0].size[1] * sH);
  place(sockets[0], TILE.HEAD, sH, colX, m);
  place(sockets[1], TILE.HEAD, sH, colX + sockets[0].size[0] * sH + 2 * m, m);
  // BODY tile
  const sB = Math.min((1 - 2 * m) / body.size[1], (1 - 2 * m) / body.size[0]);
  place(body, TILE.BODY, sB, m, m);
  // LIMBS tile: 2x2 grid, hands on top
  const cell = 0.5 - 2 * m;
  const sL = Math.min(...[...hands, ...feet].map((I) => cell / Math.max(I.size[0], I.size[1])));
  place(hands[0], TILE.LIMBS, sL, m, 0.5 + m);
  place(hands[1], TILE.LIMBS, sL, 0.5 + m, 0.5 + m);
  place(feet[0], TILE.LIMBS, sL, m, m);
  place(feet[1], TILE.LIMBS, sL, 0.5 + m, m);

  const tileOfFace = new Map();
  for (const I of isl) for (const f of I.faces) tileOfFace.set(f, I.tile);
  const report = { head: sH, body: sB, limbs: sL };
  return { uvs: out, tileOfVt, tileOfFace, report, parts: { head, mouth: mouth[0], sockets, hands, feet, body } };
}
