// Tileable fabric detail maps (applied tri-planar in bind space at runtime, so they need no UVs and
// keep a constant physical scale on every garment). One RGBA image per fabric:
//   RG = tangent-space normal xy, B = cavity (1 open .. 0 deep), A = fibre/colour variation (0.5 neutral).
// Every pattern uses integer frequencies / wrapped lattices so the tile repeats seamlessly.
import sharp from 'sharp';
import path from 'node:path';

const hash = (x, y, s) => {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};
const wrap = (i, p) => ((i % p) + p) % p;
const fade = (t) => t * t * (3 - 2 * t);
const frac = (x) => x - Math.floor(x);

/** Periodic value noise over the unit tile with px x py cells. */
function pnoise(u, v, px, py, seed) {
  const x = u * px, y = v * py;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = hash(wrap(ix, px), wrap(iy, py), seed), b = hash(wrap(ix + 1, px), wrap(iy, py), seed);
  const c = hash(wrap(ix, px), wrap(iy + 1, py), seed), d = hash(wrap(ix + 1, px), wrap(iy + 1, py), seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function pfbm(u, v, px, py, oct, seed) {
  let s = 0, amp = 0.5, n = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * pnoise(u, v, px, py, seed + o);
    n += amp;
    px *= 2;
    py *= 2;
    amp *= 0.5;
  }
  return s / n;
}
/** Periodic Worley: distances to the nearest two feature points (cells per tile = p). */
function pworley(u, v, p, seed, out) {
  const x = u * p, y = v * p;
  const ix = Math.floor(x), iy = Math.floor(y);
  let d1 = 9, d2 = 9, id = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const wx = wrap(cx, p), wy = wrap(cy, p);
      const fx = cx + 0.15 + 0.7 * hash(wx, wy, seed), fy = cy + 0.15 + 0.7 * hash(wx, wy, seed + 1);
      const d = Math.hypot(x - fx, y - fy);
      if (d < d1) (d2 = d1), (d1 = d), (id = hash(wx, wy, seed + 2));
      else if (d < d2) d2 = d;
    }
  out.d1 = d1; out.d2 = d2; out.id = id;
  return out;
}

/**
 * Pattern definitions. size = physical tile edge (m); fn(u, v) -> {h, cav, var} with h in
 * "tile units" (scaled by `relief` when converting to normals).
 */
export const FABRICS = {
  // 1x1 rib knit: alternating raised knit wales (chains of V loops) and sunken purl wales
  rib: {
    size: 0.016,
    relief: 0.0006,
    fn(u, v) {
      const wales = 16, courses = 20;
      const x = u * wales, y = v * courses;
      const w = Math.floor(x), fx = x - w, fy = frac(y);
      const knit = w % 2 === 0;
      const yarn = 0.15 * (pfbm(u, v, 8, 8, 3, 11) - 0.5) + 0.06 * (pnoise(u, v, 160, 6, 17) - 0.5);
      let h;
      if (knit) {
        // two legs of the V loop, leaning in and stacked course over course
        const lean = 0.16 * (fy - 0.5);
        const l = Math.exp(-(((fx - 0.3 - lean) / 0.17) ** 2)), r = Math.exp(-(((fx - 0.7 + lean) / 0.17) ** 2));
        const loop = 0.55 + 0.45 * Math.sin(Math.PI * fy) ** 0.7;
        h = Math.max(l, r) * loop;
      } else {
        h = -0.35 + 0.15 * Math.sin(Math.PI * fx) * (0.5 + 0.5 * Math.cos(2 * Math.PI * fy));
      }
      h += yarn;
      return { h, cav: knit ? 1 - 0.25 * (1 - Math.max(0, h)) : 0.62, var: 0.5 + yarn * 1.6 + (knit ? 0.03 : -0.04) };
    },
  },
  // 3/1 cotton twill (chino/cargo): steep diagonal wales with visible warp floats and slubs
  twill: {
    size: 0.008,
    relief: 0.00018,
    fn(u, v) {
      const lines = 14;
      const d = u * lines + v * lines * 2; // ~63 deg wales
      const fd = frac(d);
      const wale = Math.sin(Math.PI * fd) ** 1.5;
      // warp yarn floats along the wale
      const along = frac(v * lines * 3 - u * lines * 1.5);
      const float = 0.5 + 0.5 * Math.cos(2 * Math.PI * along);
      const slub = pfbm(u, v, 2, 16, 3, 23) - 0.5;
      const h = wale * (0.75 + 0.25 * float) + 0.25 * slub;
      return { h, cav: 0.7 + 0.3 * wale, var: 0.5 + 0.35 * slub + 0.05 * (wale - 0.5) };
    },
  },
  // full-grain leather: pebbled grain cells, fine crease network and pores
  leather: {
    size: 0.03,
    relief: 0.00012,
    fn(u, v) {
      const W = {};
      pworley(u, v, 34, 31, W);
      const pebble = Math.min(1, (W.d2 - W.d1) * 2.2) ** 0.6 * (0.8 + 0.4 * W.id);
      pworley(u, v, 9, 37, W);
      const crease = Math.exp(-(((W.d2 - W.d1) / 0.06) ** 2));
      const pore = (() => {
        pworley(u, v, 90, 41, W);
        return W.d1 < 0.12 && W.id > 0.55 ? -(1 - W.d1 / 0.12) : 0;
      })();
      const broad = pfbm(u, v, 3, 3, 3, 43) - 0.5;
      const h = 0.8 * pebble - 0.3 * crease + 0.3 * pore + 0.4 * broad;
      return { h, cav: 1 - 0.2 * crease + 0.15 * pore, var: 0.5 + 0.25 * broad - 0.12 * crease + 0.06 * (pebble - 0.5) };
    },
  },
  // 1000D nylon (cordura) basket weave
  cordura: {
    size: 0.008,
    relief: 0.0003,
    fn(u, v) {
      const n = 10;
      const x = u * n, y = v * n;
      const cx = Math.floor(x), cy = Math.floor(y), fx = x - cx, fy = y - cy;
      const horiz = (Math.floor(cx / 1) + Math.floor(cy / 1)) % 2 === 0;
      const across = horiz ? fy : fx;
      const yarns = Math.sin(Math.PI * frac(across * 2)) ** 0.8;
      const edge = Math.sin(Math.PI * (horiz ? fx : fy)) ** 0.35;
      const h = yarns * edge + 0.1 * (pfbm(u, v, 16, 16, 2, 51) - 0.5);
      return { h, cav: 0.65 + 0.35 * yarns * edge, var: 0.5 + 0.1 * (pnoise(u, v, 40, 40, 53) - 0.5) };
    },
  },
  // moulded rubber: chunky lug blocks with siping, plus speckle
  rubber: {
    size: 0.03,
    relief: 0.0012,
    fn(u, v) {
      const n = 5;
      const x = u * n, y = v * n * 2;
      const row = Math.floor(y);
      const fx = frac(x + (row % 2) * 0.5), fy = frac(y);
      const block = Math.min(fx, 1 - fx, fy, 1 - fy);
      const lug = Math.min(1, block / 0.12);
      const sipe = Math.exp(-(((fx - 0.5) / 0.03) ** 2)) * (fy > 0.2 && fy < 0.8 ? 1 : 0);
      const speck = pnoise(u, v, 120, 120, 61) - 0.5;
      const h = lug - 0.5 * sipe + 0.05 * speck;
      return { h, cav: 0.55 + 0.45 * lug - 0.3 * sipe, var: 0.5 + 0.15 * speck };
    },
  },
};

/** Bakes every fabric tile; returns { name: { file, size } } for the sidecar. */
export async function bakeFabricDetails(dir, N = 512, formats = ['webp']) {
  const out = {};
  for (const [name, F] of Object.entries(FABRICS)) {
    const H = new Float32Array(N * N), C = new Float32Array(N * N), Vr = new Float32Array(N * N);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const r = F.fn((x + 0.5) / N, (y + 0.5) / N);
        const i = y * N + x;
        H[i] = r.h; C[i] = r.cav; Vr[i] = r.var;
      }
    // tile units -> metres: slope = dh * relief / (texel size)
    const texel = F.size / N;
    const buf = Buffer.alloc(N * N * 4);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const hx = (H[y * N + ((x + 1) % N)] - H[y * N + ((x - 1 + N) % N)]) * F.relief / (2 * texel);
        const hy = (H[((y + 1) % N) * N + x] - H[((y - 1 + N) % N) * N + x]) * F.relief / (2 * texel);
        let nx = -hx, ny = hy, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l;
        buf[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
        buf[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        buf[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, C[i])) * 255);
        buf[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, Vr[i])) * 255);
      }
    const files = {};
    for (const f of formats) {
      const file = path.join(dir, `T_Fabric_${name[0].toUpperCase()}${name.slice(1)}_Detail.${f}`);
      const img = sharp(buf, { raw: { width: N, height: N, channels: 4 } });
      await (f === 'png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality: 96, alphaQuality: 100, effort: 4 })).toFile(file);
      files[f] = path.basename(file);
    }
    out[name] = { files, size: F.size };
  }
  return out;
}
