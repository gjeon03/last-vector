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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

async function serveDir(dir) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end('<!doctype html><meta charset="utf-8"><title>audio-live</title><body></body>');
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
    const served = await serveDir(workDir);
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

    const failed = result.checks.filter((c) => !c.passed);
    const report = {
      status: failed.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      summary: { passed: result.checks.length - failed.length, failed: failed.length, total: result.checks.length },
      provenance,
      constants: result.constants,
      checks: result.checks,
      pageErrors,
      notCovered: [
        'Game-level visibility wiring: that ctx.state is running after the tab is hidden and shown '
        + 'while paused. This suite constructs AudioEngine directly and cannot see Game.ts wiring; '
        + 'asserting it needs window.__LV to expose the audio bus.',
      ],
    };
    await writeFile(resolve(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const c of result.checks) console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.id}  — ${c.detail}`);
      if (pageErrors.length) console.log(`\nconsole/page errors:\n  ${pageErrors.join('\n  ')}`);
      console.log(`\nNOT COVERED: ${report.notCovered[0]}`);
      console.log(`\n${report.status}  ${report.summary.passed}/${report.summary.total} checks  at ${provenance.measuredAt}`);
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
