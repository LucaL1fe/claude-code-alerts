// YouTube thumbnail designs drawn from scratch in thumbs.html. G = used (MacBook notch + two pills + Claude logo); H = Clawd variant.
// G/H need the Claude logo SVGs in out/logo/ (copied from the Claude Code VS Code extension resources, not in git).
//   node thumbs.mjs      (needs playwright; output out/yt/thumb_A|B|C.png at 2560x1440)
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
for (const v of (process.argv.slice(2).length ? process.argv.slice(2) : ['A', 'B', 'C', 'D', 'E'])) {
  await p.goto('file://' + path.join(here, 'thumbs.html') + '?v=' + v);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(here, 'out', 'yt', `thumb_${v}.png`) });
}
await b.close();
