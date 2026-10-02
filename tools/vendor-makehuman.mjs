// Copies the CC0 MakeHuman assets this project builds on into third_party/makehuman.
// Only data assets are vendored (CC0, see LICENSE.ASSETS.md); no MakeHuman (AGPL) code is used.
//
// Source: a local clone (MH_DIR env var, default ../makehumancommunity/makehuman) or, when
// absent, raw.githubusercontent.com at the pinned commit from tools/makehuman-manifest.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'makehuman-manifest.json'), 'utf8'));
const outDir = path.join(repoRoot, 'third_party', 'makehuman');
const localClone = process.env.MH_DIR ?? path.resolve(repoRoot, '..', 'makehumancommunity', 'makehuman');
const haveClone = fs.existsSync(path.join(localClone, manifest.root));

async function readSource(rel) {
  const full = path.posix.join(manifest.root, rel);
  if (haveClone) return fs.readFileSync(path.join(localClone, full));
  const url = `https://raw.githubusercontent.com/${manifest.repo}/${manifest.commit}/${path.posix.normalize(full)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function listDir(rel) {
  if (haveClone) return fs.readdirSync(path.join(localClone, manifest.root, 'targets', rel));
  const api = `https://api.github.com/repos/${manifest.repo}/contents/${manifest.root}/targets/${rel}?ref=${manifest.commit}`;
  const res = await fetch(api);
  if (!res.ok) throw new Error(`${res.status} listing ${api}`);
  return (await res.json()).map((e) => e.name);
}

const jobs = [];
for (const f of manifest.files) {
  const dest = f.startsWith('../') ? path.basename(f) : f.startsWith('macrodetails') ? path.join('targets', f) : f;
  const src = f.startsWith('macrodetails') ? path.posix.join('targets', f) : f;
  jobs.push([src, dest]);
}
for (const entry of manifest.targetDirs) {
  const dir = typeof entry === 'string' ? entry : entry.dir;
  const re = typeof entry === 'string' ? null : new RegExp(entry.match);
  for (const name of await listDir(dir)) {
    if (!name.endsWith('.target')) continue;
    if (re && !re.test(name)) continue;
    jobs.push([path.posix.join('targets', dir, name), path.join('targets', dir, name)]);
  }
}

let bytes = 0;
for (const [src, dest] of jobs) {
  const data = await readSource(src);
  const out = path.join(outDir, dest);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  bytes += data.length;
}
fs.writeFileSync(
  path.join(outDir, 'SOURCE.md'),
  `# MakeHuman CC0 assets\n\nVendored by \`tools/vendor-makehuman.mjs\` from ` +
    `https://github.com/${manifest.repo} at commit \`${manifest.commit}\`.\n\n` +
    `These files are MakeHuman *assets* (base mesh hm08, targets, skeleton, weights, pose units), ` +
    `released under CC0 1.0 — see LICENSE.ASSETS.md. No MakeHuman program code (AGPL) is included or used.\n`,
);
console.log(`vendored ${jobs.length} files (${(bytes / 1e6).toFixed(1)} MB) into ${path.relative(repoRoot, outDir)} from ${haveClone ? localClone : 'GitHub'}`);
