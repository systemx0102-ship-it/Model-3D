// Composes the character's rest shape from MakeHuman CC0 targets.
import path from 'node:path';
import { loadTarget, applyTarget } from './targets.mjs';

const tri = (v) =>
  v < 0.5
    ? { min: (0.5 - v) * 2, average: 1 - (0.5 - v) * 2, max: 0 }
    : { min: 0, average: 1 - (v - 0.5) * 2, max: (v - 0.5) * 2 };

/** Returns [[relativeTargetPath, weight], ...] for the macro sliders (female only). */
export function macroTargets(macro) {
  if (macro.gender !== 0) throw new Error('recipe: only gender 0 (female) targets are vendored');
  const out = [];
  const mus = tri(macro.muscle);
  const wei = tri(macro.weight);
  const combos = [];
  for (const [m, mw] of Object.entries(mus))
    for (const [w, ww] of Object.entries(wei)) if (mw * ww > 1e-6) combos.push([m, w, mw * ww]);

  for (const [eth, ew] of Object.entries(macro.ethnicity)) out.push([`macrodetails/${eth}-female-${macro.age}`, ew]);
  for (const [m, w, cw] of combos) {
    out.push([`macrodetails/universal-female-${macro.age}-${m}muscle-${w}weight`, cw]);
    if (macro.height > 0.5) out.push([`macrodetails/height/female-${macro.age}-${m}muscle-${w}weight-maxheight`, cw * (macro.height - 0.5) * 2]);
    if (macro.proportions > 0.5)
      out.push([`macrodetails/proportions/female-${macro.age}-${m}muscle-${w}weight-idealproportions`, cw * (macro.proportions - 0.5) * 2]);
    const cup = tri(macro.cup);
    const firm = tri(macro.firmness);
    for (const [c, cwt] of Object.entries(cup))
      for (const [f, fwt] of Object.entries(firm)) {
        if (c === 'average' && f === 'average') continue; // neutral, no file
        const wgt = cw * cwt * fwt;
        if (wgt > 1e-6) out.push([`breast/female-${macro.age}-${m}muscle-${w}weight-${c}cup-${f}firmness`, wgt]);
      }
  }
  return out;
}

export function composeShape(mhDir, basePositions, recipe) {
  const pos = Float32Array.from(basePositions);
  const applied = [];
  const all = [...macroTargets(recipe.macro), ...recipe.details, ...recipe.asymmetry];
  for (const [rel, w] of all) {
    const t = loadTarget(path.join(mhDir, 'targets', `${rel}.target`));
    applyTarget(pos, t, w);
    applied.push([rel, +w.toFixed(4)]);
  }
  return { positions: pos, applied };
}
