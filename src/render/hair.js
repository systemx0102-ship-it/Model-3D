// GPU strand hair. Rendered strands are reconstructed in the vertex shader from the simulated
// guides (float texture: one row per guide), blended with three barycentric guide weights and a
// root offset, then shaped per strand: clumping toward the nearest guide, small waves, frizz and
// flyaways. Each strand is a camera-facing ribbon; strands thinner than a pixel are widened to one
// pixel with proportionally reduced coverage (alpha-to-coverage) so the volume reads correctly
// at any distance. Shading: Marschner-style R / TT / TRT lobes (after Karis 2016) plus a
// multiple-scattering diffuse term, root-to-tip colour and per-strand variation.
import * as THREE from 'three';

const VERT_HEAD = /* glsl */ `
uniform sampler2D guideTex;
uniform float guidePoints;
uniform float strandWidth;
uniform float pixelAngle;
uniform float hairTime;
uniform vec3 hairWind;
attribute float aS;
attribute float aSide;
attribute vec3 aGuides;
attribute vec3 aWeights;
attribute vec3 aRoot;
attribute vec4 aParams; // length fraction, seed, clump strength, kind
attribute vec4 aShape;  // wave amplitude, wave frequency, phase, frizz
varying float vS;
varying float vSeed;
varying float vCoverage;
varying vec3 vHairTangent;

vec3 guideAt( float g, float s ) {
  float f = clamp( s, 0.0, 1.0 ) * ( guidePoints - 1.0 );
  float i0 = floor( f );
  float i1 = min( i0 + 1.0, guidePoints - 1.0 );
  vec3 a = texelFetch( guideTex, ivec2( int( i0 ), int( g ) ), 0 ).xyz;
  vec3 b = texelFetch( guideTex, ivec2( int( i1 ), int( g ) ), 0 ).xyz;
  return mix( a, b, f - i0 );
}
float hhash( float n ) { return fract( sin( n ) * 43758.5453 ); }

vec3 strandAt( float s ) {
  float sg = s * aParams.x;
  vec3 g0 = guideAt( aGuides.x, sg );
  vec3 p = g0 * aWeights.x + guideAt( aGuides.y, sg ) * aWeights.y + guideAt( aGuides.z, sg ) * aWeights.z;
  // clumping: pull toward the nearest guide toward the tips (locks), keep the root spread
  float clump = aParams.z * smoothstep( 0.15, 1.0, s );
  p = mix( p + aRoot, g0 + aRoot * 0.25, clump * 0.6 );
  return p;
}
`;

const VERT_BODY = /* glsl */ `
  float s = aS;
  float ds = 0.02;
  vec3 p = strandAt( s );
  vec3 pA = strandAt( max( s - ds, 0.0 ) );
  vec3 pB = strandAt( min( s + ds, 1.0 ) );
  vec3 T = normalize( pB - pA + vec3( 1e-6 ) );
  // per-strand frame for waves / frizz
  vec3 ref = abs( T.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 N1 = normalize( cross( T, ref ) );
  vec3 B1 = cross( T, N1 );
  float seed = aParams.y * 100.0;
  float w = 6.2831 * aShape.y * s * 0.3 + aShape.z;
  float grow = smoothstep( 0.05, 0.4, s );
  p += ( N1 * sin( w ) + B1 * cos( w ) * 0.6 ) * aShape.x * grow;
  // frizz / flyaways: deviation growing toward the tip, gently animated by the wind
  float fr = aShape.w * pow( s, 1.4 );
  vec3 rnd = normalize( vec3( hhash( seed + 1.0 ), hhash( seed + 2.0 ), hhash( seed + 3.0 ) ) * 2.0 - 1.0 );
  float sway = sin( hairTime * ( 1.3 + hhash( seed + 4.0 ) ) + seed + s * 3.0 );
  p += ( rnd + hairWind * 0.05 * sway ) * fr;
  // camera-facing ribbon, at least one pixel wide (coverage reduced accordingly)
  vec3 toCam = cameraPosition - p;
  float dist = length( toCam );
  vec3 side = normalize( cross( T, toCam / dist ) );
  float physical = strandWidth * mix( 1.0, 0.35, s * s ) * ( aParams.w > 0.5 ? 0.6 : 1.0 );
  float minW = pixelAngle * dist;
  float width = max( physical, minW );
  vCoverage = clamp( physical / width, 0.4, 1.0 );
  p += side * aSide * width * 0.5;
  vS = s;
  vSeed = aParams.y;
  vHairTangent = normalize( ( viewMatrix * vec4( T, 0.0 ) ).xyz );
  vec3 objectNormal = normalize( cross( side, T ) );
  if ( dot( objectNormal, toCam ) < 0.0 ) objectNormal = -objectNormal;
`;

export function createHairMaterial({ rootColor, tipColor, roughness = 0.42 }) {
  // hashed alpha: stable stochastic coverage, no sorting, works on every GPU (A2C quantises
  // sub-pixel strands to nothing on some implementations)
  const mat = new THREE.MeshStandardMaterial({ color: rootColor, roughness, metalness: 0, side: THREE.DoubleSide });
  mat.envMapIntensity = 0.35;
  const uniforms = {
    guideTex: { value: null },
    guidePoints: { value: 24 },
    strandWidth: { value: 0.00032 }, // each rendered strand stands in for several real hairs (~70 µm each)
    pixelAngle: { value: 0.001 },
    hairTime: { value: 0 },
    hairWind: { value: new THREE.Vector3() },
    rootColor: { value: new THREE.Color(rootColor) },
    tipColor: { value: new THREE.Color(tipColor) },
    hairRoughness: { value: roughness },
    specularShift: { value: 0.045 },
  };
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'hair-strands';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <beginnormal_vertex>', VERT_BODY)
      .replace('#include <begin_vertex>', 'vec3 transformed = p;');
    let fs = shader.fragmentShader;
    fs = fs.replace(
      '#include <common>',
      `#include <common>
varying float vS;
varying float vSeed;
varying float vCoverage;
varying vec3 vHairTangent;
uniform vec3 rootColor, tipColor;
uniform float hairRoughness, specularShift;
vec3 hairBase;
float hairAO;`,
    );
    fs = fs.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
{
  float v = fract( vSeed * 7.13 );
  vec3 c = mix( rootColor, tipColor, smoothstep( 0.0, 1.0, vS ) );
  c *= 0.82 + 0.36 * v;                                  // per-strand melanin variation
  c = mix( c, c * vec3( 1.25, 1.12, 0.95 ), step( 0.93, fract( vSeed * 13.7 ) ) ); // sparse lighter strands
  hairBase = c;
  diffuseColor.rgb = c;
  hairAO = mix( 0.35, 1.0, smoothstep( 0.0, 0.35, vS ) ); // self-occlusion deep in the volume near the scalp
  // stochastic coverage (hashed per strand and pixel): sub-pixel strands contribute in
  // proportion to their true width without sorting; MSAA/TAA resolve the dither
  float cover = vCoverage * ( 1.0 - smoothstep( 0.92, 1.0, vS ) );
  float hsh = fract( sin( dot( floor( gl_FragCoord.xy ), vec2( 12.9898, 78.233 ) ) + vSeed * 917.3 ) * 43758.5453 );
  if ( cover < hsh ) discard;
  diffuseColor.a = 1.0;
}`,
    );
    fs = fs.replace(
      '#include <lights_physical_pars_fragment>',
      `#include <lights_physical_pars_fragment>
float hairG( float B, float x ) { return exp( -0.5 * x * x / ( B * B ) ) / ( 2.5066283 * B ); }
vec3 hairBSDF( vec3 L, vec3 V, vec3 T, vec3 base, float rough, float shift ) {
  float sinL = clamp( dot( T, L ), -1.0, 1.0 );
  float sinV = clamp( dot( T, V ), -1.0, 1.0 );
  float cosD = cos( 0.5 * abs( asin( sinV ) - asin( sinL ) ) );
  vec3 Lp = L - sinL * T, Vp = V - sinV * T;
  float cosPhi = dot( Lp, Vp ) * inversesqrt( dot( Lp, Lp ) * dot( Vp, Vp ) + 1e-4 );
  float cosHalfPhi = sqrt( clamp( 0.5 + 0.5 * cosPhi, 0.0, 1.0 ) );
  float r2 = rough * rough;
  float B0 = 0.03 + r2, B1 = 0.03 + r2 * 0.5, B2 = 0.03 + r2 * 2.0;
  float a0 = -shift * 2.0, a1 = shift, a2 = shift * 4.0;
  vec3 S = vec3( 0.0 );
  // R: surface reflection, white
  float Mp = hairG( B0 * 1.4142 * cosHalfPhi + 1e-3, sinL + sinV - a0 );
  float Fp = 0.0465 + ( 1.0 - 0.0465 ) * pow( 1.0 - sqrt( clamp( 0.5 + 0.5 * dot( L, V ), 0.0, 1.0 ) ), 5.0 );
  S += vec3( Mp * 0.25 * cosHalfPhi * Fp );
  // TT: transmission through the fibre (back-lit glow), tinted by absorption
  float np = 1.19 / cosD + 0.36 * cosD;
  float a = 1.0 / np;
  float h = cosHalfPhi * ( 1.0 + a * ( 0.6 - 0.8 * cosPhi ) );
  float f = 0.0465 + ( 1.0 - 0.0465 ) * pow( 1.0 - cosD * sqrt( clamp( 1.0 - h * h, 0.0, 1.0 ) ), 5.0 );
  Mp = hairG( B1, sinL + sinV - a1 );
  vec3 Tp = pow( max( base, vec3( 1e-3 ) ), vec3( 0.5 * sqrt( 1.0 - h * h * a * a ) / cosD ) );
  S += Mp * exp( -3.65 * cosPhi - 3.98 ) * ( 1.0 - f ) * ( 1.0 - f ) * Tp;
  // TRT: internal reflection, coloured secondary highlight
  Mp = hairG( B2, sinL + sinV - a2 );
  f = 0.0465 + ( 1.0 - 0.0465 ) * pow( 1.0 - cosD * 0.5, 5.0 );
  Tp = pow( max( base, vec3( 1e-3 ) ), vec3( 0.8 / cosD ) );
  S += Mp * exp( 17.0 * cosPhi - 16.78 ) * ( 1.0 - f ) * ( 1.0 - f ) * f * Tp;
  // multiple scattering, approximated as a wrapped Kajiya-Kay diffuse
  float kd = mix( 0.33, 1.0, sqrt( max( 0.0, 1.0 - sinL * sinL ) ) );
  S += base * kd * ( 1.0 / 3.14159 ) * 0.85;
  return S;
}
void RE_Direct_Hair( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  vec3 T = normalize( vHairTangent );
  vec3 S = hairBSDF( directLight.direction, geometryViewDir, T, hairBase, hairRoughness, specularShift );
  float wrap = clamp( dot( geometryNormal, directLight.direction ) * 0.5 + 0.5, 0.0, 1.0 );
  reflectedLight.directDiffuse += directLight.color * S * mix( 0.6, 1.0, wrap ) * hairAO;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Hair
`,
    );
    fs = fs.replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= hairAO;\nreflectedLight.indirectSpecular *= hairAO * 0.5;');
    shader.fragmentShader = fs;
  };
  return mat;
}

/** Depth material for shadow casting with the same strand reconstruction. */
function createHairDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `${VERT_BODY}\nvec3 transformed = p;`);
  };
  return mat;
}

export class HairStrands {
  /**
   * @param sim     HairSim (provides guide count/points and interpolation tables)
   * @param count   number of rendered strands (<= groom strands)
   * @param points  vertices along each strand
   */
  constructor(sim, { count = sim.meta.strands, points = 24, rootColor, tipColor } = {}) {
    this.sim = sim;
    const G = sim.G, N = sim.N;
    this.texture = new THREE.DataTexture(sim.out, N, G, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    const geo = new THREE.InstancedBufferGeometry();
    const S = [], side = [], idx = [];
    for (let i = 0; i < points; i++) {
      const s = i / (points - 1);
      S.push(s, s);
      side.push(-1, 1);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(points * 2 * 3), 3));
    geo.setAttribute('aS', new THREE.Float32BufferAttribute(S, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    geo.setIndex(idx);
    const d = sim.data;
    const inst = (arr, size) => new THREE.InstancedBufferAttribute(arr.subarray(0, count * size), size);
    geo.setAttribute('aGuides', inst(d.guides, 3));
    geo.setAttribute('aWeights', inst(d.weights, 3));
    geo.setAttribute('aRoot', inst(d.rootOffset, 3));
    geo.setAttribute('aParams', inst(d.params, 4));
    geo.setAttribute('aShape', inst(d.shape, 4));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.material = createHairMaterial({ rootColor, tipColor });
    const u = this.material.userData.uniforms;
    u.guideTex.value = this.texture;
    u.guidePoints.value = N;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Hair_Strands';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = createHairDepthMaterial(u);
    this.geometry = geo;
  }

  setCount(n) {
    this.geometry.instanceCount = Math.min(n, this.sim.meta.strands);
  }

  update(time, wind, camera, viewportHeight) {
    this.texture.needsUpdate = true;
    const u = this.material.userData.uniforms;
    u.hairTime.value = time;
    u.hairWind.value.copy(wind);
    // angular size of one pixel (radians) -> minimum ribbon width in world units at distance d
    u.pixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportHeight;
  }
}
