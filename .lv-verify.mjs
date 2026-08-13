import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; p.on('console', m => m.type()==='error' && errs.push(m.text())); p.on('pageerror', e => errs.push(e.message));
await p.goto('http://127.0.0.1:4173/?seed=12345', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());

console.log('seed from URL:', await p.evaluate(() => window.__LV.seed));

// --- step determinism -----------------------------------------------------------------
const stepTest = await p.evaluate(async () => {
  window.__LV.startRun();
  window.__LV.setDriven(true);
  await window.__LV.step(300, 1/60);   // burn the countdown
  const before = window.__LV.telemetry().elapsed;
  await window.__LV.step(60, 1/60);
  const after = window.__LV.telemetry().elapsed;
  window.__LV.setDriven(false);
  return { delta: +(after - before).toFixed(6), expected: +(60/60).toFixed(6) };
});
console.log('step(60,1/60) elapsed delta:', JSON.stringify(stepTest),
            stepTest.delta === stepTest.expected ? 'EXACT ✓' : 'DRIFT ✗');

// --- pause coherence -------------------------------------------------------------------
await p.evaluate(() => { window.__LV.startRun(); });
await p.waitForTimeout(4500);
const pauseTest = await p.evaluate(async () => {
  const el0 = window.__LV.telemetry().elapsed;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const el1 = window.__LV.telemetry().elapsed;
  const paused = document.querySelector('[data-view="pause"], .lv-screen[data-view="pause"]') !== null
    || (document.body.innerText || '').toUpperCase().includes('PAUSED');
  return { frozen: Math.abs(el1 - el0) < 0.02, screenShowsPause: paused, el0, el1 };
});
console.log('pause:', JSON.stringify(pauseTest),
            (pauseTest.frozen && pauseTest.screenShowsPause) ? 'COHERENT ✓' : 'DESYNC ✗');

// --- quality actually changes workload --------------------------------------------------
const perf = await p.evaluate(async () => {
  const out = {};
  for (const q of ['ultra', 'low']) {
    window.__LV.setSettings({ quality: q });
    await new Promise(r => setTimeout(r, 700));
    const s = await window.__LV.profile(1.6);
    out[q] = { fps: Math.round(s.fps), drawCalls: s.drawCalls, triangles: s.triangles, p95: +s.p95FrameMs.toFixed(2) };
  }
  return out;
});
console.log('quality workload:', JSON.stringify(perf));
console.log('errors:', errs.slice(0,6));
await b.close();
