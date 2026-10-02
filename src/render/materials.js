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

export function createTeethMaterial() {
  return new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.22,
    clearcoat: 0.6,
    clearcoatRoughness: 0.12,
    ior: 1.62,
    specularIntensity: 0.7,
    sheen: 0.3,
    sheenColor: new THREE.Color(0.85, 0.88, 0.95),
    sheenRoughness: 0.4,
  });
}

export function createMouthMaterial() {
  return new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.45,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
  });
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
