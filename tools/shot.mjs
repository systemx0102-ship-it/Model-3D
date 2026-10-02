// Headless screenshots of the viewer for visual verification.
// usage: node tools/shot.mjs out.png "?view=face" [width height waitMs]
import { chromium } from 'playwright-core';
const [out, query = '', w = '900', h = '1100', wait = '1500'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:5173/${query}${query.includes('?') ? '&' : '?'}still=1`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.waitForTimeout(+wait);
await page.screenshot({ path: out, timeout: 180000 });
await browser.close();
if (logs.length) console.log(logs.filter((l) => !l.includes('GPU stall')).slice(0, 30).join('\n'));
