import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
for (const [w,h] of [[1920,1080],[2560,1440]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
  await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
  await p.evaluate(() => window.__LV.ready());
  const r = await p.evaluate(async () => {
    window.__LV.startRun(); window.__LV.setAutopilot(true, { skill: 1 });
    await new Promise(r => setTimeout(r, 9000));
    const s = await window.__LV.profile(6);
    return { fps: +s.fps.toFixed(1), mean: +s.meanFrameMs.toFixed(2), p95: +s.p95FrameMs.toFixed(2),
             p99: +s.p99FrameMs.toFixed(2), long: s.longFrames, calls: s.drawCalls, tris: s.triangles,
             scale: +s.renderScale.toFixed(3), buf: `${s.drawingBufferWidth}x${s.drawingBufferHeight}`,
             quality: window.__LV.settings().quality };
  });
  console.log(`${w}x${h}:`, JSON.stringify(r));
  await p.close();
}
await b.close();
