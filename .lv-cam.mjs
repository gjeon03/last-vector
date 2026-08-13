import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT='/private/tmp/claude-501/-Users-jeongyeong-yeon-Documents-last-vector/29cfe0ab-5a2e-4f8b-a0b3-8a5da503442d/scratchpad/cam'; mkdirSync(OUT,{recursive:true});
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(false); });
await p.waitForTimeout(4500);
for (const [name, input] of [['cruise',{throttle:1}],['boost',{throttle:1,boost:true}]]) {
  await p.evaluate(i => window.__LV.setInput(i), input);
  await p.waitForTimeout(3200);
  const r = await p.evaluate(() => {
    const t = window.__LV.telemetry();
    return { speed: Math.round(t.speed), fov: null };
  });
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, JSON.stringify(r));
}
// disable post entirely so the raw ship read is unambiguous
await p.evaluate(() => window.__LV.setSettings({ motionBlur:false, chromaticAberration:false, filmGrain:false }));
await p.evaluate(() => window.__LV.setInput({ throttle: 0.4 }));
await p.waitForTimeout(3000);
await p.screenshot({ path: `${OUT}/clean.png`, clip: { x: 660, y: 380, width: 600, height: 500 } });
console.log('done');
await b.close();
