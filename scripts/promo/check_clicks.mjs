// Renders the frame at each click and saves a close-up around the cursor tip, to check the clicks land on target.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');
const checks = [['hero', 5.4], ['menubar', 2.15], ['menubar', 3.5], ['menubar', 4.9], ['tabs', 6.2], ['sessions', 5.6], ['snooze', 3.5]];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
let n = 0;
for (const [clip, t] of checks) {
  await page.goto('file://' + path.join(here, 'promo.html') + '?clip=' + clip);
  await page.evaluate(() => document.fonts.ready);
  // play up to t so cached targets are filled like in the real render
  for (let x = 0; x <= t + 1e-9; x += 0.05) await page.evaluate((v) => window.render(v), Math.min(x, t));
  await page.evaluate((v) => window.render(v), t - 0.1); // just before the click: arrow not pressed
  const r = await page.evaluate(() => { const c = document.querySelector('#cursor').getBoundingClientRect(); return { x: c.left, y: c.top }; });
  const clip_ = { x: Math.max(0, r.x - 90), y: Math.max(0, r.y - 70), width: 180, height: 140 };
  await page.screenshot({ path: path.join(here, 'out', `click_${n++}_${clip}_${t}.png`), clip: clip_ });
}
await b.close();
