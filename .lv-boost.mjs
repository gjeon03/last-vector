import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(false); });
await p.waitForTimeout(4500);
await p.evaluate(() => window.__LV.setInput({ throttle: 1, boost: true }));
const trace=[];
for (let i=0;i<40;i++){ trace.push(await p.evaluate(()=>{const t=window.__LV.telemetry();return {e:+t.energy.toFixed(3), b:t.boosting};})); await p.waitForTimeout(500); }
// count how many separate boost bursts occur while the key is held down the whole time
let bursts=0, prev=false, burstLen=0, lens=[];
for (const s of trace){ if (s.b && !prev){bursts++;burstLen=0;} if (s.b) burstLen++; if (!s.b && prev) lens.push(burstLen*0.5); prev=s.b; }
if (prev) lens.push(burstLen*0.5);
console.log('bursts while held:', bursts, 'durations(s):', lens);
console.log('energy trace:', trace.map(t=>t.e).join(' '));
await b.close();
