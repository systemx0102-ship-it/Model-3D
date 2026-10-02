// Character definition: everything that makes this specific woman who she is.
// Values are MakeHuman-style macro sliders (0..1, 0.5 = population average) plus small,
// deliberately uneven detail/asymmetry offsets so the face reads as a person, not a template.

export const recipe = {
  name: 'Hero_F01',
  macro: {
    gender: 0.0, // fully female
    age: 'young', // ~25 years (MakeHuman "young" key frame)
    muscle: 0.66, // athletic, visible tone without bodybuilder mass
    weight: 0.42, // lean, healthy body fat
    height: 0.62, // ~1.70 m after scaling
    proportions: 0.85, // close to "ideal" proportions, not idealised to doll-like
    cup: 0.45,
    firmness: 0.6,
    ethnicity: { caucasian: 0.62, asian: 0.18, african: 0.2 },
  },
  // Bilateral detail targets ([file, weight]); keep magnitudes small.
  details: [
    ['torso/torso-vshape-incr', 0.18],
    ['torso/torso-muscle-dorsi-incr', 0.2],
    ['stomach/stomach-tone-incr', 0.35],
    ['measure/measure-waist-circ-decr', 0.25],
    ['buttocks/buttocks-volume-incr', 0.15],
    ['neck/neck-scale-horiz-decr', 0.15],
    ['head/head-oval', 0.35],
    ['head/head-scale-horiz-decr', 0.12],
    ['forehead/forehead-scale-vert-decr', 0.1],
    ['chin/chin-prominent-incr', 0.22],
    ['chin/chin-width-decr', 0.15],
    ['chin/chin-bones-incr', 0.2],
    ['cheek/l-cheek-bones-incr', 0.32],
    ['cheek/r-cheek-bones-incr', 0.28],
    ['cheek/l-cheek-volume-decr', 0.15],
    ['cheek/r-cheek-volume-decr', 0.18],
    ['nose/nose-point-width-decr', 0.3],
    ['nose/nose-scale-horiz-decr', 0.15],
    ['nose/nose-nostrils-width-decr', 0.15],
    ['nose/nose-hump-incr', 0.12],
    ['nose/nose-point-up', 0.1],
    ['mouth/mouth-lowerlip-volume-incr', 0.3],
    ['mouth/mouth-upperlip-volume-incr', 0.22],
    ['mouth/mouth-cupidsbow-incr', 0.25],
    ['mouth/mouth-scale-horiz-incr', 0.08],
    ['eyebrows/eyebrows-angle-up', 0.15],
    ['eyes/l-eye-height2-incr', 0.12],
    ['eyes/r-eye-height2-incr', 0.08],
    ['eyes/l-eye-corner1-up', 0.15],
    ['eyes/r-eye-corner1-up', 0.1],
  ],
  // Natural asymmetry: a few millimetres here and there, never mirrored.
  asymmetry: [
    ['asym/asym-eye-1-l', 0.25],
    ['asym/asym-eye-3-r', 0.2],
    ['asym/asym-brown-1-r', 0.3],
    ['asym/asym-nose-2-l', 0.3],
    ['asym/asym-nose-4-r', 0.2],
    ['asym/asym-mouth-1-l', 0.25],
    ['asym/asym-cheek-1-r', 0.2],
    ['asym/asym-jaw-2-l', 0.2],
    ['asym/asym-ear-2-r', 0.35],
    ['asym/asym-ear-3-l', 0.25],
    ['asym/asym-temple-1-l', 0.2],
    ['asym/asymm-breast-1-l', 0.2],
    ['asym/asymm-trunk-1-r', 0.15],
  ],
  // Skin: linear albedo (sRGB ~ #C8967F light-medium warm) and lip colour (sRGB ~ #B26668).
  skin: {
    tone: [0.578, 0.305, 0.212],
    lips: [0.44, 0.134, 0.138],
  },
  // World scale: MakeHuman units are decimetres.
  unitScale: 0.1,
};
