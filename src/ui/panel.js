// Control panel (lil-gui): camera views, lighting, face (expressions, speech, blinks), outfit
// visibility, physics (wind, simulation rate, colliders) and live stats.
import GUI from 'lil-gui';
import { EXPRESSIONS } from '../anim/face.js';
import { skinGlobals } from '../render/skin.js';

export function createPanel(app) {
  const { stage, character, animator, shirt, hair, hairSim, lod, views, setView, mode, setSimRate, toggleColliders, wind } = app;
  const gui = new GUI({ title: 'Hero character' });
  gui.domElement.style.setProperty('--width', '270px');
  if (innerWidth < 640) gui.close(); // phones: start collapsed so the character stays visible

  const state = {
    control: mode.autopilot ? 'Demo tour' : 'Keyboard',
    view: app.view,
    lighting: stage.lighting,
    exposure: stage.renderer.toneMappingExposure,
    expression: 'neutral',
    intensity: 1,
    line: 'Hey. Ready when you are, just follow me and stay close.',
    windX: wind.x,
    windZ: wind.z,
    simHz: 120,
    hairSim: true,
    clothSim: true,
    colliders: false,
    timeScale: 1,
    outfit: { tank: true, pants: true, boots: true, shirt: true, belt: true, hair: true },
    fps: 0,
    physicsMs: 0,
    lod: 'auto',
    lodNow: 0,
    triangles: 0,
  };

  const ctl = gui.addFolder('Control');
  ctl.add(state, 'control', ['Demo tour', 'Keyboard']).name('mode').onChange((v) => {
    mode.autopilot = v === 'Demo tour';
    mode.forceKeyboard = !mode.autopilot;
  });
  ctl.add(state, 'timeScale', 0.05, 1, 0.05).name('time scale').onChange((v) => (app.timeScale = v));
  ctl.add(state, 'view', Object.keys(views)).name('camera').onChange((v) => setView(v));
  if (lod) ctl.add(state, 'lod', ['auto', '0', '1', '2', '3']).name('level of detail').onChange((v) => (lod.forced = v === 'auto' ? null : +v));

  const face = gui.addFolder('Face');
  face.add(state, 'expression', Object.keys(EXPRESSIONS)).onChange((v) => animator.face.setExpression(v, state.intensity));
  face.add(state, 'intensity', 0, 1, 0.05).onChange((v) => animator.face.setExpression(state.expression, v));
  face.add(state, 'line').name('dialogue');
  face.add({ speak: () => animator.face.speak(state.line) }, 'speak').name('▶ speak (lip sync)');
  face.add({ blink: () => animator.face.triggerBlink(0) }, 'blink').name('blink');
  face.add({ close: () => setView('face34') }, 'close').name('close-up');

  const look = gui.addFolder('Lighting');
  look.add(state, 'lighting', ['studio', 'overcast', 'sunset', 'night']).onChange((v) => {
    stage.setLighting(v);
    state.exposure = stage.renderer.toneMappingExposure;
    exposure.updateDisplay();
  });
  const exposure = look.add(state, 'exposure', 0.2, 2.5, 0.05).onChange((v) => (stage.renderer.toneMappingExposure = v));

  const phys = gui.addFolder('Physics');
  phys.add(state, 'windX', -12, 12, 0.5).name('wind X (m/s)').onChange((v) => (wind.x = v));
  phys.add(state, 'windZ', -12, 12, 0.5).name('wind Z (m/s)').onChange((v) => (wind.z = v));
  phys.add(state, 'simHz', [60, 120]).name('fixed step (Hz)').onChange((v) => setSimRate(+v));
  phys.add(state, 'hairSim').name('hair simulation').onChange((v) => (hairSim.enabled = v));
  if (shirt) phys.add(state, 'clothSim').name('cloth simulation').onChange((v) => (shirt.enabled = v));
  phys.add(state, 'colliders').name('show colliders').onChange((v) => toggleColliders(v));

  const outfit = gui.addFolder('Outfit');
  const meshes = (re) => character.meshes.filter((m) => re.test(m.name));
  const show = (re, v) => meshes(re).forEach((m) => (m.visible = v));
  const garments = skinGlobals.garments.value;
  outfit.add(state.outfit, 'tank').onChange((v) => (show(/^SK_Tank$/, v), (garments.x = v ? 1 : 0)));
  outfit.add(state.outfit, 'pants').name('trousers').onChange((v) => (show(/^SK_Pants$/, v), (garments.y = v ? 1 : 0)));
  outfit.add(state.outfit, 'boots').onChange((v) => (show(/^SK_(Boots|Sole_)/, v), (garments.z = v ? 1 : 0)));
  outfit.add(state.outfit, 'belt').name('belt + pouch').onChange((v) => show(/^SK_(Belt|Buckle|Pouch)$/, v));
  if (shirt) outfit.add(state.outfit, 'shirt').name('tied shirt').onChange((v) => (show(/^SK_ShirtTie$/, v), (shirt.group.visible = v)));
  outfit.add(state.outfit, 'hair').onChange((v) => (hair.mesh.visible = v));
  outfit.close();

  const stats = gui.addFolder('Stats');
  stats.add(state, 'fps').listen().disable();
  stats.add(state, 'physicsMs').name('physics ms/frame').listen().disable();
  if (lod) {
    stats.add(state, 'lodNow').name('LOD').listen().disable();
    stats.add(state, 'triangles').name('mesh triangles').listen().disable();
  }

  const help = document.createElement('div');
  help.className = 'help';
  help.innerHTML = '<b>Keyboard</b>: WASD move · Shift sprint · Ctrl walk · Space jump · C crouch · F aim · Q/E/T turn · drag to orbit';
  document.body.appendChild(help);

  let frames = 0, acc = 0;
  return {
    gui,
    tick(dt, physicsMs) {
      frames++;
      acc += dt;
      if (acc > 0.5) {
        state.fps = Math.round(frames / acc);
        state.physicsMs = +physicsMs.toFixed(2);
        if (lod) (state.lodNow = lod.level), (state.triangles = Math.round(lod.triangles));
        frames = 0;
        acc = 0;
      }
      help.style.opacity = mode.autopilot ? 0.55 : 1;
    },
  };
}
