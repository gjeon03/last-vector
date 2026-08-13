import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2];
const names = process.argv.slice(3);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', m => m.type()==='error' && errs.push(m.text()));
page.on('pageerror', e => errs.push(e.message));
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await page.evaluate(() => window.__LV.ready());
await page.waitForTimeout(1200);
for (const n of names) {
  await page.evaluate(v => window.__LV.vantage(v), n);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log('shot', n);
}
console.log('errors:', errs.slice(0,5));
await browser.close();
