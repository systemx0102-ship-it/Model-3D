// Procedural skin material bake. Every texel is evaluated from its 3D rest position, so detail
// is continuous across UV seams and has physical scale (pores ~0.3-0.5 mm, lines in mm).
//
// Outputs per texture set: albedo (linear), roughness, height (+ analytic 3D gradient -> tangent
// normal), cavity, plus head-only dynamic wrinkle height and region masks.
import { vnoise, fbm, worley, smoothstep, clamp01, mix } from './noise.mjs';
import { scalp } from '../../character/hairline.mjs';

export const V = {
  LIPS: 0, NOSE: 1, CHEEK: 2, EAR: 3, UNDEREYE: 4, LID: 5, BROW: 6, CHIN: 7, FOREHEAD: 8,
  BREAST: 9, AO: 10, THICK: 11, CURV: 12, NECK: 13, NAVEL: 14, HEAD: 15,
};
export const VCOUNT = 16;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b, o = [0, 0, 0]) => ((o[0] = a[0] - b[0]), (o[1] = a[1] - b[1]), (o[2] = a[2] - b[2]), o);

/**
 * Line field: soft grooves along iso-lines of u = (p·dir)/spacing (+ warp). Adds height and
 * gradient for a groove profile exp(-(d/w)^2), d = distance to the nearest integer of u.
 */
function grooves(p, dir, spacing, width, depth, warpAmp, warpFreq, seed, acc, mask = 1) {
  if (mask <= 0.001 || depth === 0) return 0;
  const g = [0, 0, 0];
  const w = warpAmp ? fbm(p[0], p[1], p[2], warpFreq, 2, seed, g) * warpAmp : 0;
  const u = dot(p, dir) / spacing + w;
  const f = u - Math.round(u);
  const k = (spacing * f) / width;
  const e = Math.exp(-k * k);
  const h = -depth * e * mask;
  // dh/du = depth*e*2k*(spacing/width)
  const dhdu = depth * e * 2 * k * (spacing / width) * mask;
  const sx = dir[0] / spacing + (warpAmp ? g[0] * warpAmp : 0);
  const sy = dir[1] / spacing + (warpAmp ? g[1] * warpAmp : 0);
  const sz = dir[2] / spacing + (warpAmp ? g[2] * warpAmp : 0);
  acc.h += h;
  acc.gx += dhdu * sx; acc.gy += dhdu * sy; acc.gz += dhdu * sz;
  return e * mask;
}

/** Pores: Worley pits with per-pore random size/depth. */
function pores(p, cell, depth, seed, acc, rough) {
  if (depth <= 0) return 0;
  const o = { dx: 0, dy: 0, dz: 0, id: 0 };
  const d = worley(p[0], p[1], p[2], cell, seed, o);
  const r = cell * (0.22 + 0.2 * o.id);
  if (d >= r || d < 1e-9) return 0;
  const t = 1 - d / r; // 1 at centre
  const dep = depth * (0.55 + 0.9 * ((o.id * 7.31) % 1));
  acc.h += -dep * t * t;
  // d/dd of -dep*t^2 = 2*dep*t / r ; direction = (p - feature)/d
  const s = (2 * dep * t) / r / d;
  acc.gx += s * o.dx; acc.gy += s * o.dy; acc.gz += s * o.dz;
  rough.v += 0.1 * t;
  return t;
}

export function makeSkinShader(ctx) {
  const tone = ctx.skinTone; // linear albedo
  const lip = ctx.lipTone;
  const eyeMid = ctx.eyeMid;
  const up = ctx.headUp; // head up axis (world)
  const tmp = [0, 0, 0];
  const g3 = [0, 0, 0];

  return function shade(P, N, Tn, Bn, Vt, region, out) {
    const acc = { h: 0, gx: 0, gy: 0, gz: 0 };
    const rough = { v: 0 };
    let r = tone[0], g = tone[1], b = tone[2];
    let rgh;
    out.wh = 0; out.wgx = out.wgy = out.wgz = 0;
    out.wm0 = out.wm1 = out.wm2 = out.wm3 = 0;
    out.scatter = 1; // re-used below as the blood-flow (flush) mask

    // ---- non-skin interiors ---------------------------------------------------------------
    if (region === 1 || region === 2) {
      const deep = region === 2 ? 1 : clamp01(Vt[V.AO] < 0.5 ? 1 : 0.6);
      const base = region === 1 ? [0.36, 0.075, 0.075] : [0.14, 0.035, 0.035];
      const n = fbm(P[0], P[1], P[2], 800, 2, 71, null) * 0.08;
      out.r = base[0] * (1 + n) * (1 - 0.3 * deep * (region === 2 ? 1 : 0));
      out.g = base[1] * (1 + n);
      out.b = base[2] * (1 + n);
      out.rough = 0.22;
      out.h = 0; out.gx = out.gy = out.gz = 0;
      out.cav = 1;
      out.scatter = 0;
      return;
    }

    const isHead = Vt[V.HEAD] > 0.5;
    const lips = smoothstep(0.32, 0.62, Vt[V.LIPS]);
    const nose = Vt[V.NOSE], cheek = Vt[V.CHEEK], ear = Vt[V.EAR], forehead = Vt[V.FOREHEAD];
    const chin = Vt[V.CHIN], underEye = Vt[V.UNDEREYE], lid = Vt[V.LID], brow = Vt[V.BROW];

    // head-relative coordinates
    const hx = P[0] - eyeMid[0], hy = P[1] - eyeMid[1], hz = P[2] - eyeMid[2];
    const hairInfo = isHead ? scalp([hx, hy, hz], ear) : { scalp: 0, edge: 0 };

    // ---- anatomical masks evaluated per texel ----------------------------------------------
    let nail = 0, lunula = 0, freeEdge = 0, cuticle = 0, palm = 0, sole = 0, knuckle = 0, fingertip = 0;
    for (const h of ctx.hands) {
      sub(P, h.center, tmp);
      const dd = dot(tmp, tmp);
      if (dd > h.radius2) continue;
      palm = Math.max(palm, smoothstep(0.15, 0.55, dot(N, h.palmar)) * smoothstep(h.radius2, h.radius2 * 0.5, dd));
    }
    for (const f of ctx.feet) {
      sub(P, f.center, tmp);
      if (dot(tmp, tmp) > f.radius2) continue;
      sole = Math.max(sole, smoothstep(0.35, 0.8, -N[1]) * smoothstep(0.02, 0.0, P[1]));
    }
    for (const nl of ctx.nails) {
      sub(P, nl.head, tmp);
      const along = dot(tmp, nl.Y) / nl.len;
      if (along < -0.3 || along > 1.35) continue;
      const lat = dot(tmp, nl.X), dors = dot(tmp, nl.Z);
      const ang = Math.atan2(lat, dors); // 0 on the dorsal midline
      const radial = Math.hypot(lat, dors);
      if (radial > nl.maxR) continue;
      fingertip = Math.max(fingertip, smoothstep(0.35, 1.0, along) * smoothstep(0.4, -0.2, dot(N, nl.Z)));
      const a = Math.abs(ang) / nl.halfAngle;
      const start = nl.start + 0.1 * a * a;
      const m = smoothstep(start - 0.025, start + 0.015, along) * smoothstep(1.0, 0.82, a) * smoothstep(nl.end + 0.03, nl.end - 0.02, along) * smoothstep(-0.1, 0.35, dot(N, nl.Z));
      if (m > nail) {
        nail = m;
        lunula = smoothstep(start + 0.16, start + 0.06, along) * smoothstep(0.75, 0.3, a) * (nl.toe ? 0.3 : 1);
        freeEdge = smoothstep(nl.end - 0.1, nl.end - 0.02, along);
        cuticle = Math.exp(-(((along - start) / 0.03) ** 2)) * smoothstep(1, 0.6, a);
      }
      // dorsal knuckle wrinkles (finger joints); nl.joints = along-coords of joints proximal
    }
    for (const k of ctx.knuckles) {
      sub(P, k.pos, tmp);
      const along = dot(tmp, k.axis);
      const rad2 = dot(tmp, tmp) - along * along;
      if (rad2 > k.r2 || Math.abs(along) > k.len) continue;
      knuckle = Math.max(knuckle, Math.exp(-((along / k.len) ** 2) * 2.5) * smoothstep(-0.2, 0.5, dot(N, k.dorsal)));
    }
    let elbowKnee = 0;
    for (const j of ctx.joints) {
      sub(P, j.pos, tmp);
      const d2 = dot(tmp, tmp);
      if (d2 > j.r2) continue;
      elbowKnee = Math.max(elbowKnee, (1 - d2 / j.r2) * smoothstep(0.1, 0.7, dot(N, j.side)));
    }
    let areola = 0, nipple = 0;
    for (const n of ctx.nipples) {
      sub(P, n.pos, tmp);
      const d = Math.sqrt(dot(tmp, tmp));
      areola = Math.max(areola, smoothstep(0.0165, 0.0135, d));
      nipple = Math.max(nipple, smoothstep(0.0058, 0.0042, d));
    }
    // inner lid rim / caruncle (wet, pink) near each eyeball
    let mucosa = 0;
    for (const e of ctx.eyes) {
      sub(P, e.center, tmp);
      const d = Math.sqrt(dot(tmp, tmp));
      mucosa = Math.max(mucosa, smoothstep(e.R + 0.0026, e.R + 0.0012, d));
    }

    // ---- height --------------------------------------------------------------------------
    const skinDetail = (1 - lips) * (1 - nail) * (1 - mucosa) * (1 - palm * 0.9) * (1 - sole * 0.9);
    if (isHead) {
      const poreCell = mix(0.00042, 0.00052, nose) * mix(1, 0.85, forehead);
      const poreDepth = (0.000018 + 0.00003 * nose + 0.000012 * cheek + 0.000008 * chin) * skinDetail * (1 - hairInfo.scalp * 0.6) * (1 - ear * 0.6);
      pores(P, poreCell, poreDepth, 11, acc, rough);
      // sparse larger follicle openings on nose and cheeks
      pores(P, 0.0011, 0.00002 * (nose + cheek * 0.6) * skinDetail, 12, acc, rough);
    } else {
      pores(P, 0.0006, 0.000011 * skinDetail, 13, acc, rough);
    }
    // micro-relief: two crossing families of fine furrows in the tangent plane (diamond pattern)
    {
      const c = 0.819, s = 0.574; // ±35°
      const d1 = [Tn[0] * c + Bn[0] * s, Tn[1] * c + Bn[1] * s, Tn[2] * c + Bn[2] * s];
      const d2 = [Tn[0] * c - Bn[0] * s, Tn[1] * c - Bn[1] * s, Tn[2] * c - Bn[2] * s];
      const spacing = isHead ? 0.00034 : 0.00062;
      const depth = (isHead ? 0.0000045 : 0.0000075) * skinDetail * (1 + knuckle * 2);
      grooves(P, d1, spacing, spacing * 0.16, depth, 0.7, 900, 21, acc);
      grooves(P, d2, spacing * 1.13, spacing * 0.16, depth, 0.7, 900, 22, acc);
    }
    // soft bumps
    {
      const v = fbm(P[0], P[1], P[2], 2600, 2, 31, g3);
      const a = 0.0000045 * skinDetail;
      acc.h += v * a; acc.gx += g3[0] * a; acc.gy += g3[1] * a; acc.gz += g3[2] * a;
    }
    // lips: vertical lines and a smoother, plumper surface
    if (lips > 0) {
      grooves(P, ctx.headRight, 0.00085, 0.00012, 0.000032, 0.45, 400, 41, acc, lips);
      rough.v -= 0.05 * lips;
    }
    // static expression lines (faint: she is young)
    if (isHead) {
      grooves(P, up, 0.0085, 0.0007, 0.000022, 0.25, 70, 51, acc, forehead * smoothstep(0.03, 0.05, hy) * (1 - hairInfo.scalp));
      grooves(P, up, 0.0016, 0.00025, 0.000012, 0.4, 300, 52, acc, underEye * 0.8);
    } else {
      const neck = Vt[V.NECK];
      if (neck > 0.2) grooves(P, up, 0.022, 0.0011, 0.000045, 0.18, 30, 53, acc, smoothstep(0.2, 0.6, neck) * smoothstep(0.2, -0.5, N[2] < 0 ? -1 : N[2] - 0.2));
    }
    // knuckles, elbows, knees: crease bands across the joint
    if (knuckle > 0.01) for (const k of ctx.knuckles) {
      sub(P, k.pos, tmp);
      const along = dot(tmp, k.axis);
      if (Math.abs(along) > k.len) continue;
      grooves(P, k.axis, 0.0011, 0.00018, 0.00005, 0.35, 500, 61, acc, knuckle);
      break;
    }
    if (elbowKnee > 0.01) grooves(P, up, 0.0024, 0.00035, 0.00005, 0.5, 250, 62, acc, elbowKnee);
    // palms: flexion creases + fine friction ridges; finger pads with concentric ridges
    if (palm > 0.05 || sole > 0.05) {
      const ridge = Math.max(palm, sole);
      grooves(P, ctx.headRight, 0.00048, 0.00008, 0.000012, 2.2, 1400, 71, acc, ridge);
      if (palm > 0.05) {
        for (const crease of ctx.palmCreases) grooves(P, crease.dir, crease.spacing, 0.0003, 0.00012, 0.3, 120, crease.seed, acc, palm * crease.maskFn(P));
      }
    }
    // nails: raised plate, groove at cuticle and sides, faint longitudinal ridges
    if (nail > 0) {
      acc.h += 0.00012 * nail;
      for (const nl of ctx.nails) {
        sub(P, nl.head, tmp);
        const along = dot(tmp, nl.Y) / nl.len;
        if (along < -0.3 || along > 1.35) continue;
        grooves(P, nl.X, 0.00045, 0.0001, 0.000008, 0.2, 800, 81, acc, nail);
        break;
      }
      acc.h -= 0.00006 * cuticle;
      rough.v -= 0.25 * nail;
    }
    if (nipple > 0) acc.h += 0.0012 * nipple;

    // ---- dynamic wrinkle maps (head only) ------------------------------------------------
    if (isHead && ctx.wrinkles) {
      const W = { h: 0, gx: 0, gy: 0, gz: 0 };
      const fh = forehead * smoothstep(0.022, 0.04, hy) * smoothstep(0.075, 0.06, hy) * (1 - hairInfo.scalp);
      out.wm0 = fh;
      grooves(P, up, 0.0078, 0.0009, 0.00026, 0.22, 60, 91, W, fh);
      // glabella "11" lines: vertical grooves either side of the midline above the brow heads
      const gl = Math.exp(-(((Math.abs(hx) - 0.0055) / 0.0028) ** 2)) * smoothstep(0.012, 0.02, hy) * smoothstep(0.05, 0.035, hy) * smoothstep(0.0, 0.03, hz);
      out.wm1 = gl;
      grooves(P, ctx.headRight, 0.011, 0.0008, 0.0003, 0.1, 60, 92, W, gl);
      // crow's feet: lines radiating from each outer canthus
      for (const e of ctx.eyes) {
        const lx = P[0] - e.outer[0], ly = P[1] - e.outer[1];
        const d = Math.hypot(lx, ly);
        const side = Math.sign(e.outer[0] - e.center[0]);
        if (d > 0.022 || lx * side < 0.001) continue;
        const m = smoothstep(0.022, 0.012, d) * smoothstep(0.001, 0.006, lx * side);
        out.wm2 = Math.max(out.wm2, m);
        const ang = Math.atan2(ly, lx * side);
        const fake = [Math.cos(ang + Math.PI / 2), Math.sin(ang + Math.PI / 2), 0];
        // angular grooves: use tangential direction so lines run radially
        const u = ang / 0.16;
        const f = u - Math.round(u);
        const e2 = Math.exp(-((f / 0.13) ** 2));
        W.h -= 0.00018 * e2 * m;
        const dudang = 1 / 0.16;
        const dhdu = 0.00018 * e2 * 2 * (f / 0.13) / 0.13 * m;
        const s = (dhdu * dudang) / Math.max(d, 1e-4);
        W.gx += s * fake[0] * side; W.gy += s * fake[1];
      }
      // nose bridge "bunny lines" for sneer
      const bn = nose * smoothstep(-0.006, 0.004, hy) * smoothstep(0.02, 0.008, hy);
      out.wm3 = bn;
      grooves(P, [0.6, 0.8, 0], 0.0028, 0.0004, 0.00015, 0.2, 100, 93, W, bn);
      grooves(P, [-0.6, 0.8, 0], 0.0028, 0.0004, 0.00015, 0.2, 100, 94, W, bn);
      out.wh = W.h; out.wgx = W.gx; out.wgy = W.gy; out.wgz = W.gz;
    }

    // ---- colour ---------------------------------------------------------------------------
    {
      const lo = fbm(P[0], P[1], P[2], 28, 3, 101, null);
      const mid = fbm(P[0], P[1], P[2], 160, 3, 102, null);
      const l = 1 + 0.06 * lo + 0.035 * mid;
      r *= l * (1 + 0.025 * mid); g *= l; b *= l * (1 - 0.03 * lo);
    }
    // blood flow / hemoglobin
    let red = 0.36 * cheek + 0.3 * nose * smoothstep(-0.02, -0.035, hy) + 0.16 * nose + 0.34 * ear + 0.14 * chin + 0.06 * forehead
      + 0.16 * lid + 0.3 * knuckle + 0.24 * fingertip + 0.22 * palm + 0.16 * elbowKnee + 0.18 * sole;
    red = clamp01(red);
    r *= mix(1, 1.06, red); g *= mix(1, 0.78, red); b *= mix(1, 0.8, red);
    // under-eye: thin skin, violet-brown cast
    r *= mix(1, 0.9, underEye * 0.75); g *= mix(1, 0.84, underEye * 0.75); b *= mix(1, 0.93, underEye * 0.75);
    // upper lids and inner corners: slightly darker, cooler (thin skin over orbicularis)
    r *= mix(1, 0.92, lid * 0.7); g *= mix(1, 0.86, lid * 0.7); b *= mix(1, 0.9, lid * 0.7);
    // veins under thin skin
    if (ctx.veinMask) {
      const vm = ctx.veinMask(P, N, isHead);
      if (vm > 0.01) {
        const n1 = Math.abs(fbm(P[0], P[1], P[2], 55, 3, 111, null));
        const vein = smoothstep(0.07, 0.0, n1) * vm;
        r *= mix(1, 0.86, vein); g *= mix(1, 0.92, vein); b *= mix(1, 1.04, vein);
      }
    }
    // freckles (melanin clusters)
    {
      const fd = ctx.freckleDensity(P, N, isHead, cheek, nose);
      if (fd > 0.01) {
        const o = { dx: 0, dy: 0, dz: 0, id: 0 };
        const d = worley(P[0], P[1], P[2], 0.0024, 121, o);
        if (o.id < fd) {
          const rad = 0.00045 + 0.0007 * ((o.id * 13.7) % 1);
          const f = smoothstep(rad, rad * 0.45, d) * (0.35 + 0.5 * ((o.id * 5.3) % 1));
          r *= mix(1, 0.8, f); g *= mix(1, 0.68, f); b *= mix(1, 0.58, f);
        }
      }
    }
    for (const m of ctx.moles) {
      sub(P, m.pos, tmp);
      const d = Math.sqrt(dot(tmp, tmp));
      if (d > m.r * 1.6) continue;
      const f = smoothstep(m.r, m.r * 0.6, d);
      r = mix(r, 0.12, f * m.k); g = mix(g, 0.065, f * m.k); b = mix(b, 0.05, f * m.k);
      acc.h += 0.00006 * f * m.raised;
    }
    // pigmented regions
    if (areola > 0) {
      const a = areola * 0.85;
      r *= mix(1, 0.72, a); g *= mix(1, 0.52, a); b *= mix(1, 0.48, a);
    }
    r *= mix(1, 0.94, elbowKnee * 0.6); g *= mix(1, 0.92, elbowKnee * 0.6); b *= mix(1, 0.92, elbowKnee * 0.6);
    // palms and soles: less melanin
    const ps = Math.max(palm, sole);
    r *= mix(1, 1.06, ps); g *= mix(1, 1.0, ps); b *= mix(1, 0.97, ps);
    // scalp follicles and brow follicles (dark roots under the skin surface)
    const follicle = hairInfo.scalp * 0.85;
    r *= mix(1, 0.8, follicle); g *= mix(1, 0.78, follicle); b *= mix(1, 0.8, follicle);
    // brows: dense follicles and fine vellus give a soft brown-grey base under the strands
    const bw = smoothstep(0.05, 0.9, brow) * 0.55;
    r = mix(r, r * 0.52, bw); g = mix(g, g * 0.47, bw); b = mix(b, b * 0.45, bw);
    // lash line (head tile only: the NAVEL channel is re-used there for lash-root density)
    if (isHead) {
      const ll = smoothstep(0.1, 0.8, Vt[V.NAVEL]) * 0.7;
      r = mix(r, r * 0.35, ll); g = mix(g, g * 0.3, ll); b = mix(b, b * 0.3, ll);
    }
    // lips
    if (lips > 0) {
      const ln = fbm(P[0], P[1], P[2], 600, 2, 131, null);
      const border = lips * (1 - lips) * 4;
      r = mix(r, lip[0] * (1 + 0.08 * ln) * (1 + 0.15 * border), lips);
      g = mix(g, lip[1] * (1 + 0.08 * ln) * (1 + 0.2 * border), lips);
      b = mix(b, lip[2] * (1 + 0.08 * ln) * (1 + 0.2 * border), lips);
    }
    // inner lid rim / caruncle
    if (mucosa > 0) {
      r = mix(r, 0.5, mucosa); g = mix(g, 0.17, mucosa); b = mix(b, 0.17, mucosa);
    }
    // nails
    if (nail > 0) {
      let nr = 0.74, ng = 0.47, nb = 0.44;
      nr = mix(nr, 0.86, lunula); ng = mix(ng, 0.72, lunula); nb = mix(nb, 0.7, lunula);
      nr = mix(nr, 0.9, freeEdge); ng = mix(ng, 0.86, freeEdge); nb = mix(nb, 0.8, freeEdge);
      r = mix(r, nr, nail); g = mix(g, ng, nail); b = mix(b, nb, nail);
    }

    // ---- roughness ------------------------------------------------------------------------
    if (isHead) rgh = 0.44 - 0.07 * forehead - 0.1 * nose * smoothstep(-0.03, 0.0, hy) + 0.03 * cheek - 0.03 * chin;
    else rgh = 0.5;
    rgh += 0.06 * Math.max(palm, sole) + 0.08 * hairInfo.scalp;
    rgh = mix(rgh, 0.4, lips);
    rgh = mix(rgh, 0.14, mucosa);
    rgh += rough.v + 0.03 * fbm(P[0], P[1], P[2], 400, 2, 141, null);
    out.rough = Math.min(0.9, Math.max(0.08, rgh));

    // blood-flow mask: where exertion / embarrassment / cold visibly redden the skin
    out.scatter = clamp01(0.95 * cheek + 0.55 * nose + 0.75 * ear + 0.35 * lips + 0.3 * chin + 0.2 * forehead
      + 0.35 * Vt[V.NECK] * (isHead ? 0 : 1) + 0.45 * palm + 0.5 * fingertip + 0.3 * knuckle + 0.2 * elbowKnee) * (1 - nail);
    out.r = r; out.g = g; out.b = b;
    out.h = acc.h; out.gx = acc.gx; out.gy = acc.gy; out.gz = acc.gz;
    out.cav = clamp01(1 + acc.h / 0.00006);
    void vnoise;
  };
}
