import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT='/private/tmp/claude-501/-Users-jeongyeong-yeon-Documents-last-vector/29cfe0ab-5a2e-4f8b-a0b3-8a5da503442d/scratchpad/course'; mkdirSync(OUT,{recursive:true});
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(true,{skill:1}); });
await p.waitForTimeout(4500);
for (const t of [0.12, 0.28, 0.45, 0.62, 0.78, 0.92]) {
  await p.evaluate(v => window.__LV.seekCourse(v), t);
  await p.waitForTimeout(1600);
  await p.screenshot({ path: `${OUT}/t-${String(Math.round(t*100)).padStart(3,'0')}.png` });
  console.log('shot', t);
}
await b.close();
