import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Stage } from './render/stage.js';
import { Character } from './character/character.js';
import { HairSim } from './character/hairsim.js';
import { HairStrands } from './render/hair.js';
import { BodyColliders } from './character/colliders.js';
import { Overshirt } from './character/overshirt.js';
import { Terrain } from './anim/terrain.js';
import { Animator } from './anim/animator.js';
import { KeyboardInput, Tour, SPEEDS } from './input.js';
import { createPanel } from './ui/panel.js';

const params = new URLSearchParams(location.search);
const stage = new Stage(document.getElementById('view'), { ao: !params.has('noao') });
const { camera, scene } = stage;
const controls = new OrbitControls(camera, stage.renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.25;
controls.maxDistance = 9;

const VIEWS = {
  full: [[0, 1.0, 4.2], [0, 0.95, 0], 30],
  face: [[0.0, 1.62, 0.75], [0, 1.6, 0], 25],
  face34: [[0.38, 1.64, 0.62], [0, 1.6, 0.02], 25],
  profile: [[0.7, 1.62, 0.05], [0, 1.6, 0.03], 25],
  eye: [[0.06, 1.67, 0.2], [0.03, 1.665, 0.04], 20],
  eyefront: [[0.03, 1.666, 0.3], [0.03, 1.666, 0.04], 12],
  mouth: [[0.0, 1.57, 0.32], [0, 1.565, 0.08], 22],
  hand: [[0.45, 0.95, 0.55], [0.3, 0.85, 0.1], 25],
  feet: [[0.5, 0.35, 0.9], [0.05, 0.12, 0.05], 28],
  feetside: [[0.75, 0.1, 0.12], [0.08, 0.07, 0.06], 22],
  torso: [[0.35, 1.25, 1.2], [0, 1.15, 0], 30],
  waist: [[0.0, 1.05, 0.6], [0, 1.0, 0], 30],
  waistside: [[0.5, 1.02, 0.05], [0, 1.0, 0.02], 22],
  back: [[0, 1.0, -4.2], [0, 0.95, 0], 30],
  side: [[4.2, 0.95, 0], [0, 0.85, 0], 30],
  game: [[1.6, 1.9, -3.4], [0, 1.1, 0], 45],
};
let view = params.get('view') ?? 'game';
function setView(name) {
  view = name;
  const [p, t, fov] = VIEWS[name] ?? VIEWS.full;
  camera.position.set(...p);
  controls.target.set(...t);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  controls.update();
}
setView(view);
if (params.has('light')) stage.setLighting(params.get('light'));

const character = await Character.load('character/', { maxAnisotropy: stage.renderer.capabilities.getMaxAnisotropy() });
scene.add(character.root);
const terrain = new Terrain();
scene.add(terrain.mesh());
const animator = new Animator(character, terrain);
const colliders = new BodyColliders(character, character.meta.colliders);
const hairSim = await HairSim.load('character/', character.meta.hair);
const hair = new HairStrands(hairSim, {
  count: +(params.get('strands') ?? character.meta.hair.strands),
  rootColor: new THREE.Color(0.028, 0.016, 0.009),
  tipColor: new THREE.Color(0.075, 0.045, 0.024),
});
scene.add(hair.mesh);
const shirt = character.meta.overshirt && character.flannel ? new Overshirt(character, character.meta.overshirt, character.flannel) : null;
if (shirt) scene.add(shirt.group);
let colliderView = null;
if (params.has('colliders')) scene.add((colliderView = colliders.helpers()));
for (const [k, v] of (params.get('morph') ?? '').split(',').filter(Boolean).map((t) => t.split(':'))) character.weights[k] = +v;
if (params.has('hide')) for (const n of params.get('hide').split(',')) scene.traverse((o) => { if (o.name.startsWith(n)) o.visible = false; });

// held prop for combat mode (compact flashlight)
const prop = new THREE.Group();
{
  const metal = new THREE.MeshStandardMaterial({ color: 0x1b1d20, metalness: 0.85, roughness: 0.35 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.16, 20).rotateX(Math.PI / 2), metal);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.017, 0.045, 24).rotateX(Math.PI / 2), metal);
  head.position.z = 0.09;
  prop.add(body, head);
  prop.traverse((o) => (o.castShadow = true));
  prop.visible = false;
}
scene.add(prop);
animator.prop = prop;

const keyboard = new KeyboardInput();
const tour = new Tour();
const mode = { autopilot: !params.has('manual') };
const wind = new THREE.Vector3(+(params.get('wind') ?? 0), 0, 0);
const forcedExpr = params.get('expr');
if (forcedExpr) animator.face.setExpression(forcedExpr);
if (params.has('say')) animator.face.speak(params.get('say'));
const scripted = params.get('anim'); // deterministic test inputs: idle|walk|jog|run|sprint|crouch|turn

function scriptedInput(t) {
  const loco = animator.loco;
  const sp = { idle: 0, walk: SPEEDS.walk, jog: SPEEDS.jog, run: SPEEDS.run, sprint: SPEEDS.sprint, crouch: SPEEDS.walk }[scripted] ?? 0;
  // straight line along +Z (flat ground; the test terrain extends 40 m)
  const dir = sp > 0 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3();
  return { dir, speed: sp, jump: false, crouch: scripted === 'crouch', aim: scripted === 'aim', strafe: scripted === 'aim', faceYaw: loco.yaw, turnTo: scripted === 'turn' ? Math.PI : null, aimPitch: 0 };
}

// fixed simulation rate for hair and cloth: 120 Hz, or 60 Hz on slow machines (auto, or ?simhz=)
let simHz = +(params.get('simhz') ?? 120);
const setSimRate = (hz) => {
  simHz = hz;
  hairSim.setRate(hz);
  shirt?.setRate(hz);
};
if (simHz !== 120) setSimRate(simHz);
let physicsMs = 0, slowFor = 0;
function physicsBudget(ms) {
  physicsMs += (ms - physicsMs) * 0.05;
  if (params.has('simhz') || simHz <= 60) return;
  slowFor = physicsMs > 9 ? slowFor + 1 : 0;
  if (slowFor > 120) {
    setSimRate(60);
    console.info('physics: falling back to a 60 Hz fixed step');
  }
}

let simTime = 0;
let last = performance.now();
const fixedDt = params.has('fps') ? 1 / +params.get('fps') : null;
const camOffset = new THREE.Vector3();
function step(dt, render, simHair = true) {
  simTime += dt;
  let input;
  if (scripted) input = scriptedInput(simTime);
  else if (mode.autopilot && !keyboard.active) input = tour.read(dt, animator.loco);
  else {
    mode.autopilot = false;
    input = keyboard.read(camera, animator.loco);
  }
  if (!scripted) input.lookAt = camera.position.clone();
  else input.lookAt = new THREE.Vector3(0.4, 1.55, 3).add(animator.loco.pos);
  // follow camera: keep the orbit offset, track the character smoothly
  const focus = animator.loco.pos.clone().setY(animator.loco.groundY + 0.85);
  if (!['face', 'face34', 'profile', 'eye', 'eyefront', 'mouth', 'hand', 'feet', 'feetside', 'torso', 'waist', 'waistside'].includes(view)) {
    camOffset.copy(camera.position).sub(controls.target);
    controls.target.lerp(focus, render ? 1 - Math.exp(-dt / 0.15) : 1);
    camera.position.copy(controls.target).add(camOffset);
  }
  animator.update(dt, input, { light: stage.lighting === 'night' ? 0.15 : 0.7 });
  character.applyWeights();
  character.root.updateMatrixWorld(true);
  for (const e of character.eyes) e.mesh.material.userData.uniforms.pupil.value = animator.face.pupilOut ?? 0.33;
  character.updateMaterials();
  if (simHair) {
    const t0 = performance.now();
    const cw = colliders.world();
    hairSim.update(dt, character.bone('head').matrixWorld.elements, cw.filter((c) => !c.name.startsWith('pelvis_')), wind.toArray());
    shirt?.update(dt, cw, animator.loco.groundY, wind.toArray());
    if (render) physicsBudget(performance.now() - t0);
  }
  stage.followFocus(animator.loco.pos.clone().setY(animator.loco.groundY + 1.2));
}

// headless capture: deterministic pre-roll (simulated seconds) before the first rendered frame
const preroll = +(params.get('t') ?? 0);
for (let t = 0; t < preroll; t += 1 / 60) step(1 / 60, false, t > preroll - 2.5);

const app = { timeScale: 1 };
const toggleColliders = (on) => {
  if (on && !colliderView) scene.add((colliderView = colliders.helpers()));
  if (colliderView) colliderView.visible = on;
};
const panel = params.has('still') || params.get('ui') === '0'
  ? null
  : createPanel({ stage, character, animator, shirt, hair, hairSim, views: VIEWS, view, setView, mode, setSimRate, toggleColliders, wind, get timeScale() { return app.timeScale; }, set timeScale(v) { app.timeScale = v; } });

let frames = 0;
function frame() {
  const now = performance.now();
  const realDt = Math.min(0.05, (now - last) / 1000);
  const dt = fixedDt ?? realDt * app.timeScale;
  last = now;
  step(dt, true);
  panel?.tick(realDt, physicsMs);
  controls.update();
  hair.update(simTime, wind, camera, stage.renderer.domElement.height);
  if (colliderView?.visible) colliderView.update();
  const hud = document.getElementById('ui');
  if (hud && !scripted) hud.textContent = mode.autopilot ? tour.label : '';
  stage.render();
  frames++;
  if (frames === 3) {
    window.__ready = true;
    if (params.has('still')) stage.renderer.setAnimationLoop(null);
  }
}
window.__dbg = { hairSim, hair, character, colliders, stage, animator, shirt, setSimRate };
stage.renderer.setAnimationLoop(frame);
