// Secondary character materials: eyelash/eyebrow strands, teeth, gums/tongue, tear line.
import * as THREE from 'three';

/** Thin hair ribbons: tapered alpha at the tip, root->tip colour shift, Kajiya-Kay-like sheen. */
export function createStrandMaterial({ color, tipColor, roughness = 0.5 }) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    transparent: false,
  });
  const uniforms = { tipColor: { value: new THREE.Color(tipColor ?? color) } };
  mat.customProgramCacheKey = () => 'strand';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vStrandUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvStrandUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vStrandUv;\nuniform vec3 tipColor;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
diffuseColor.rgb = mix( diffuseColor.rgb, tipColor, smoothstep( 0.3, 1.0, vStrandUv.y ) );
float across = abs( vStrandUv.x - 0.5 ) * 2.0;
diffuseColor.a = ( 1.0 - smoothstep( 0.7, 1.0, vStrandUv.y ) ) * ( 1.0 - smoothstep( 0.75, 1.0, across ) );`,
      );
  };
  return mat;
}

/**
 * Shared oral-cavity occlusion: light reaching teeth, gums and tongue falls off with depth behind
 * the incisors (bind space, so it holds while the jaw moves) and opens up as the jaw drops.
 */
export const mouthOcclusion = { frontZ: { value: 0 }, open: { value: 0 } };

function withMouthOcclusion(mat, strength = 1, tint = [1, 1, 1]) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.mouthFrontZ = mouthOcclusion.frontZ;
    sh.uniforms.mouthOpen = mouthOcclusion.open;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float mouthFrontZ;\nvarying float vMouthDepth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMouthDepth = mouthFrontZ - position.z;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float mouthOpen;\nvarying float vMouthDepth;')
      .replace('#include <opaque_fragment>', `float occ = mix(0.46, 0.1, smoothstep(0.0, 0.035, vMouthDepth));
occ = mix(occ, 0.78, ${(0.4 * strength).toFixed(2)} * smoothstep(0.05, 0.6, mouthOpen) * (1.0 - smoothstep(0.02, 0.05, vMouthDepth)));
outgoingLight *= occ * vec3(${tint.map((x) => x.toFixed(3)).join(', ')});
#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => `mouth-occ-${strength}`;
  return mat;
}

export function createTeethMaterial() {
  return withMouthOcclusion(new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.25,
    clearcoat: 0.3,
    clearcoatRoughness: 0.15,
    ior: 1.62,
    specularIntensity: 0.7,
    sheen: 0.12,
    sheenColor: new THREE.Color(0.9, 0.86, 0.78),
    sheenRoughness: 0.45,
  }), 1, [1, 0.93, 0.82]);
}

export function createMouthMaterial() {
  return withMouthOcclusion(new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.45,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
  }), 0.8);
}

/** Lacrimal meniscus: a transparent wet film catching sharp highlights along the lid margin. */
export function createTearlineMaterial() {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.95, 0.82, 0.82),
    roughness: 0.02,
    metalness: 0,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    specularIntensity: 1,
    ior: 1.336,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTearUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTearUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTearUv;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= smoothstep( 0.0, 0.35, vTearUv.x ) * smoothstep( 1.0, 0.6, vTearUv.x );');
  };
  return mat;
}
