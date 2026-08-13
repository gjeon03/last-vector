import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = '/private/tmp/claude-501/-Users-jeongyeong-yeon-Documents-last-vector/29cfe0ab-5a2e-4f8b-a0b3-8a5da503442d/scratchpad/speck';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
const cases = [
  ['a-ultra',  { quality: 'ultra' }],
  ['b-low',    { quality: 'low' }],
];
for (const [name, patch] of cases) {
  await p.evaluate(q => window.__LV.setSettings(q), patch);
  await p.evaluate(() => window.__LV.vantage('long-run'));
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 240, y: 620, width: 480, height: 300 } });
  // Count strongly green pixels in the clip via canvas readback of the page screenshot
  console.log('shot', name);
}
await b.close();
