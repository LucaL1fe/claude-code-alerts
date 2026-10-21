// YouTube thumbnail designs drawn from scratch in thumbs.html. I = used (MacBook notch, two pills, Clawd next to the "?").
// G/H/I need the Claude logo SVGs in out/logo/ (copied from the Claude Code VS Code extension resources, not in git).
//   node thumbs.mjs [I ...]            → out/yt/thumb_<v>.png at 2560x1440
//   SCALE=1.5 node thumbs.mjs I        → out/yt/thumb_<v>_1920.png at 1920x1080 (the upload size)
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');
const scale = Number(process.env.SCALE || 2);
const suffix = scale === 2 ? '' : `_${1280 * scale}`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
for (const v of (process.argv.slice(2).length ? process.argv.slice(2) : ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])) {
  await p.goto('file://' + path.join(here, 'thumbs.html') + '?v=' + v);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(here, 'out', 'yt', `thumb_${v}${suffix}.png`) });
}
await b.close();
