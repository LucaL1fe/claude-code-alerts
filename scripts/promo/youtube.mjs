// YouTube cut: 16:9 1920x1080 frames for intro, every feature clip and outro, plus the thumbnail.
//   node youtube.mjs [thumb|video]      (needs playwright; output in out/yt/)
import { createRequire } from 'module';
import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url);
const { chromium } = require('playwright');

const FPS = 30;
const what = process.argv[2] || 'video';
const CLIPS = ['intro', 'hero', 'menubar', 'tabs', 'sessions', 'snooze', 'mac', 'talk', 'outro', 'end'];
const out = path.join(here, 'out', 'yt');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
// 1280x720 CSS pixels at 1.5x = 1920x1080
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });

if (what === 'thumb') {
  await page.goto('file://' + path.join(here, 'promo.html') + '?clip=thumb');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.render(0));
  await page.screenshot({ path: path.join(out, 'thumbnail.png') });
} else {
  const only = process.argv.slice(3);
  for (const clip of only.length ? only : CLIPS) {
    const dir = path.join(out, clip);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await page.goto('file://' + path.join(here, 'promo.html') + '?clip=' + clip);
    await page.evaluate(() => document.fonts.ready);
    const duration = await page.evaluate(() => window.DURATION);
    const frames = Math.round(duration * FPS);
    for (let i = 0; i < frames; i++) {
      await page.evaluate((t) => window.render(t), i / FPS);
      await page.screenshot({ path: path.join(dir, `f_${String(i).padStart(4, '0')}.png`) });
    }
    console.log(`${clip}: ${frames} frames (${duration.toFixed(2)} s)`);
  }
}
await browser.close();
