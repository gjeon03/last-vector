import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'load' });
await p.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
await p.evaluate(() => window.__LV.ready());
await p.evaluate(() => { window.__LV.startRun(); window.__LV.setAutopilot(true,{skill:1}); });
await p.waitForTimeout(8000);
console.log(JSON.stringify(await p.evaluate(() => {
  const roll = document.querySelector('.lv-roll--speed');
  if (!roll) return { error: 'no .lv-roll--speed' };
  const cell = roll.querySelector('.lv-roll-cell');
  const strip = roll.querySelector('.lv-roll-strip');
  const glyph = roll.querySelector('.lv-roll-glyph');
  const cs = getComputedStyle(cell), ss = getComputedStyle(strip), gs = getComputedStyle(glyph), rs = getComputedStyle(roll);
  return {
    rollFont: rs.fontSize, rollDisplay: rs.display,
    cell: { display: cs.display, overflow: cs.overflow, height: cs.height, width: cs.width, rect: cell.getBoundingClientRect().height },
    strip: { display: ss.display, transform: ss.transform, height: strip.getBoundingClientRect().height },
    glyph: { display: gs.display, height: gs.height, lineHeight: gs.lineHeight, rect: glyph.getBoundingClientRect().height },
  };
}), null, 1));
await b.close();
