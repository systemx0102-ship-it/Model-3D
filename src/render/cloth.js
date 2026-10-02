// Cloth / leather / rubber material: baked garment maps (construction details, wear, folds) plus a
// tileable fabric detail map (weave, knit, grain) projected tri-planar in *bind* space, so the weave
// keeps its physical scale on every garment, needs no UVs and stays glued to the fabric while the
// skeleton deforms it (the bind axes are carried through the skinning matrix to view space).
import * as THREE from 'three';

export const FABRIC = {
  rib: { size: 0.016, detail: 1.0, cavity: 0.45, variation: 0.35, sheen: 0.7, sheenRoughness: 0.45 },
  twill: { size: 0.008, detail: 0.9, cavity: 0.35, variation: 0.3, sheen: 0.45, sheenRoughness: 0.55 },
  leather: { size: 0.03, detail: 0.6, cavity: 0.3, variation: 0.25, sheen: 0.0, clearcoat: 0.12, clearcoatRoughness: 0.5 },
  cordura: { size: 0.008, detail: 1.0, cavity: 0.4, variation: 0.25, sheen: 0.35, sheenRoughness: 0.4 },
  rubber: { size: 0.03, detail: 1.0, cavity: 0.5, variation: 0.2, sheen: 0.0 },
};

export function createClothMaterial(maps, { fabric = 'twill', color, roughness = 0.8, tileSize, sheenColor } = {}) {
  const f = FABRIC[fabric] ?? FABRIC.twill;
  const baked = !!maps.orm;
  const mat = new THREE.MeshPhysicalMaterial({
    color: color ?? 0xffffff,
    map: maps.baseColor ?? null,
    normalMap: maps.normal ?? null,
    aoMap: maps.orm ?? null,
    roughnessMap: maps.orm ?? null,
    metalnessMap: maps.orm ?? null,
    roughness: baked ? 1 : roughness,
    metalness: baked ? 1 : 0,
    sheen: f.sheen,
    sheenRoughness: f.sheenRoughness ?? 0.5,
    sheenColor: sheenColor ?? new THREE.Color(0.3, 0.3, 0.28),
    clearcoat: f.clearcoat ?? 0,
    clearcoatRoughness: f.clearcoatRoughness ?? 0.5,
  });
  const uniforms = {
    detailMap: { value: maps.detail ?? null },
    detailScale: { value: 1 / (tileSize ?? f.size) },
    detailStrength: { value: maps.detail ? f.detail : 0 },
    detailCavity: { value: f.cavity },
    detailVariation: { value: f.variation },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vBindPos;
varying vec3 vBindN;
varying vec3 vAX;
varying vec3 vAY;
varying vec3 vAZ;`)
      .replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>
vBindPos = position;
vBindN = normal;
#ifdef USE_SKINNING
  mat3 skR = mat3(skinMatrix);
#else
  mat3 skR = mat3(1.0);
#endif
vAX = normalMatrix * (skR * vec3(1.0, 0.0, 0.0));
vAY = normalMatrix * (skR * vec3(0.0, 1.0, 0.0));
vAZ = normalMatrix * (skR * vec3(0.0, 0.0, 1.0));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D detailMap;
uniform float detailScale;
uniform float detailStrength;
uniform float detailCavity;
uniform float detailVariation;
varying vec3 vBindPos;
varying vec3 vBindN;
varying vec3 vAX;
varying vec3 vAY;
varying vec3 vAZ;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (detailStrength > 0.0) {
  vec3 bn = normalize(vBindN);
  vec3 w = pow(abs(bn), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec4 tx = texture2D(detailMap, vBindPos.zy * detailScale);
  vec4 ty = texture2D(detailMap, vBindPos.xz * detailScale);
  vec4 tz = texture2D(detailMap, vBindPos.xy * detailScale);
  vec2 nx = (tx.xy * 2.0 - 1.0) * vec2(sign(bn.x), -1.0);
  vec2 ny = (ty.xy * 2.0 - 1.0) * vec2(1.0, -sign(bn.y));
  vec2 nz = (tz.xy * 2.0 - 1.0) * vec2(sign(bn.z), -1.0);
  // bind-space perturbation of each projection (whiteout-style blend), then to view space
  vec3 d = w.x * vec3(0.0, nx.y, nx.x) + w.y * vec3(ny.x, 0.0, ny.y) + w.z * vec3(nz.x, nz.y, 0.0);
  vec3 dv = normalize(vAX) * d.x + normalize(vAY) * d.y + normalize(vAZ) * d.z;
  normal = normalize(normal + dv * detailStrength);
  float cav = dot(w, vec3(tx.z, ty.z, tz.z));
  float va = dot(w, vec3(tx.w, ty.w, tz.w));
  diffuseColor.rgb *= mix(1.0, cav, detailCavity) * (1.0 + (va - 0.5) * detailVariation * 2.0);
  roughnessFactor = clamp(roughnessFactor + (0.5 - cav) * 0.12, 0.04, 1.0);
}`);
  };
  mat.customProgramCacheKey = () => `cloth-${fabric}-${baked}`;
  return mat;
}

/** Brushed cotton flannel (plaid): UVs are in plaid-repeat units on every flannel mesh. */
export function createFlannelMaterial(baseColor, normal) {
  for (const t of [baseColor, normal]) if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshPhysicalMaterial({
    map: baseColor,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 0.9,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0.32, 0.16, 0.15),
    side: THREE.DoubleSide,
  });
}
