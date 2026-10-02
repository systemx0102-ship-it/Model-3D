// Skin material: MeshPhysicalMaterial with a custom direct-lighting term.
//  - pre-integrated subsurface scattering (Penner) from a LUT built from the d'Eon/Luebke
//    six-Gaussian skin diffusion profile, evaluated per colour channel with progressively
//    softer normals (red scatters furthest)
//  - coloured shadow penumbra (light bleeding through the terminator turns red)
//  - thickness-driven back-scattering for ears, nostrils, fingers
//  - dual-lobe GGX specular (UE skin style) with cavity specular occlusion
//  - expression wrinkle normal maps blended by blendshape activity, tiling micro-normal detail
//  - blood-flow (flush) tinting driven at runtime (exertion, emotion)
import * as THREE from 'three';

// d'Eon & Luebke 2007, variances in mm^2 with RGB weights
const PROFILE = [
  [0.0064, [0.233, 0.455, 0.649]],
  [0.0484, [0.1, 0.336, 0.344]],
  [0.187, [0.118, 0.198, 0.0]],
  [0.567, [0.113, 0.007, 0.007]],
  [1.99, [0.358, 0.004, 0.0]],
  [7.41, [0.078, 0.0, 0.0]],
];

let lutTexture = null;
/** Pre-integrated scattering LUT: x = N·L (-1..1), y = curvature (0 = flat .. 1 = r 8 mm). */
export function skinLUT(size = 128) {
  if (lutTexture) return lutTexture;
  const data = new Uint8Array(size * size * 4);
  const steps = 256;
  for (let y = 0; y < size; y++) {
    const c = (y + 0.5) / size;
    const radius = 8 / Math.max(c, 0.004); // mm
    for (let x = 0; x < size; x++) {
      const theta = Math.acos(((x + 0.5) / size) * 2 - 1);
      const tot = [0, 0, 0], norm = [0, 0, 0];
      for (let i = 0; i < steps; i++) {
        const a = -Math.PI + ((i + 0.5) / steps) * 2 * Math.PI;
        const dist = Math.abs(2 * radius * Math.sin(a / 2));
        const light = Math.max(0, Math.cos(theta + a));
        for (let ch = 0; ch < 3; ch++) {
          let w = 0;
          for (const [v, rgb] of PROFILE) w += rgb[ch] * Math.exp((-dist * dist) / (2 * v));
          tot[ch] += light * w;
          norm[ch] += w;
        }
      }
      const o = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) data[o + ch] = Math.round(Math.min(1, tot[ch] / norm[ch]) ** (1 / 2.2) * 255);
      data[o + 3] = 255;
    }
  }
  lutTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  lutTexture.magFilter = lutTexture.minFilter = THREE.LinearFilter;
  lutTexture.wrapS = lutTexture.wrapT = THREE.ClampToEdgeWrapping;
  lutTexture.needsUpdate = true;
  return lutTexture;
}

export const skinGlobals = {
  flush: { value: 0 }, // whole-body exertion flush 0..1
  blush: { value: 0 }, // face-only emotional blush 0..1
  garments: { value: new THREE.Vector4(1, 1, 1, 0) }, // which garments are worn (hides covered skin)
};

/**
 * @param maps {baseColor, normal, orm, data, micro, wrinkleNormal?, wrinkleMask?}
 * @param metresPerUV  surface metres per UV unit for this tile (micro-normal tiling)
 */
export function createSkinMaterial(maps, { metresPerUV = 1, isHead = false, wrinkleWeights } = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    map: maps.baseColor,
    normalMap: maps.normal,
    roughnessMap: maps.orm,
    aoMap: maps.orm,
    aoMapIntensity: 1,
    metalness: 0,
    roughness: 1,
    ior: 1.4,
    specularIntensity: 1,
    sheen: 0.18,
    sheenRoughness: 0.45,
    sheenColor: new THREE.Color(0.9, 0.75, 0.68),
  });
  const uniforms = {
    skinLUT: { value: skinLUT() },
    skinData: { value: maps.data },
    microNormal: { value: maps.micro },
    microScale: { value: metresPerUV / 0.015 },
    microStrength: { value: isHead ? 0.55 : 0.7 },
    wrinkleNormal: { value: maps.wrinkleNormal ?? null },
    wrinkleMask: { value: maps.wrinkleMask ?? null },
    wrinkleWeights: wrinkleWeights ?? { value: new THREE.Vector4() },
    scatterTint: { value: new THREE.Color(1.0, 0.32, 0.18) },
    flush: skinGlobals.flush,
    blush: skinGlobals.blush,
    isHead: { value: isHead ? 1 : 0 },
    garments: skinGlobals.garments,
  };
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => `skin-${isHead && maps.wrinkleNormal ? 'w' : 'n'}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (isHead && maps.wrinkleNormal) shader.defines = { ...(shader.defines ?? {}), SKIN_WRINKLES: '' };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 _mask;\nvarying vec4 vMask;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMask = _mask;');
    let fs = shader.fragmentShader;
    fs = fs.replace(
      '#include <common>',
      `#include <common>
varying vec4 vMask;
uniform vec4 garments;
uniform sampler2D skinLUT, skinData, microNormal, wrinkleNormal, wrinkleMask;
uniform float microScale, microStrength, flush, blush, isHead;
uniform vec4 wrinkleWeights;
uniform vec3 scatterTint;
vec4 skinSample;      // r cavity, g translucency, b curvature, a blood-flow mask
vec3 skinBlurN;       // softened normal used for diffuse scattering
vec3 skinUnshadowed;  // light colour before shadowing (per light)
`,
    );
    // sample skin data once, tint for blood flow after the albedo is known
    fs = fs.replace(
      '#include <map_fragment>',
      `if ( dot( vMask, garments ) > 0.995 ) discard; // skin fully covered by a worn garment
#include <map_fragment>
skinSample = texture2D( skinData, vMapUv );
{
  float f = clamp( flush * skinSample.a + blush * skinSample.a * isHead, 0.0, 1.0 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.1, 0.8, 0.8 ), f );
}`,
    );
    fs = fs.replace('#include <normal_fragment_maps>', `vec3 skinGeoN = normal;\n#include <normal_fragment_maps>\nskinBlurN = normalize( mix( skinGeoN, normal, 0.3 ) );`);
    fs = fs.replace(
      'mapN.xy *= normalScale;',
      `mapN.xy *= normalScale;
#ifdef SKIN_WRINKLES
{
  vec3 wn = texture2D( wrinkleNormal, vNormalMapUv ).xyz * 2.0 - 1.0;
  float w = clamp( dot( texture2D( wrinkleMask, vNormalMapUv ), wrinkleWeights ), 0.0, 1.0 );
  wn = normalize( mix( vec3( 0.0, 0.0, 1.0 ), wn, w ) );
  mapN = normalize( vec3( mapN.xy + wn.xy, mapN.z * wn.z ) );
}
#endif
{
  vec3 dn = texture2D( microNormal, vNormalMapUv * microScale ).xyz * 2.0 - 1.0;
  dn.xy *= microStrength * smoothstep( 0.2, 0.6, skinSample.r + 0.5 );
  mapN = normalize( vec3( mapN.xy + dn.xy, mapN.z * dn.z ) );
}`,
    );
    // remember the unshadowed light colour of each light for coloured penumbrae
    fs = fs.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(/(get(Directional|Spot|Point|Sun)LightInfo\([^;]*\);)/g, '$1 skinUnshadowed = directLight.color;'));
    fs = fs.replace(
      '#include <lights_physical_pars_fragment>',
      `#include <lights_physical_pars_fragment>
void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 L = directLight.direction;
  vec3 N = geometryNormal;
  // shadow factor relative to the unshadowed light; red bleeds furthest into the penumbra
  float lu = max( dot( skinUnshadowed, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );
  float sh = clamp( dot( directLight.color, vec3( 0.2126, 0.7152, 0.0722 ) ) / lu, 0.0, 1.0 );
  vec3 shadowRGB = pow( vec3( sh ), vec3( 0.55, 0.9, 1.05 ) );
  // pre-integrated scattering, per channel with progressively sharper normals
  float curv = skinSample.b;
  vec3 nR = normalize( mix( skinBlurN, N, 0.15 ) );
  vec3 nG = normalize( mix( skinBlurN, N, 0.55 ) );
  vec3 nB = normalize( mix( skinBlurN, N, 0.8 ) );
  vec3 sss = vec3(
    texture2D( skinLUT, vec2( dot( nR, L ) * 0.5 + 0.5, curv ) ).r,
    texture2D( skinLUT, vec2( dot( nG, L ) * 0.5 + 0.5, curv ) ).g,
    texture2D( skinLUT, vec2( dot( nB, L ) * 0.5 + 0.5, curv ) ).b );
  sss = pow( sss, vec3( 2.2 ) );
  vec3 Lc = skinUnshadowed;
  vec3 halfDir = normalize( L + geometryViewDir );
  vec3 F = F_Schlick( material.specularColor, material.specularF90, saturate( dot( geometryViewDir, halfDir ) ) );
  reflectedLight.directDiffuse += Lc * shadowRGB * sss * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  // back-scattering through thin tissue (ears, nostrils, fingers, eyelids)
  float trans = skinSample.g;
  float back = pow( saturate( dot( geometryViewDir, -normalize( L + N * 0.4 ) ) ), 4.0 ) * 0.6 + saturate( -dot( N, L ) ) * 0.12;
  reflectedLight.directDiffuse += Lc * mix( vec3( sh ), vec3( 1.0 ), 0.4 ) * trans * trans * back * scatterTint * material.diffuseContribution;
  // dual-lobe specular with cavity occlusion
  float dotNL = saturate( dot( N, L ) );
  PhysicalMaterial m1 = material;
  m1.roughness = clamp( material.roughness * 0.75, 0.04, 1.0 );
  PhysicalMaterial m2 = material;
  m2.roughness = clamp( material.roughness * 1.35, 0.04, 1.0 );
  vec3 spec = 0.82 * BRDF_GGX( L, geometryViewDir, N, m1 ) + 0.18 * BRDF_GGX( L, geometryViewDir, N, m2 );
  float cav = mix( 0.45, 1.0, skinSample.r );
  reflectedLight.directSpecular += directLight.color * dotNL * spec * cav * material.multiScatteringCompensation;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Skin
`,
    );
    shader.fragmentShader = fs;
  };
  return mat;
}
