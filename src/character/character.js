// Loads the hero character (GLB + sidecar JSON), assigns the runtime shaders and exposes the
// skeleton, blendshape controls and per-frame material updates.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSkinMaterial } from '../render/skin.js';
import { createEyeMaterial, updateEyeUniforms } from '../render/eye.js';
import { createStrandMaterial, createTeethMaterial, createMouthMaterial, createTearlineMaterial } from '../render/materials.js';
import { createClothMaterial, createFlannelMaterial } from '../render/cloth.js';

const SHEEN = {
  rib: new THREE.Color(0.2, 0.22, 0.17),
  twill: new THREE.Color(0.36, 0.32, 0.24),
  cordura: new THREE.Color(0.16, 0.17, 0.13),
};

export class Character {
  static async load(base = 'character/', { maxAnisotropy = 8 } = {}) {
    const [gltf, meta] = await Promise.all([
      new GLTFLoader().loadAsync(`${base}hero.glb`),
      fetch(`${base}character.json`).then((r) => r.json()),
    ]);
    const c = new Character(gltf, meta, base, maxAnisotropy);
    await c.textureLoad;
    return c;
  }

  constructor(gltf, meta, base, maxAnisotropy) {
    this.meta = meta;
    this.root = gltf.scene;
    this.root.name = meta.name;
    this.bones = new Map();
    this.meshes = [];
    this.morphMeshes = [];
    this.root.traverse((o) => {
      if (o.isBone) this.bones.set(o.name, o);
      if (o.isMesh) {
        this.meshes.push(o);
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        if (o.morphTargetDictionary) this.morphMeshes.push(o);
      }
    });
    this.skeleton = this.meshes.find((m) => m.isSkinnedMesh).skeleton;
    this.weights = {}; // blendshape name -> weight (applied in update)
    this.wrinkleWeights = { value: new THREE.Vector4() };

    const tl = new THREE.TextureLoader();
    const pending = [];
    const tex = (file, srgb = false) => {
      let done;
      pending.push(new Promise((res) => (done = res)));
      const t = tl.load(`${base}textures/${file}`, () => done(), undefined, (e) => {
        console.warn('texture failed', file, e);
        done();
      });
      t.flipY = false;
      t.anisotropy = maxAnisotropy;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const fabricCache = {};
    const fabricDetail = (name) => {
      if (!fabricCache[name]) {
        const t = tex(`T_Fabric_${name[0].toUpperCase()}${name.slice(1)}_Detail.webp`);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        fabricCache[name] = t;
      }
      return fabricCache[name];
    };
    const texSet = (tile) => ({
      baseColor: tex(`T_${tile}_BaseColor.webp`, true),
      normal: tex(`T_${tile}_Normal.webp`),
      orm: tex(`T_${tile}_ORM.webp`),
      data: tex(`T_${tile}_Data.webp`),
    });
    const micro = tex('T_Skin_MicroNormal.webp');
    micro.wrapS = micro.wrapT = THREE.RepeatWrapping;

    this.eyes = [];
    this.garments = {};
    for (const mesh of this.meshes) {
      const ex = mesh.material.userData ?? {};
      switch (ex.shader) {
        case 'skin': {
          const maps = { ...texSet(ex.tile), micro };
          if (ex.tile === 'Head') {
            maps.wrinkleNormal = tex('T_Head_WrinkleNormal.webp');
            maps.wrinkleMask = tex('T_Head_WrinkleMask.webp');
          }
          mesh.material = createSkinMaterial(maps, { metresPerUV: ex.metresPerUV, isHead: ex.tile === 'Head', wrinkleWeights: this.wrinkleWeights });
          break;
        }
        case 'eye': {
          const side = mesh.name.endsWith('_l') ? 'l' : 'r';
          const e = meta.eyes[side];
          mesh.material = createEyeMaterial(tex('T_Eye_BaseColor.webp', true), e);
          mesh.castShadow = false;
          const bone = this.bones.get(`eye_${side}`);
          const boneIndex = this.skeleton.bones.indexOf(bone);
          const frame = eyeFrame(new THREE.Vector3(...e.center), new THREE.Vector3(...e.gaze));
          const bindFrame = this.skeleton.boneInverses[boneIndex].clone().multiply(frame);
          this.eyes.push({ side, mesh, bone, radius: e.radius, bindFrame });
          break;
        }
        case 'tearline':
          mesh.material = createTearlineMaterial();
          mesh.castShadow = false;
          mesh.renderOrder = 2;
          break;
        case 'teeth':
          mesh.material = createTeethMaterial();
          mesh.castShadow = false;
          break;
        case 'mouth':
          mesh.material = createMouthMaterial();
          mesh.castShadow = false;
          break;
        case 'strand': {
          const brow = mesh.name.includes('Brow');
          mesh.material = createStrandMaterial(
            brow ? { color: new THREE.Color(0.022, 0.014, 0.009), tipColor: new THREE.Color(0.07, 0.045, 0.025), roughness: 0.75 } : { color: new THREE.Color(0.006, 0.005, 0.004), tipColor: new THREE.Color(0.02, 0.015, 0.012), roughness: 0.5 },
          );
          mesh.material.envMapIntensity = 0.12;
          mesh.castShadow = brow;
          break;
        }
        case 'cloth': {
          const old = mesh.material;
          const fabric = ex.fabric;
          const maps = { detail: fabricDetail(fabric) };
          if (ex.maps) Object.assign(maps, { baseColor: tex(`T_${ex.maps}_BaseColor.webp`, true), normal: tex(`T_${ex.maps}_Normal.webp`), orm: tex(`T_${ex.maps}_ORM.webp`) });
          mesh.material = createClothMaterial(maps, {
            fabric,
            color: old.color,
            roughness: old.roughness,
            tileSize: meta.textures?.Fabric?.[fabric]?.size,
            sheenColor: SHEEN[fabric],
          });
          mesh.material.userData = { ...ex, ...mesh.material.userData };
          if (/^SK_(Tank|Pants|Boots)$/.test(mesh.name)) this.garments[mesh.name.replace('SK_', '')] = mesh;
          break;
        }
        case 'flannel':
          this.flannel ??= createFlannelMaterial(tex('T_Flannel_BaseColor.webp', true), tex('T_Flannel_Normal.webp'));
          mesh.material = this.flannel;
          break;
        default:
          break;
      }
    }
    this.textureLoad = Promise.all(pending);
  }

  bone(name) {
    return this.bones.get(name);
  }

  /** Sets blendshape weights by name (missing names are ignored per mesh). */
  applyWeights(weights = this.weights) {
    for (const m of this.morphMeshes) {
      const dict = m.morphTargetDictionary;
      const inf = m.morphTargetInfluences;
      inf.fill(0);
      for (const k in weights) {
        const i = dict[k];
        if (i !== undefined) inf[i] = weights[k];
      }
    }
    const w = weights;
    // wrinkle maps: R forehead, G glabella, B crow's feet, A nose bridge
    this.wrinkleWeights.value.set(
      Math.min(1, (w.browInnerUp ?? 0) + 0.6 * Math.max(w.browOuterUpLeft ?? 0, w.browOuterUpRight ?? 0)),
      Math.min(1, Math.max(w.browDownLeft ?? 0, w.browDownRight ?? 0) * 1.1),
      Math.min(1, Math.max(w.eyeSquintLeft ?? 0, w.eyeSquintRight ?? 0, w.cheekSquintLeft ?? 0, w.cheekSquintRight ?? 0) * 1.2),
      Math.min(1, Math.max(w.noseSneerLeft ?? 0, w.noseSneerRight ?? 0) * 1.2),
    );
  }

  /** Per-frame material state that depends on the posed skeleton. */
  updateMaterials() {
    for (const e of this.eyes) {
      updateEyeUniforms(e.mesh, e.bone, e.radius, e.bindFrame);
      const u = e.mesh.material.userData.uniforms;
      const S = e.side === 'l' ? 'Left' : 'Right';
      const blink = this.weights[`eyeBlink${S}`] ?? 0;
      const wide = this.weights[`eyeWide${S}`] ?? 0;
      const squint = this.weights[`eyeSquint${S}`] ?? 0;
      const down = this.weights[`eyeLookDown${S}`] ?? 0;
      const up = this.weights[`eyeLookUp${S}`] ?? 0;
      u.lidUpper.value = 0.42 - 1.05 * blink + 0.18 * wide - 0.12 * squint - 0.25 * down + 0.2 * up;
      u.lidLower.value = -0.5 + 0.25 * squint + 0.35 * blink - 0.1 * down + 0.06 * up;
    }
  }
}

function eyeFrame(center, gaze) {
  const z = gaze.clone().normalize();
  const x = new THREE.Vector3(1, 0, 0).addScaledVector(z, -z.x).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(center);
}
