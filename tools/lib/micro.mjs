// Tileable skin micro-normal (detail map). One tile covers ~15 mm of skin: pores on a wrapped
// Worley lattice plus two crossing families of fine furrows with integer frequencies (so the
// pattern repeats seamlessly), and soft periodic bumps.
import sharp from 'sharp';
import path from 'node:path';

const hash = (x, y, s) => {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

export async function bakeMicroNormal(dir, N = 1024, formats = ['webp']) {
  const H = new Float32Array(N * N);
  const cells = 40; // pores per tile edge (~0.38 mm spacing)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N, v = (y + 0.5) / N;
      // pores
      const px = u * cells, py = v * cells;
      const ix = Math.floor(px), iy = Math.floor(py);
      let best = 9, bid = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy;
          const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
          const fx = cx + 0.1 + 0.8 * hash(wx, wy, 1), fy = cy + 0.1 + 0.8 * hash(wx, wy, 2);
          const d = (px - fx) ** 2 + (py - fy) ** 2;
          if (d < best) (best = d), (bid = hash(wx, wy, 3));
        }
      const d = Math.sqrt(best);
      const r = 0.22 + 0.16 * bid;
      let h = d < r ? -((1 - d / r) ** 2) * (0.6 + 0.8 * bid) : 0;
      // crossing furrows (integer frequencies keep the tile seamless)
      const warp = 0.35 * Math.sin(2 * Math.PI * (3 * u + 2 * v)) + 0.25 * Math.sin(2 * Math.PI * (5 * v - 4 * u));
      const f1 = 31 * u + 22 * v + warp, f2 = 31 * u - 22 * v + warp * 0.8;
      const g1 = Math.exp(-(((((f1 % 1) + 1) % 1 - 0.5) / 0.09) ** 2));
      const g2 = Math.exp(-(((((f2 % 1) + 1) % 1 - 0.5) / 0.09) ** 2));
      h -= 0.35 * (g1 + g2);
      // soft periodic bumps
      h += 0.15 * Math.sin(2 * Math.PI * (7 * u + 3 * v)) * Math.sin(2 * Math.PI * (2 * u - 9 * v));
      H[y * N + x] = h;
    }
  // height -> normal (wrapped central differences)
  const buf = Buffer.alloc(N * N * 3);
  const strength = 2.2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const hx = H[y * N + ((x + 1) % N)] - H[y * N + ((x - 1 + N) % N)];
      const hy = H[((y + 1) % N) * N + x] - H[((y - 1 + N) % N) * N + x];
      let nx = -hx * strength, ny = hy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * N + x) * 3;
      buf[i] = Math.round((nx * 0.5 + 0.5) * 255);
      buf[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      buf[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  const files = {};
  for (const f of formats) {
    const file = path.join(dir, `T_Skin_MicroNormal.${f}`);
    const img = sharp(buf, { raw: { width: N, height: N, channels: 3 } });
    await (f === 'png' ? img.png() : img.webp({ quality: 95 })).toFile(file);
    files[f] = path.basename(file);
  }
  return files;
}
