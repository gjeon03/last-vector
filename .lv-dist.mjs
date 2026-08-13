import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(false); });
await p.waitForTimeout(4500);
// Measure the on-screen separation of the two nozzle trails as a proxy for camera distance:
// instead, measure directly by projecting the ship through the telemetry gate anchor maths.
for (const [name, input] of [['idle',{throttle:0}],['cruise',{throttle:1}],['boost',{throttle:1,boost:true}]]) {
  await p.evaluate(i => window.__LV.setInput(i), input);
  await p.waitForTimeout(3500);
  const r = await p.evaluate(() => {
    const t = window.__LV.telemetry();
    return { speed: Math.round(t.speed) };
  });
  console.log(name, JSON.stringify(r));
}
await p.evaluate(() => window.__LV.setSettings({ motionBlur:false, chromaticAberration:false }));
await p.waitForTimeout(1200);
await p.screenshot({ path: '/private/tmp/claude-501/-Users-jeongyeong-yeon-Documents-last-vector/29cfe0ab-5a2e-4f8b-a0b3-8a5da503442d/scratchpad/cam/boost-fixed.png', clip:{x:560,y:330,width:800,height:620} });
await b.close();
