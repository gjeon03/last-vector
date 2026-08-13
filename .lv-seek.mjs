import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(true,{skill:1}); });
await p.waitForTimeout(4500);
for (const t of [0.2,0.45,0.7]) {
  const r = await p.evaluate(async v => {
    window.__LV.seekCourse(v);
    await new Promise(r=>setTimeout(r,120));
    const pose = window.__LV.pose();
    const tel = window.__LV.telemetry();
    return { fwd: pose.forward.map(x=>+x.toFixed(2)), gate: tel.gate.index, dist: Math.round(tel.gate.distance), onScreen: tel.gate.anchor.onScreen };
  }, t);
  // Does the nose point at the next gate right after the seek?
  console.log(`t=${t}`, JSON.stringify(r));
}
await b.close();
