import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:5173/?view=side&anim=run&t=3&noao=1&strands=100&still=1&fps=60');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
const r = await page.evaluate(() => {
  const { animator } = window.__dbg;
  const L = animator.loco, rig = animator.rig;
  const rows = [];
  const inp = { dir: { x: 0, y: 0, z: 1, clone() { return new this.constructor(); } } };
  for (let i = 0; i < 24; i++) {
    animator.update(1 / 60, { dir: rig.object.position.clone().set(0, 0, 1), speed: 4.2, jump: false, crouch: false, aim: false, strafe: false, faceYaw: 0, turnTo: null, lookAt: rig.object.position.clone().set(0, 1.5, 100) });
    const pel = rig.worldPos('pelvis', rig.object.position.clone());
    const al = rig.worldPos('foot_l', rig.object.position.clone()), ar = rig.worldPos('foot_r', rig.object.position.clone());
    rows.push([+(pel.z - L.pos.z).toFixed(3), L.feet.l.swing ? +(L.feet.l.swing.to.z - L.pos.z).toFixed(2) : +(L.feet.l.ground.z - L.pos.z).toFixed(2), +L.phase.toFixed(2), +(pel.y - L.groundY).toFixed(3), +L.debugLower.toFixed(3), +(al.z - pel.z).toFixed(2), +(ar.z - pel.z).toFixed(2), +al.y.toFixed(2), +ar.y.toFixed(2), L.feet.l.swing ? 'S' : '-', L.feet.r.swing ? 'S' : '-']);
  }
  return { rows, legLen: rig.legLength, pelvisH: rig.pelvisHeight, hip: rig.hipHeight, duty: L.duty, cad: L.cadence };
});
console.log(JSON.stringify(r.rows.map((x) => x.join(' '))), r.legLen, r.pelvisH, r.hip, r.duty, r.cad);
await browser.close();
