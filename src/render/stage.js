// Renderer, environment lighting, light rigs and post-processing.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const LIGHTING = {
  studio: {
    label: 'Studio portrait',
    env: 0.55,
    background: 0x16181c,
    key: { color: 0xfff1e0, intensity: 3.2, pos: [1.4, 2.6, 2.2] },
    rim: { color: 0xcfe0ff, intensity: 2.6, pos: [-1.6, 2.2, -2.0] },
    fill: { color: 0xffe8d8, intensity: 0.45, pos: [-2.2, 1.2, 1.5] },
    exposure: 1.0,
  },
  overcast: {
    label: 'Overcast exterior',
    env: 1.05,
    background: 0x8a949e,
    key: { color: 0xf3f6ff, intensity: 1.2, pos: [0.5, 4.0, 1.5] },
    rim: { color: 0xdde6f0, intensity: 0.5, pos: [-1.0, 2.0, -2.0] },
    fill: { color: 0xffffff, intensity: 0.2, pos: [-2, 1, 1] },
    exposure: 1.05,
  },
  sunset: {
    label: 'Sunset backlight',
    env: 0.35,
    background: 0x2a1a14,
    key: { color: 0xffb36b, intensity: 5.5, pos: [-0.6, 1.6, -3.0] },
    rim: { color: 0xff9a5a, intensity: 2.0, pos: [2.0, 1.4, -2.0] },
    fill: { color: 0x7d8cff, intensity: 0.5, pos: [1.0, 1.5, 3.0] },
    exposure: 1.0,
  },
  night: {
    label: 'Night / practical',
    env: 0.12,
    background: 0x07080b,
    key: { color: 0xffc58a, intensity: 2.6, pos: [1.2, 1.9, 1.0] },
    rim: { color: 0x6f8cff, intensity: 2.2, pos: [-1.5, 2.4, -1.8] },
    fill: { color: 0x334466, intensity: 0.2, pos: [-2, 1, 2] },
    exposure: 1.15,
  },
};

export class Stage {
  constructor(canvas, { pixelRatio = Math.min(devicePixelRatio, 2), ao = true } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    const r = this.renderer;
    r.setPixelRatio(pixelRatio);
    r.setSize(innerWidth, innerHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.AgXToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.01, 200);
    const pmrem = new THREE.PMREMGenerator(r);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environment = this.envMap;

    this.key = new THREE.DirectionalLight();
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.00012;
    this.key.shadow.normalBias = 0.012;
    this.key.shadow.radius = 3;
    const sc = this.key.shadow.camera;
    sc.left = -1.2; sc.right = 1.2; sc.top = 1.2; sc.bottom = -1.2; sc.near = 0.1; sc.far = 12;
    this.rim = new THREE.DirectionalLight();
    this.rim.castShadow = true;
    this.rim.shadow.mapSize.set(1024, 1024);
    this.rim.shadow.bias = -0.0002;
    this.rim.shadow.normalBias = 0.015;
    Object.assign(this.rim.shadow.camera, { left: -1.2, right: 1.2, top: 1.2, bottom: -1.2, near: 0.1, far: 12 });
    this.fill = new THREE.DirectionalLight();
    this.scene.add(this.key, this.key.target, this.rim, this.rim.target, this.fill, this.fill.target);
    this.focus = new THREE.Vector3(0, 1, 0);

    this.composer = new EffectComposer(r, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 4, type: THREE.HalfFloatType }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (ao) {
      this.gtao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);
      this.gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: 12 });
      this.gtao.blendIntensity = 0.75;
      this.composer.addPass(this.gtao);
    }
    this.composer.addPass(new OutputPass());
    this.setLighting('studio');
    addEventListener('resize', () => this.resize());
  }

  setLighting(name) {
    const L = LIGHTING[name];
    this.lighting = name;
    this.scene.environmentIntensity = L.env;
    this.scene.background = new THREE.Color(L.background);
    this.renderer.toneMappingExposure = L.exposure;
    for (const k of ['key', 'rim', 'fill']) {
      this[k].color.set(L[k].color);
      this[k].intensity = L[k].intensity;
      this[k].userData.offset = new THREE.Vector3(...L[k].pos);
    }
    this.followFocus(this.focus);
  }

  /** Keeps the light rig (and the tight shadow frusta) centred on the character. */
  followFocus(p) {
    this.focus.copy(p);
    for (const k of ['key', 'rim', 'fill']) {
      const l = this[k];
      l.position.copy(p).add(l.userData.offset ?? new THREE.Vector3(1, 2, 2));
      l.target.position.copy(p);
      l.target.updateMatrixWorld();
    }
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }

  render() {
    this.composer.render();
  }
}
