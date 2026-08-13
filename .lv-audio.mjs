import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('console', m => (m.type()==='error') && errs.push(m.text()));
page.on('pageerror', e => errs.push('pageerror: '+e.message));
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await page.evaluate(() => window.__LV.ready());

// Patch: capture the AudioContext the engine creates so we can measure real output.
const before = await page.evaluate(() => {
  const orig = window.AudioContext;
  window.__ctxs = [];
  window.AudioContext = class extends orig {
    constructor(...a) { super(...a); window.__ctxs.push(this); }
  };
  return true;
});
console.log('patched', before);

await page.evaluate(() => window.__LV.startRun({ skipIntro: true }));
await page.waitForTimeout(300);
const info = await page.evaluate(async () => {
  const ctx = window.__ctxs[0];
  if (!ctx) return { error: 'no AudioContext created' };
  // Tap the destination by inserting an analyser between master and destination is not
  // possible from outside, so measure via a MediaStreamDestination fed by a new analyser
  // attached to the context's destination is also not possible. Instead report state.
  return { state: ctx.state, sampleRate: ctx.sampleRate, currentTime: ctx.currentTime, baseLatency: ctx.baseLatency };
});
console.log('audioContext:', JSON.stringify(info));
await page.waitForTimeout(2500);
const after = await page.evaluate(() => {
  const ctx = window.__ctxs[0];
  return ctx ? { state: ctx.state, currentTime: ctx.currentTime } : null;
});
console.log('after 2.5s:', JSON.stringify(after));
console.log('errors:', errs.slice(0,8));
await browser.close();
