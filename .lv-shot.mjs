import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/private/tmp/claude-501/-Users-jeongyeong-yeon-Documents-last-vector/29cfe0ab-5a2e-4f8b-a0b3-8a5da503442d/scratchpad/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith('http://127.0.0.1:') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
});

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });

const ready = await page.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 }).catch(() => null);
console.log('harness present:', Boolean(ready));
if (!ready) {
  console.log('ERRORS:', errors);
  const html = await page.content();
  console.log(html.slice(0, 1500));
  await page.screenshot({ path: `${OUT}/00-fail.png` });
  await browser.close();
  process.exit(1);
}

await page.evaluate(() => window.__LV.ready());
await page.waitForTimeout(1500);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot:', name);
};

await shot('01-title');

// Vantage matrix
const vantages = await page.evaluate(() => window.__LV.vantages());
console.log('vantages:', vantages);
let i = 2;
for (const v of vantages) {
  await page.evaluate((n) => window.__LV.vantage(n), v);
  await page.waitForTimeout(700);
  await shot(`${String(i).padStart(2, '0')}-vantage-${v}`);
  i++;
}

// Gameplay
await page.evaluate(() => {
  window.__LV.startRun({ skipIntro: true });
  window.__LV.setAutopilot(true, { skill: 1 });
});
await page.waitForTimeout(5000);
await shot(`${String(i++).padStart(2, '0')}-flying-early`);

await page.evaluate(() => window.__LV.setInput({ throttle: 1, boost: true }));
await page.waitForTimeout(2500);
await shot(`${String(i++).padStart(2, '0')}-boost`);
await page.evaluate(() => window.__LV.setInput(null));

const tele = await page.evaluate(() => JSON.parse(JSON.stringify(window.__LV.telemetry())));
console.log('telemetry:', JSON.stringify({
  phase: tele.phase, speed: Math.round(tele.speed), gate: tele.gate.index,
  dist: Math.round(tele.gate.distance), onScreen: tele.gate.anchor.onScreen, fps: Math.round(tele.fps),
}));

// Let the autopilot run the course
const deadline = Date.now() + 190000;
let last = -1;
while (Date.now() < deadline) {
  const s = await page.evaluate(() => {
    const t = window.__LV.telemetry();
    return { phase: t.phase, gate: t.gate.index, speed: Math.round(t.speed), fps: Math.round(t.fps) };
  });
  if (s.gate !== last) { console.log('  gate', s.gate, 'speed', s.speed, 'fps', s.fps); last = s.gate; }
  if (s.phase === 'finished') break;
  await page.waitForTimeout(900);
}
await shot(`${String(i++).padStart(2, '0')}-finish`);
const result = await page.evaluate(() => window.__LV.result());
console.log('result:', JSON.stringify(result));
console.log('gateHistory:', JSON.stringify(await page.evaluate(() => window.__LV.gateHistory())));

console.log('external requests:', external);
console.log('errors:', errors.slice(0, 12));
console.log('game errors:', await page.evaluate(() => window.__LV.errors()));

await browser.close();
