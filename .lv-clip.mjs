import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT='/private/tmp/claude-501/-Users-jeongyeong-yeon-Documents-last-vector/29cfe0ab-5a2e-4f8b-a0b3-8a5da503442d/scratchpad/hud'; mkdirSync(OUT,{recursive:true});
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(true,{skill:1}); });
await p.waitForTimeout(9000);
for (let i=0;i<3;i++){ await p.screenshot({ path: `${OUT}/speed-${i}.png`, clip:{x:20,y:440,width:340,height:220} }); await p.waitForTimeout(400); }
console.log('done');
await b.close();
