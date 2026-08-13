import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await page.evaluate(() => window.__LV.ready());
await page.waitForTimeout(1000);
const cases = [
  ['a-baseline', {}],
  ['b-no-ca', { chromaticAberration: false }],
  ['c-no-ca-no-grain', { chromaticAberration: false, filmGrain: false }],
  ['d-low-quality', { chromaticAberration: false, filmGrain: false, quality: 'low' }],
];
for (const [name, patch] of cases) {
  await page.evaluate(p => window.__LV.setSettings(p), patch);
  await page.evaluate(() => window.__LV.vantage('terminus'));
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 1150, y: 120, width: 620, height: 420 } });
  console.log('shot', name);
}
await browser.close();
