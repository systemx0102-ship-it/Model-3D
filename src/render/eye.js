// Eye material: one eyeball mesh (sclera sphere + cornea bulge). The iris is not geometry —
// the view ray is refracted at the cornea (n = 1.376) and intersected with a recessed iris plane,
// giving correct parallax/depth of the iris from every angle. The cornea's mirror reflection is
// the clearcoat layer; the sclera is a wet, slightly rough diffuse surface. Upper/lower lids
// cast soft occlusion onto the eye (driven by the blink/look blendshape state each frame).
import * as THREE from 'three';

export function createEyeMaterial(map, params) {
  const { limbus, cornea, irisDepth } = params; // in units of the eyeball radius R
  const rL = limbus;
  const zL = Math.sqrt(1 - rL * rL);
  const zc = zL - Math.sqrt(cornea * cornea - rL * rL);
  const mat = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.32,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.025,
    ior: 1.376,
    specularIntensity: 0.6,
  });
  const uniforms = {
    eyeInvWorld: { value: new THREE.Matrix4() }, // world -> eye local (units of R, +Z gaze)
    eyeGaze: { value: new THREE.Vector3(0, 0, 1) }, // world gaze direction
    eyeGeom: { value: new THREE.Vector4(rL, irisDepth, zc, cornea) },
    pupil: { value: 0.33 }, // pupil radius / iris radius
    bakedPupil: { value: 0.33 },
    lidUpper: { value: 0.42 }, // eye-local y of the upper lid margin (units of R)
    lidLower: { value: -0.5 },
    irisBrightness: { value: 1.0 },
  };
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'eye';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEyeWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvEyeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    let fs = shader.fragmentShader;
    fs = fs.replace(
      '#include <common>',
      `#include <common>
varying vec3 vEyeWorld;
uniform mat4 eyeInvWorld;
uniform vec3 eyeGaze;
uniform vec4 eyeGeom;
uniform float pupil, bakedPupil, lidUpper, lidLower, irisBrightness;
float eyeIrisMask;
float eyeOcclusion;
vec3 eyeLocal;`,
    );
    fs = fs.replace(
      '#include <map_fragment>',
      `{
  vec3 p = ( eyeInvWorld * vec4( vEyeWorld, 1.0 ) ).xyz;
  vec3 c = ( eyeInvWorld * vec4( cameraPosition, 1.0 ) ).xyz;
  eyeLocal = p;
  vec2 q = p.xy;
  float rr = length( p.xy );
  eyeIrisMask = 0.0;
  if ( rr < eyeGeom.x * 1.02 && p.z > 0.0 ) {
    vec3 V = normalize( p - c );                               // camera -> surface
    vec3 n = normalize( p - vec3( 0.0, 0.0, eyeGeom.z ) );     // cornea sphere normal
    vec3 t = refract( V, n, 1.0 / 1.376 );
    float s = ( eyeGeom.y - p.z ) / min( t.z, -1e-3 );
    vec3 hit = p + t * s;
    q = hit.xy;
    eyeIrisMask = smoothstep( eyeGeom.x * 1.02, eyeGeom.x * 0.94, length( q ) );
  }
  // pupil dilation: radially remap the iris pattern around the baked pupil size
  float rho = length( q ) / eyeGeom.x;
  if ( rho < 1.0 ) {
    float src = rho < pupil ? rho * bakedPupil / max( pupil, 1e-3 ) : bakedPupil + ( rho - pupil ) * ( 1.0 - bakedPupil ) / ( 1.0 - pupil );
    q *= src / max( rho, 1e-4 );
  }
  vec4 texel = texture2D( map, vec2( 0.5 + 0.5 * q.x, 0.5 - 0.5 * q.y ) );
  texel.rgb *= mix( 1.0, irisBrightness, eyeIrisMask );
  diffuseColor *= texel;
  // lid occlusion: soft shadow band under each lid margin, darker toward the canthi
  float up = smoothstep( 0.0, 0.32, lidUpper - p.y );
  float lo = smoothstep( 0.0, 0.18, p.y - lidLower );
  eyeOcclusion = mix( 0.32, 1.0, up ) * mix( 0.55, 1.0, lo ) * mix( 0.6, 1.0, smoothstep( 0.92, 0.55, abs( p.x ) ) );
}`,
    );
    // iris diffuse responds to the iris plane, not the bulging cornea
    fs = fs.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( eyeGaze, 0.0 ) ).xyz ), eyeIrisMask * 0.85 ) );`,
    );
    fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.55, eyeIrisMask );');
    fs = fs.replace('#include <opaque_fragment>', 'outgoingLight *= eyeOcclusion;\n#include <opaque_fragment>');
    shader.fragmentShader = fs;
  };
  return mat;
}

/** Updates per-eye uniforms from the eye bone each frame. */
export function updateEyeUniforms(mesh, bone, radius, bindFrame) {
  const u = mesh.material.userData.uniforms;
  // eye local frame = bone world * (bone bind -> eye frame offset)
  const m = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, bindFrame);
  const s = new THREE.Matrix4().makeScale(radius, radius, radius);
  u.eyeInvWorld.value.copy(m).multiply(s).invert();
  u.eyeGaze.value.set(0, 0, 1).transformDirection(m);
}
