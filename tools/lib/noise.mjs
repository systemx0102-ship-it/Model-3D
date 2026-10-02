// Deterministic 3D noise with analytic gradients (for baking height -> normal without
// finite-difference blur). All functions write the gradient into a caller-provided array.

const hash = (x, y, z, s = 0) => {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(s, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
};
export const hash01 = (x, y, z, s = 0) => hash(x, y, z, s) / 4294967296;

/** Value noise in [-1,1] with analytic gradient (quintic fade). g: [gx,gy,gz] out. */
export function vnoise(x, y, z, seed, g) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const duz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const a = hash01(ix, iy, iz, seed), b = hash01(ix + 1, iy, iz, seed);
  const c = hash01(ix, iy + 1, iz, seed), d = hash01(ix + 1, iy + 1, iz, seed);
  const e = hash01(ix, iy, iz + 1, seed), f = hash01(ix + 1, iy, iz + 1, seed);
  const gg = hash01(ix, iy + 1, iz + 1, seed), h = hash01(ix + 1, iy + 1, iz + 1, seed);
  const k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + gg, k6 = a - b - e + f, k7 = -a + b + c - d + e - f - gg + h;
  const v = a + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;
  if (g) {
    g[0] = 2 * dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz);
    g[1] = 2 * duy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux);
    g[2] = 2 * duz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy);
  }
  return 2 * v - 1;
}

/** fBm of value noise; frequency in 1/m. Returns value, gradient in g. */
export function fbm(x, y, z, freq, octaves, seed, g, gain = 0.5, lac = 2.03) {
  let v = 0, amp = 1, f = freq, norm = 0;
  const t = [0, 0, 0];
  if (g) g[0] = g[1] = g[2] = 0;
  for (let o = 0; o < octaves; o++) {
    v += amp * vnoise(x * f, y * f, z * f, seed + o * 17, g ? t : null);
    if (g) (g[0] += amp * f * t[0]), (g[1] += amp * f * t[1]), (g[2] += amp * f * t[2]);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  if (g) (g[0] /= norm), (g[1] /= norm), (g[2] /= norm);
  return v / norm;
}

/**
 * Cellular (Worley) F1 in 3D. cell = feature spacing (m). Returns distance (m) to the nearest
 * jittered feature point; out = {dx,dy,dz,id} vector from feature to p and a per-cell random.
 */
export function worley(x, y, z, cell, seed, out) {
  const px = x / cell, py = y / cell, pz = z / cell;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let best = 1e9, bx = 0, by = 0, bz = 0, bid = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const h = hash(cx, cy, cz, seed);
        const fx = cx + (h & 1023) / 1023 * 0.9 + 0.05;
        const fy = cy + ((h >>> 10) & 1023) / 1023 * 0.9 + 0.05;
        const fz = cz + ((h >>> 20) & 1023) / 1023 * 0.9 + 0.05;
        const ex = px - fx, ey = py - fy, ez = pz - fz;
        const d = ex * ex + ey * ey + ez * ez;
        if (d < best) (best = d), (bx = ex), (by = ey), (bz = ez), (bid = h);
      }
  const dist = Math.sqrt(best) * cell;
  if (out) (out.dx = bx * cell), (out.dy = by * cell), (out.dz = bz * cell), (out.id = (bid >>> 7) / 33554432);
  return dist;
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const mix = (a, b, t) => a + (b - a) * t;
