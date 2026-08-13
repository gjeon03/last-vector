import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errs = []; p.on('console', m => m.type()==='error' && errs.push(m.text())); p.on('pageerror', e => errs.push(e.message));
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun({ skipIntro: true }); window.__LV.setAutopilot(false); });
await p.waitForTimeout(4500); // let countdown finish
// hard sustained turn under boost — the case trails and drift exist for
await p.evaluate(() => window.__LV.setInput({ throttle: 1, boost: true, yaw: 0.85, pitch: 0.12 }));
await p.waitForTimeout(2600);
await p.screenshot({ path: `${OUT}/turn-boost.png` });
const t = await p.evaluate(() => { const x = window.__LV.telemetry(); const q = window.__LV.pose();
  const f = q.forward, v = q.velocity; const vl = Math.hypot(...v);
  const dot = vl > 1 ? (f[0]*v[0]+f[1]*v[1]+f[2]*v[2])/vl : 1;
  return { speed: Math.round(x.speed), slipDeg: +(Math.acos(Math.max(-1,Math.min(1,dot)))*180/Math.PI).toFixed(1), fps: Math.round(x.fps) }; });
console.log('during hard boost turn:', JSON.stringify(t));
await p.evaluate(() => window.__LV.setInput({ throttle: 1, boost: false, yaw: 0 }));
await p.waitForTimeout(1400);
await p.screenshot({ path: `${OUT}/after-turn.png` });
console.log('errors:', errs.slice(0,5));
await b.close();
