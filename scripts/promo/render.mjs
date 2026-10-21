// Renders the promo clips frame by frame (headless, nothing on your screen) and writes animated WebP files.
//   node render.mjs [clip ...]     (needs playwright; see README in this folder)
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');

const FPS = Number(process.env.FPS || 25);
const clips = process.argv.slice(2).length ? process.argv.slice(2) : ['hero', 'several', 'tabs', 'snooze', 'mac', 'talk'];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

for (const clip of clips) {
  const dir = path.join(here, 'out', clip);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await page.goto('file://' + path.join(here, 'promo.html') + '?clip=' + clip);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const frames = Math.round(duration * FPS);
  for (let i = 0; i <= frames; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    await page.screenshot({ path: path.join(dir, `f_${String(i).padStart(4, '0')}.png`) });
  }
  execFileSync('python3', [path.join(here, 'to_webp.py'), dir, path.join(here, '..', '..', 'docs', 'media', `${clip}.webp`), String(FPS)], { stdio: 'inherit' });
}
await browser.close();
