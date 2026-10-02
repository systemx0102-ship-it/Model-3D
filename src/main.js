import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Stage } from './render/stage.js';
import { Character } from './character/character.js';
import { HairSim } from './character/hairsim.js';
import { HairStrands } from './render/hair.js';
import { BodyColliders } from './character/colliders.js';

const params = new URLSearchParams(location.search);
const stage = new Stage(document.getElementById('view'), { ao: !params.has('noao') });
const { camera, scene } = stage;
const controls = new OrbitControls(camera, stage.renderer.domElement);
controls.enableDamping = true;

const VIEWS = {
  full: [[0, 1.0, 4.2], [0, 0.9, 0], 30],
  face: [[0.0, 1.62, 0.75], [0, 1.6, 0], 25],
  face34: [[0.38, 1.64, 0.62], [0, 1.6, 0.02], 25],
  profile: [[0.7, 1.62, 0.05], [0, 1.6, 0.03], 25],
  eye: [[0.06, 1.67, 0.2], [0.03, 1.665, 0.04], 20],
  eyefront: [[0.03, 1.666, 0.3], [0.03, 1.666, 0.04], 12],
  mouth: [[0.0, 1.57, 0.32], [0, 1.565, 0.08], 22],
  hand: [[0.45, 0.95, 0.55], [0.38, 0.9, 0.18], 25],
  back: [[0, 1.0, -4.2], [0, 0.9, 0], 30],
};
function setView(name) {
  const [p, t, fov] = VIEWS[name] ?? VIEWS.full;
  camera.position.set(...p);
  controls.target.set(...t);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  controls.update();
}
setView(params.get('view') ?? 'full');
if (params.has('light')) stage.setLighting(params.get('light'));

const character = await Character.load('character/', { maxAnisotropy: stage.renderer.capabilities.getMaxAnisotropy() });
scene.add(character.root);
stage.followFocus(new THREE.Vector3(0, 1.3, 0));
for (const [k, v] of (params.get('morph') ?? '').split(',').filter(Boolean).map((t) => t.split(':'))) character.weights[k] = +v;
if (params.has('flush')) stage.scene; // placeholder for UI wiring
if (params.has('hide')) for (const n of params.get('hide').split(',')) character.root.traverse((o) => { if (o.name.startsWith(n)) o.visible = false; });

const colliders = new BodyColliders(character, character.meta.colliders);
const hairSim = await HairSim.load('character/', character.meta.hair);
const hair = new HairStrands(hairSim, {
  count: +(params.get('strands') ?? character.meta.hair.strands),
  rootColor: new THREE.Color(0.028, 0.016, 0.009),
  tipColor: new THREE.Color(0.075, 0.045, 0.024),
});
scene.add(hair.mesh);
if (params.has('opaquehair')) {
  hair.material.alphaToCoverage = false;
  hair.material.onBeforeCompile = ((orig) => (sh) => { orig(sh); sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', 'diffuseColor.a = 1.0;'); })(hair.material.onBeforeCompile);
}
window.__dbg = { hairSim, hair, character, colliders, stage };
let colliderView = null;
if (params.has('colliders')) scene.add((colliderView = colliders.helpers()));
const wind = new THREE.Vector3(+(params.get('wind') ?? 0), 0, 0);
const motion = params.get('motion');

const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.9 }));
ground.receiveShadow = true;
scene.add(ground);

let frames = 0;
let last = performance.now();
let simTime = 0;
const fixedDt = params.has('fps') ? 1 / +params.get('fps') : null; // deterministic frame pacing for tests
const settleFrames = +(params.get('settle') ?? 0);
function frame() {
  const now = performance.now();
  const dt = fixedDt ?? Math.min(0.1, (now - last) / 1000);
  last = now;
  simTime += dt;
  controls.update();
  if (motion === 'turn') character.root.rotation.y = Math.sin(simTime * 2.2) * 0.9;
  if (motion === 'sway') character.root.position.x = Math.sin(simTime * 3.0) * 0.25;
  character.applyWeights();
  character.root.updateMatrixWorld(true);
  character.updateMaterials();
  hairSim.update(dt, character.bone('head').matrixWorld.elements, colliders.world(), wind.toArray());
  hair.update(simTime, wind, camera, stage.renderer.domElement.height);
  colliderView?.update();
  stage.render();
  frames++;
  if (frames === 3) {
    window.__ready = true;
    if (params.has('still')) stage.renderer.setAnimationLoop(null); // headless capture: stop after a settled frame
  }
}
// headless capture: pre-roll the simulation so hair has settled before the screenshot
for (let i = 0; i < settleFrames; i++) {
  const dt = fixedDt ?? 1 / 60;
  simTime += dt;
  character.root.updateMatrixWorld(true);
  hairSim.update(dt, character.bone('head').matrixWorld.elements, colliders.world(), wind.toArray());
}
stage.renderer.setAnimationLoop(frame);
