// Scalp / hairline definition shared by the skin texture bake (follicle tint under the hair)
// and the hair groom (root placement, density, baby hairs). Coordinates are relative to the
// midpoint between the eye centres: x = character left, y = up, z = forward (metres).

import { vnoise } from '../tools/lib/noise.mjs';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Hairline height (y, relative to eye level) as a function of azimuth around the skull centre
// (0 = front, ±pi = back). Female hairline: rounded front with a slight widow's peak, soft temple
// recession, sideburns reaching ear-top level, then down behind the ears to the nape.
const KEYS = [
  [0, 0.071],
  [0.18, 0.069],
  [0.42, 0.06], // temple recession
  [0.72, 0.034],
  [1.02, 0.006], // sideburn, in front of the ear
  [1.32, 0.012], // above the ear
  [1.62, -0.012], // behind the ear (mastoid)
  [2.1, -0.05],
  [2.6, -0.078],
  [Math.PI, -0.085], // nape
];

function hairlineY(az) {
  const a = Math.abs(az);
  for (let i = 1; i < KEYS.length; i++)
    if (a <= KEYS[i][0]) {
      const [a0, y0] = KEYS[i - 1], [a1, y1] = KEYS[i];
      const t = (a - a0) / (a1 - a0);
      const s = t * t * (3 - 2 * t);
      return y0 + (y1 - y0) * s;
    }
  return KEYS.at(-1)[1];
}

export const SKULL_CENTER = [0, 0.028, -0.075]; // relative to the eye midpoint

/**
 * @param p        point relative to the eye midpoint ([x,y,z], metres)
 * @param earMask  0..1, excludes the ears
 * @returns {scalp: 0..1 density, edge: 0..1 closeness to the hairline (baby hair band), az}
 */
export function scalp(p, earMask = 0) {
  const x = p[0] - SKULL_CENTER[0];
  const z = p[2] - SKULL_CENTER[2];
  const az = Math.atan2(x, z);
  // irregular, slightly asymmetric hairline (a few millimetres of noise)
  const n = vnoise(p[0] * 90 + 3.1, p[1] * 90, p[2] * 90, 911) * 0.0035 + vnoise(p[0] * 300, p[1] * 300, p[2] * 300, 913) * 0.0012;
  const line = hairlineY(az) + n + (p[0] > 0 ? 0.0015 : 0);
  const above = p[1] - line;
  const density = smooth(-0.002, 0.009, above) * (1 - earMask);
  const edge = Math.exp(-((above - 0.003) ** 2) / (2 * 0.004 ** 2)) * (1 - earMask);
  // face guard: never grow hair on the forehead/face below the brows
  const face = smooth(0.0, 0.03, z) * smooth(0.066, 0.05, p[1]) * smooth(0.062, 0.045, Math.abs(x));
  return { scalp: density * (1 - face), edge: edge * (1 - face), az, above };
}
