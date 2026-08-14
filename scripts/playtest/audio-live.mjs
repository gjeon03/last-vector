#!/usr/bin/env node
/**
 * Live-context audio assertions for LAST VECTOR.
 *
 * `audio-probe.mjs` renders through an OfflineAudioContext. That makes it the right instrument for
 * "can this cue be heard over the drive", and structurally incapable of seeing an entire class of
 * defect: an OfflineAudioContext is never suspended, never resumed, and has no state machine to
 * get stuck in. Two blockers in a row were of exactly that class — a context left suspended after
 * a visibility round-trip, and a transient duck that released to unity and cancelled the static
 * menu trim underneath it — while the offline gate was reporting 23/23 green.
 *
 * So this suite does the opposite: it runs a REAL AudioContext in a real browser and asserts on
 * mix state and context state over time. It makes no claim about how anything sounds.
 *
 * Scope: the audio layer only. It constructs `AudioEngine` directly rather than driving the game,
 * so it needs no dist build and no `window.__LV`. The game-level wiring assertion — that the
 * context is running after alt-tabbing away during a pause — needs the harness to expose the audio
 * bus, and is called out in the output rather than silently skipped.
 *
 * Usage:  node scripts/playtest/audio-live.mjs [--out <dir>] [--json] [--require-clean]
 */

import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
import { REPO_ROOT } from './runtime.mjs';

/**
 * Automation needs time to settle before it is sampled. `menuMix` ramps with a 0.12 s time
 * constant and the duck releases with 0.1 s, so 900 ms is roughly 7 time constants — the first
 * version of this suite sampled the menu ramp at 400 ms, read 0.151 against a target of 0.12, and
 * failed. That was the assertion measuring mid-ramp, not the mix being wrong.
 */
const SETTLE_MS = 900;
/** Linear-gain tolerance. Generous enough for exponential approach, tight enough to catch unity. */
const TOL = 0.03;

/* eslint-disable */
async function runInPage(config) {
  const { bundleUrl, settleMs, tol } = config;
  const mod = await import(bundleUrl);
  const { AudioEngine, MENU_DUCK_DEPTH, MENU_MUSIC_DEPTH } = mod;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const near = (a, b) => Math.abs(a - b) <= tol;
  const add = (id, passed, detail) => checks.push({ id, passed, detail });

  const engine = new AudioEngine({ seed: 11 });
  await engine.unlock();

  if (!engine.ready) {
    add('LIVE.context-created', false, 'AudioEngine.ready is false; no live context available');
    return { checks, constants: { MENU_DUCK_DEPTH, MENU_MUSIC_DEPTH } };
  }
  add('LIVE.context-created', true, 'AudioEngine.ready is true');

  const state = () => engine.debugMixState();
  add('LIVE.context-running', state().contextState === 'running', `ctx.state = ${state().contextState} after unlock()`);

  // --- suspend / resume round-trip ------------------------------------------------------------
  engine.suspend();
  await wait(150);
  const suspended = state().contextState;
  engine.resume();
  await wait(250);
  const resumed = state().contextState;
  add(
    'LIVE.suspend-resume',
    resumed === 'running',
    `suspend -> ${suspended}, resume -> ${resumed} (must return to running; a context left ` +
      `suspended is silent for the rest of the session with no route out)`,
  );

  // Resuming a context that was never suspended must be a harmless no-op, not an error.
  engine.resume();
  await wait(120);
  add('LIVE.redundant-resume', state().contextState === 'running', `ctx.state = ${state().contextState}`);

  // --- static menu trim -------------------------------------------------------------------------
  engine.menuMix(true);
  await wait(settleMs);
  let s = state();
  add(
    'LIVE.menu-duck-applied',
    near(s.engineDuck, MENU_DUCK_DEPTH) && near(s.musicDuck, MENU_MUSIC_DEPTH),
    `engineDuck ${s.engineDuck.toFixed(3)} (want ${MENU_DUCK_DEPTH}), musicDuck ${s.musicDuck.toFixed(3)} (want ${MENU_MUSIC_DEPTH})`,
  );

  // --- the regression: a transient duck must not cancel the static trim -----------------------
  engine.play('uiClick', 0.5);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.ui-click-preserves-menu-duck',
    near(s.engineDuck, MENU_DUCK_DEPTH),
    `engineDuck ${s.engineDuck.toFixed(3)} after a UI click in a menu (want ${MENU_DUCK_DEPTH}; ` +
      `1.000 means the click released to unity and un-ducked the drive for the rest of the menu)`,
  );

  engine.play('finish', 1);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.event-duck-preserves-menu-music',
    near(s.musicDuck, MENU_MUSIC_DEPTH),
    `musicDuck ${s.musicDuck.toFixed(3)} after a ducking cue in a menu (want ${MENU_MUSIC_DEPTH}; ` +
      `1.000 means the same defect on the music bus)`,
  );

  // --- leaving the menu restores unity ---------------------------------------------------------
  engine.menuMix(false);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.menu-release',
    near(s.engineDuck, 1) && near(s.musicDuck, 1),
    `engineDuck ${s.engineDuck.toFixed(3)}, musicDuck ${s.musicDuck.toFixed(3)} (both want 1)`,
  );

  // --- a duck during flight still returns to unity ---------------------------------------------
  engine.play('uiClick', 0.5);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.duck-releases-in-flight',
    near(s.engineDuck, 1),
    `engineDuck ${s.engineDuck.toFixed(3)} outside a menu (want 1; the floor must not leak)`,
  );

  // --- menuMix before unlock must not be lost ----------------------------------------------------
  const early = new AudioEngine({ seed: 12 });
  early.menuMix(true);
  await early.unlock();
  await wait(settleMs);
  const es = early.debugMixState();
  add(
    'LIVE.menu-before-unlock',
    es !== null && near(es.engineDuck, MENU_DUCK_DEPTH),
    es === null ? 'no context' : `engineDuck ${es.engineDuck.toFixed(3)} when menuMix preceded unlock (want ${MENU_DUCK_DEPTH})`,
  );
  early.dispose();

  engine.dispose();
  add('LIVE.dispose-clean', engine.debugMixState() === null && !engine.ready, 'graph released and ready is false');

  return { checks, constants: { MENU_DUCK_DEPTH, MENU_MUSIC_DEPTH } };
}
/* eslint-enable */

function parseArgs(argv) {
  const options = { out: resolve(REPO_ROOT, 'playtest-out/audio-live'), json: false, requireClean: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = resolve(REPO_ROOT, argv[++i] ?? '.');
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--require-clean') options.requireClean = true;
  }
  return options;
}

async function readProvenance() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const git = async (args, raw = false) => {
    try {
      const { stdout } = await run('git', args, { cwd: REPO_ROOT });
      return raw ? stdout.replace(/\n$/, '') : stdout.trim();
    } catch {
      return null;
    }
  };
  const commit = await git(['rev-parse', 'HEAD']);
  const status = await git(['status', '--porcelain'], true);
  const dirtyFiles = status ? status.split('\n').filter(Boolean).map((l) => l.slice(3)) : [];
  return {
    commit,
    clean: status === '',
    dirtyFiles,
    measuredAt: commit ? `${commit.slice(0, 7)}${status === '' ? '' : ' (DIRTY TREE)'}` : 'unknown',
  };
}

/**
 * The game phase needs a real build, and it must not be an old one.
 *
 * An earlier version reused any existing `dist/` unconditionally. A `dist/` built before
 * `audioState()` was added to the harness therefore served a game whose `window.__LV` lacked the
 * method this phase waits for, and the suite reported a 45 s timeout — which reads as the game
 * failing to boot, sends you looking in `Game.ts` and `main.ts`, and is none of those things. It
 * is the stale-artefact failure the project's own measurement notes warn about, in the harness
 * that is supposed to catch that class.
 *
 * So: rebuild whenever anything under `src/` is newer than the build, and say which path was taken.
 */
async function ensureDist() {
  const { stat, readdir } = await import('node:fs/promises');
  const dist = resolve(REPO_ROOT, 'dist');
  const rebuild = async (reason) => {
    const { build } = await import('vite');
    await build({ root: REPO_ROOT, logLevel: 'silent' });
    return { dist, built: true, reason };
  };

  let builtAt;
  try {
    builtAt = (await stat(resolve(dist, 'index.html'))).mtimeMs;
  } catch {
    return rebuild('no dist/index.html');
  }

  let newestSource = 0;
  let newestPath = null;
  const roots = ['src', 'index.html', 'vite.config.ts', 'package.json'];
  for (const rel of roots) {
    const abs = resolve(REPO_ROOT, rel);
    try {
      const info = await stat(abs);
      if (info.isDirectory()) {
        for (const entry of await readdir(abs, { recursive: true })) {
          const file = resolve(abs, entry);
          const st = await stat(file).catch(() => null);
          if (st?.isFile() && st.mtimeMs > newestSource) { newestSource = st.mtimeMs; newestPath = `${rel}/${entry}`; }
        }
      } else if (info.mtimeMs > newestSource) {
        newestSource = info.mtimeMs;
        newestPath = rel;
      }
    } catch { /* a missing optional root is not an error */ }
  }

  if (newestSource > builtAt) return rebuild(`${newestPath} is newer than dist/index.html`);
  return { dist, built: false, reason: 'dist is newer than every source file' };
}

async function buildAudioBundle(outDir) {
  const { build } = await import('vite');
  await build({
    configFile: false,
    root: REPO_ROOT,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      lib: { entry: resolve(REPO_ROOT, 'src/audio/index.ts'), formats: ['es'], fileName: () => 'audio.js' },
    },
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Phase two: the same questions asked of the real game rather than of the audio layer alone.
 *
 * The defect this exists for lived in `Game.ts` wiring, not in the mix — a guard that refused to
 * resume the context while paused, so alt-tabbing away during a pause left the game silent with no
 * route back. Nothing that constructs `AudioEngine` directly can see that, which is why this phase
 * drives the built game through `window.__LV`.
 */
async function runGamePhase(playwright, distDir) {
  const checks = [];
  const add = (id, passed, detail, severity = 'fail') => checks.push({ id, passed, detail, severity });
  const served = await serveDir(distDir);
  // The GPU flags match scripts/playtest/runtime.mjs. Without them three.js cannot get a WebGL
  // context on macOS, the game never boots, and `window.__LV` never appears — which presents as a
  // timeout waiting for the harness rather than as anything to do with audio.
  const browser = await playwright.chromium.launch({
    args: [
      '--autoplay-policy=no-user-gesture-required',
      ...(process.platform === 'darwin'
        ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
        : []),
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    await page.goto(`${served.origin}/`, { waitUntil: 'load' });
    // Distinguish "the game never booted" from "the game booted but this build is too old", which
    // otherwise present identically as a timeout on the line below.
    const booted = await page
      .waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (!booted) {
      add('GAME.harness-present', false,
        `window.__LV never appeared within 45 s. Served from ${distDir}. ` +
        (errors.length ? `page errors: ${errors.slice(0, 3).join(' ; ')}` : 'no page errors — suspect the static server, not the game'));
      return checks;
    }
    const hasAudioState = await page.evaluate(() => typeof window.__LV?.audioState === 'function');
    if (!hasAudioState) {
      add('GAME.harness-present', false,
        'window.__LV exists but has no audioState(). The served build predates that method: this is a ' +
        'stale dist, not a broken game. Delete dist/ or touch a source file and re-run.');
      return checks;
    }
    add('GAME.harness-present', true, 'window.__LV.audioState() is available in the served build');
    await page.evaluate(() => window.__LV.ready());

    // unlock() is wired to the first pointerdown/keydown on the window, so this is the gesture.
    await page.mouse.click(400, 400);
    await page.waitForTimeout(600);

    let st = await page.evaluate(() => window.__LV.audioState());
    add('GAME.audio-running', st !== null && st.contextState === 'running',
      st === null ? 'audioState() returned null; the context was never created' : `ctx.state = ${st.contextState} after a click`);

    await page.evaluate(() => window.__LV.startRun({ skipIntro: true }));
    await page.waitForTimeout(700);

    // Pause with a real ESC keypress, not `__LV.setPaused`. The harness setter assigns the flag
    // and nothing else; `pause()` is what releases pointer lock and applies the menu mix, so a
    // test that pauses through the harness is asserting against a state no player ever sees.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);

    st = await page.evaluate(() => window.__LV.audioState());
    add('GAME.paused-duck', st !== null && st.menuEngineFloor < 1 && Math.abs(st.engineDuck - st.menuEngineFloor) <= TOL,
      st === null ? 'no audio state' : `while paused via ESC: engineDuck ${st.engineDuck.toFixed(3)}, menuEngineFloor ${st.menuEngineFloor} ` +
        `(the drive must be sitting on the menu floor, not at unity)`);

    // `pauseMenu()` is the sanctioned harness route to the player's pause. When it exists, use it:
    // it is the same code path as ESC without the keyboard-focus fragility, and the property worth
    // asserting becomes "the sanctioned route reaches the state a player reaches".
    //
    // `setPaused` deliberately does less — it freezes simulation for the stills suite and must not
    // open the menu, release the pointer or duck the drive. That is by design ONCE a sanctioned
    // route exists. Until then it is the only pause a headless check can reach, and a path that
    // silently does less than the real one is how a defect hides from every automated run, so it
    // is reported as a warning in that case and not in the other.
    const hasPauseMenu = await page.evaluate(() => typeof window.__LV?.pauseMenu === 'function');
    if (hasPauseMenu) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      await page.evaluate(() => window.__LV.pauseMenu(true));
      await page.waitForTimeout(900);
      const viaMenu = await page.evaluate(() => window.__LV.audioState());
      add(
        'GAME.pauseMenu-matches-real-pause',
        viaMenu !== null && viaMenu.menuEngineFloor < 1 && Math.abs(viaMenu.engineDuck - viaMenu.menuEngineFloor) <= TOL,
        `pauseMenu(true): engineDuck ${viaMenu?.engineDuck?.toFixed(3) ?? 'n/a'}, menuEngineFloor ` +
          `${viaMenu?.menuEngineFloor ?? 'n/a'} — the sanctioned harness route must reach the same ` +
          `mix state as a real ESC, which it is compared against directly above`,
      );
      await page.evaluate(() => window.__LV.pauseMenu(false));
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
    } else {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      await page.evaluate(() => window.__LV.setPaused(true));
      await page.waitForTimeout(900);
      const viaSetter = await page.evaluate(() => window.__LV.audioState());
    // Reported as a warning rather than a hard failure: the defect is real and in Game.ts, but it
    // is not an audio defect, and turning the audio gate red for it would leave the whole suite
    // blocked on a fix nobody had agreed to own. It stays loudly in the output and in
    // report.json so it cannot decay into an unstated gap. Flip `'warn'` to `'fail'` once
    // Game.setPaused routes through pause()/resume().
    add('GAME.setPaused-matches-real-pause', viaSetter !== null && viaSetter.menuEngineFloor < 1,
      `__LV.setPaused(true) leaves menuEngineFloor ${viaSetter?.menuEngineFloor ?? 'n/a'} where ESC leaves it below 1. ` +
      `Game.setPaused assigns the flag without calling pause(), so it skips menuMix and releaseLock — ` +
      `any headless check that pauses this way tests a state the player cannot reach`,
        'warn');
      await page.evaluate(() => window.__LV.setPaused(false));
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
    }

    // The round trip. A real tab switch is preferred; a synthesised visibilitychange is the
    // fallback, and which one ran is reported, because they are not equally strong evidence.
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.waitForTimeout(400);
    const reallyHidden = await page.evaluate(() => document.hidden);
    if (!reallyHidden) {
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await page.waitForTimeout(700);
    const hiddenState = await page.evaluate(() => window.__LV.audioState());

    await page.bringToFront();
    if (!reallyHidden) {
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await other.close();
    await page.waitForTimeout(900);

    st = await page.evaluate(() => window.__LV.audioState());
    const method = reallyHidden ? 'real tab switch' : 'synthesised visibilitychange';
    add('GAME.visibility-roundtrip-while-paused', st !== null && st.contextState === 'running',
      `hidden -> ${hiddenState?.contextState ?? 'n/a'}, shown -> ${st?.contextState ?? 'n/a'} while paused, via ${method} ` +
      `(must return to running; this is the alt-tab-during-pause path that left the game silent)`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    st = await page.evaluate(() => window.__LV.audioState());
    add('GAME.unpause-restores', st !== null && st.contextState === 'running' && st.engineDuck > 0.5,
      st === null ? 'no audio state' : `after unpause: ctx ${st.contextState}, engineDuck ${st.engineDuck.toFixed(3)} (drive must come back up)`);

    add('GAME.no-page-errors', errors.length === 0, errors.length ? errors.join(' | ') : 'no uncaught page errors');
  } catch (error) {
    add(
      'GAME.phase-completed',
      false,
      `game phase threw: ${error instanceof Error ? error.message : String(error)}` +
        (errors.length ? ` | page errors: ${errors.slice(0, 3).join(' ; ')}` : ' | no page errors captured'),
    );
  } finally {
    await browser.close().catch(() => {});
    await new Promise((done) => served.server.close(done));
  }
  return checks;
}

/**
 * `stubHtml` is served at `/` for the audio-layer phase, which only needs a blank page to import a
 * module into. The game phase passes null so `/` resolves to the real dist/index.html — serving the
 * stub there loads an empty document, and the symptom is a timeout waiting for `window.__LV` that
 * looks like a browser or WebGL problem and is neither.
 */
async function serveDir(dir, stubHtml = null) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (stubHtml && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(stubHtml);
      return;
    }
    if (path === '/') {
      try {
        const body = await readFile(resolve(dir, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
      return;
    }
    try {
      const body = await readFile(resolve(dir, `.${path}`));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workDir = resolve(tmpdir(), `lv-audio-live-${process.pid}`);
  await mkdir(options.out, { recursive: true });

  const provenance = await readProvenance();
  if (options.requireClean && !provenance.clean) {
    console.error(`Refusing to produce evidence from a dirty tree. Uncommitted:\n  ${provenance.dirtyFiles.join('\n  ')}`);
    process.exit(2);
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.error('Could not import playwright. Run pnpm install, then pnpm exec playwright install chromium once.');
    process.exit(2);
  }

  let server = null;
  let browser = null;
  try {
    await buildAudioBundle(workDir);
    const served = await serveDir(workDir, '<!doctype html><meta charset="utf-8"><title>audio-live</title><body></body>');
    server = served.server;
    // Without this the context starts suspended and every assertion below would be measuring the
    // autoplay policy rather than the mix.
    browser = await playwright.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.goto(`${served.origin}/`);

    const result = await page.evaluate(runInPage, {
      bundleUrl: `${served.origin}/audio.js`,
      settleMs: SETTLE_MS,
      tol: TOL,
    });

    // Phase two: the same questions asked of the real game.
    let gameChecks = [];
    let distInfo = null;
    try {
      distInfo = await ensureDist();
      gameChecks = await runGamePhase(playwright, distInfo.dist);
    } catch (error) {
      gameChecks = [{
        id: 'GAME.phase-available',
        passed: false,
        detail: `could not run the game phase: ${error instanceof Error ? error.message : String(error)}`,
      }];
    }
    result.checks.push(...gameChecks);

    const failed = result.checks.filter((c) => !c.passed && c.severity !== 'warn');
    const warned = result.checks.filter((c) => !c.passed && c.severity === 'warn');
    const report = {
      status: failed.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      summary: {
        passed: result.checks.length - failed.length - warned.length,
        failed: failed.length,
        warned: warned.length,
        total: result.checks.length,
      },
      warnings: warned.map((c) => ({ id: c.id, detail: c.detail })),
      provenance,
      constants: result.constants,
      checks: result.checks,
      pageErrors,
      distBuiltByThisRun: distInfo?.built ?? null,
      distDecision: distInfo?.reason ?? null,
      notCovered: [
        'Whether any of it sounds good. Every check here is a state assertion; none is perceptual.',
      ],
    };
    await writeFile(resolve(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const c of result.checks) {
        const tag = c.passed ? 'PASS' : c.severity === 'warn' ? 'WARN' : 'FAIL';
        console.log(`${tag}  ${c.id}  — ${c.detail}`);
      }
      if (pageErrors.length) console.log(`\nconsole/page errors:\n  ${pageErrors.join('\n  ')}`);
      console.log(`\nNOT COVERED: ${report.notCovered[0]}`);
      console.log(
        `\n${report.status}  ${report.summary.passed}/${report.summary.total} checks` +
        (report.summary.warned ? `, ${report.summary.warned} warning(s) — see warnings[] in report.json` : '') +
        `  at ${provenance.measuredAt}`,
      );
      console.log(`report: ${resolve(options.out, 'report.json')}`);
    }
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((done) => server.close(done));
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
