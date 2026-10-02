import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d22);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 1.0, 4.2);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.9, 0);
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(2, 4, 3);
scene.add(sun);

const view = params.get('view');
if (view === 'face') { camera.position.set(0.0, 1.62, 0.75); controls.target.set(0, 1.6, 0); camera.fov = 25; }
if (view === 'eye') { camera.position.set(0.06, 1.67, 0.2); controls.target.set(0.03, 1.665, 0.04); camera.fov = 20; }
if (view === 'eyeside') { camera.position.set(0.2, 1.67, 0.06); controls.target.set(0.03, 1.665, 0.04); camera.fov = 18; }
if (view === 'eyefront') { camera.position.set(0.03, 1.666, 0.3); controls.target.set(0.03, 1.666, 0.04); camera.fov = 12; }
if (view === 'mouth') { camera.position.set(0.0, 1.57, 0.32); controls.target.set(0, 1.565, 0.08); camera.fov = 22; }
if (view === 'mouthside') { camera.position.set(0.25, 1.58, 0.1); controls.target.set(0, 1.575, 0.07); camera.fov = 25; }
if (view === 'side') { camera.position.set(4.2, 1.0, 0); }
if (view === 'back') { camera.position.set(0, 1.0, -4.2); }
camera.updateProjectionMatrix();
controls.update();

new GLTFLoader().load('character/hero.glb', (gltf) => {
  scene.add(gltf.scene);
  const morphs = (params.get('morph') ?? '').split(',').filter(Boolean).map((t) => t.split(':'));
  gltf.scene.traverse((o) => {
    if (!o.morphTargetDictionary) return;
    for (const [k, v] of morphs) if (k in o.morphTargetDictionary) o.morphTargetInfluences[o.morphTargetDictionary[k]] = +v;
  });
  if (params.has('hide')) for (const n of params.get('hide').split(',')) gltf.scene.traverse((o) => { if (o.name.startsWith(n)) o.visible = false; });
  if (params.has('xray')) gltf.scene.traverse((o) => { if (o.isMesh && o.name.startsWith('SK_Body')) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.25; o.material.depthWrite = false; } });
  if (params.has('skeleton')) scene.add(new THREE.SkeletonHelper(gltf.scene));
  window.__ready = true;
});
renderer.setAnimationLoop(() => renderer.render(scene, camera));
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
