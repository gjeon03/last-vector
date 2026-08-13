import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
const out = await p.evaluate(async () => {
  const res = {};
  window.__LV.startRun();
  window.__LV.setAutopilot(true, { skill: 1 });
  await new Promise(r => setTimeout(r, 6000));
  const cases = {
    'high baseline':      { quality: 'high', motionBlur: true,  chromaticAberration: true,  filmGrain: true,  renderScale: 1 },
    'no motion blur':     { quality: 'high', motionBlur: false, chromaticAberration: true,  filmGrain: true,  renderScale: 1 },
    'no blur no CA':      { quality: 'high', motionBlur: false, chromaticAberration: false, filmGrain: false, renderScale: 1 },
    'renderScale 0.75':   { quality: 'high', motionBlur: true,  chromaticAberration: true,  filmGrain: true,  renderScale: 0.75 },
    'low quality':        { quality: 'low',  motionBlur: true,  chromaticAberration: true,  filmGrain: true,  renderScale: 1 },
  };
  for (const [name, patch] of Object.entries(cases)) {
    window.__LV.setSettings(patch);
    await new Promise(r => setTimeout(r, 800));
    const s = await window.__LV.profile(3);
    res[name] = { fps: +s.fps.toFixed(1), p95: +s.p95FrameMs.toFixed(1), tris: s.triangles };
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
