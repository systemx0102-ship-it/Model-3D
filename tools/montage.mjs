// Tiles PNG screenshots into one image: node tools/montage.mjs out.png cols a.png b.png ...
import fs from 'node:fs';
import { PNG } from 'pngjs';
const [out, cols, ...files] = process.argv.slice(2);
const imgs = files.map((f) => PNG.sync.read(fs.readFileSync(f)));
const w = Math.max(...imgs.map((i) => i.width)), h = Math.max(...imgs.map((i) => i.height));
const c = +cols, r = Math.ceil(imgs.length / c);
const dst = new PNG({ width: w * c, height: h * r });
imgs.forEach((img, k) => PNG.bitblt(img, dst, 0, 0, img.width, img.height, (k % c) * w, Math.floor(k / c) * h));
fs.writeFileSync(out, PNG.sync.write(dst));
