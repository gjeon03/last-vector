import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
console.log('default quality:', await p.evaluate(() => window.__LV.settings().quality));
const out = await p.evaluate(async () => {
  const res = {};
  window.__LV.startRun();
  window.__LV.setAutopilot(true, { skill: 1 });
  await new Promise(r => setTimeout(r, 6000));
  for (const q of ['high','ultra']) {
    window.__LV.setSettings({ quality: q });
    await new Promise(r => setTimeout(r, 900));
    const s = await window.__LV.profile(4);
    res[q] = { fps: +s.fps.toFixed(1), mean: +s.meanFrameMs.toFixed(2), p95: +s.p95FrameMs.toFixed(2),
               p99: +s.p99FrameMs.toFixed(2), max: +s.maxFrameMs.toFixed(1), long: s.longFrames,
               calls: s.drawCalls, tris: s.triangles };
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
