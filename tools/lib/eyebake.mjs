// Eye albedo: procedural iris (radial stroma fibres, crypts, collarette, contraction furrows,
// limbal ring) and sclera (warm off-white, conjunctival vessels concentrated at the canthi).
// UV layout matches eyeballMesh: planar projection along the gaze, image top = eye top.
import sharp from 'sharp';
import path from 'node:path';
import { fbm, worley, smoothstep, mix, vnoise } from './noise.mjs';
import { EYE } from './eyes.mjs';

const toSrgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

export const IRIS = {
  pupil: 0.33, // pupil radius / iris radius at the baked (mid) dilation
  inner: [0.32, 0.15, 0.045], // amber-brown around the collarette (linear)
  outer: [0.085, 0.13, 0.085], // grey-green ciliary zone
  limbal: [0.02, 0.026, 0.022],
};

export async function bakeEye(dir, N = 1024, formats = ['webp']) {
  const buf = Buffer.alloc(N * N * 3);
  const o = { dx: 0, dy: 0, dz: 0, id: 0 };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const ex = ((x + 0.5) / N - 0.5) * 2; // eye-local, units of R
      const ey = (0.5 - (y + 0.5) / N) * 2;
      const r = Math.hypot(ex, ey);
      const th = Math.atan2(ey, ex);
      let cr, cg, cb;
      const rho = r / EYE.limbus; // 0 centre .. 1 limbus
      // sclera
      {
        const n = fbm(ex, ey, 0, 6, 3, 5, null);
        cr = 0.64 + 0.03 * n; cg = 0.57 + 0.025 * n; cb = 0.52 + 0.02 * n;
        // conjunctival vessels: ridged noise lines, radial bias, denser toward the canthi
        const canthus = Math.pow(Math.abs(Math.cos(th)), 1.5);
        const vmask = smoothstep(1.15, 1.75, rho) * (0.12 + 0.88 * canthus) * 0.75;
        const wv = fbm(Math.cos(th) * 3 + r * 1.2, Math.sin(th) * 3 + r * 1.2, r * 2, 2.5, 4, 7, null);
        const vessel = smoothstep(0.055, 0.0, Math.abs(wv)) * vmask;
        const fine = smoothstep(0.03, 0.0, Math.abs(fbm(ex * 3, ey * 3, 1, 4, 4, 8, null))) * vmask * 0.6;
        const v = Math.min(1, vessel + fine);
        cr = mix(cr, 0.55, v * 0.45); cg = mix(cg, 0.16, v * 0.45); cb = mix(cb, 0.14, v * 0.45);
        // slight pink/yellow at the periphery, cleaner near the limbus
        cr *= mix(1, 1.05, smoothstep(1.2, 2, rho)); cb *= mix(1, 0.9, smoothstep(1.2, 2, rho));
      }
      if (rho < 1.08) {
        const pr = IRIS.pupil;
        const rr = (rho - pr) / (1 - pr); // 0 at pupil edge .. 1 at limbus
        // radial fibres: noise stretched along the radius
        const fib = fbm(Math.cos(th) * 0.0 + th * 9, rho * 2.2, 0.5, 1, 4, 21, null);
        const fib2 = fbm(th * 26, rho * 4, 1.7, 1, 3, 22, null);
        const collar = 0.38 + 0.03 * vnoise(th * 7, 0, 0, 23);
        let ir = mix(IRIS.inner[0], IRIS.outer[0], smoothstep(collar - 0.08, collar + 0.22, rr));
        let ig = mix(IRIS.inner[1], IRIS.outer[1], smoothstep(collar - 0.08, collar + 0.22, rr));
        let ib = mix(IRIS.inner[2], IRIS.outer[2], smoothstep(collar - 0.08, collar + 0.22, rr));
        const fibre = 1 + 0.45 * fib + 0.25 * fib2;
        ir *= fibre; ig *= fibre; ib *= fibre;
        // collarette ridge (lighter), pupillary ruff (dark rim at the pupil edge)
        const ridge = Math.exp(-(((rr - collar) / 0.035) ** 2));
        ir *= 1 + 0.5 * ridge; ig *= 1 + 0.45 * ridge; ib *= 1 + 0.3 * ridge;
        const ruff = smoothstep(0.06, 0.0, rr);
        ir *= 1 - 0.6 * ruff; ig *= 1 - 0.6 * ruff; ib *= 1 - 0.6 * ruff;
        // crypts of Fuchs: dark lacunae just outside the collarette
        const d = worley(Math.cos(th) * rho, Math.sin(th) * rho, 0, 0.07, 31, o);
        const crypt = smoothstep(0.03, 0.0, d) * smoothstep(collar - 0.02, collar + 0.05, rr) * smoothstep(0.85, 0.6, rr) * (o.id > 0.45 ? 1 : 0);
        ir *= 1 - 0.55 * crypt; ig *= 1 - 0.55 * crypt; ib *= 1 - 0.5 * crypt;
        // contraction furrows
        const furrow = Math.exp(-(((rr - 0.72 - 0.015 * vnoise(th * 5, 1, 0, 32)) / 0.012) ** 2)) + Math.exp(-(((rr - 0.86) / 0.01) ** 2)) * 0.6;
        ir *= 1 - 0.35 * furrow; ig *= 1 - 0.35 * furrow; ib *= 1 - 0.35 * furrow;
        // limbal ring
        const limb = smoothstep(0.8, 1.0, rho);
        ir = mix(ir, IRIS.limbal[0], limb * 0.85); ig = mix(ig, IRIS.limbal[1], limb * 0.85); ib = mix(ib, IRIS.limbal[2], limb * 0.85);
        // pupil
        const pupil = smoothstep(pr + 0.012, pr - 0.004, rho);
        ir = mix(ir, 0.004, pupil); ig = mix(ig, 0.004, pupil); ib = mix(ib, 0.005, pupil);
        // blend into the sclera across a soft limbus
        const t = smoothstep(1.08, 0.98, rho);
        cr = mix(cr, ir, t); cg = mix(cg, ig, t); cb = mix(cb, ib, t);
      }
      const i = (y * N + x) * 3;
      buf[i] = Math.round(Math.min(1, toSrgb(cr)) * 255);
      buf[i + 1] = Math.round(Math.min(1, toSrgb(cg)) * 255);
      buf[i + 2] = Math.round(Math.min(1, toSrgb(cb)) * 255);
    }
  const files = {};
  for (const f of formats) {
    const file = path.join(dir, `T_Eye_BaseColor.${f}`);
    const img = sharp(buf, { raw: { width: N, height: N, channels: 3 } });
    await (f === 'png' ? img.png({ compressionLevel: 9 }) : img.webp({ quality: 94 })).toFile(file);
    files[f] = path.basename(file);
  }
  return files;
}
