import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT='/private/tmp/claude-501/-Users-jeongyeong-yeon-Documents-last-vector/29cfe0ab-5a2e-4f8b-a0b3-8a5da503442d/scratchpad/finish'; mkdirSync(OUT,{recursive:true});
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errs=[]; p.on('console',m=>m.type()==='error'&&errs.push(m.text())); p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(true,{skill:1}); });
let last=-1;
for (let i=0;i<420;i++){
  const s = await p.evaluate(()=>({ph:window.__LV.phase(),g:window.__LV.telemetry().gate.index, d:Math.round(window.__LV.telemetry().gate.distance)}));
  if (s.g!==last){ last=s.g; if (s.g===9) { await p.screenshot({path:`${OUT}/approach.png`}); } }
  if (s.ph==='finished') break;
  await p.waitForTimeout(500);
}
await p.waitForTimeout(2200);
await p.screenshot({ path: `${OUT}/results.png` });
console.log('phase:', await p.evaluate(()=>window.__LV.phase()));
console.log('result:', JSON.stringify(await p.evaluate(()=>window.__LV.result())));
// second run to check NEW BEST treatment and restart path
await p.evaluate(()=>window.__LV.startRun());
await p.waitForTimeout(600);
console.log('restart phase:', await p.evaluate(()=>window.__LV.phase()));
console.log('errors:', errs.slice(0,6));
await b.close();
