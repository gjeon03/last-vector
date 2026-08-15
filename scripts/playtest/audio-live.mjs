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
// Only REPO_ROOT. This suite never calls parseOptions or runManagedSuite, so runtime.mjs's
// `--dist` guard at :465 never runs on its behalf. It is protected structurally — there is no
// option to point it at another tree — not by that guard. Anyone adding a --dist here inherits
// nothing.
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

/**
 * Idle time on the title screen before judging pre-gesture silence. The defect this guards fired
 * on attract-autopilot boost ignition, so the window has to span several ignitions — a short idle
 * could land between two and pass on timing rather than on correctness.
 */
const TITLE_IDLE_MS = 15000;

/* eslint-disable */
async function runInPage(config) {
  const { bundleUrl, settleMs, tol } = config;
  const mod = await import(bundleUrl);
  const { AudioEngine, MENU_DUCK_DEPTH, MENU_MUSIC_DEPTH, UI_DUCK_DEPTH } = mod;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const near = (a, b) => Math.abs(a - b) <= tol;
  const add = (id, passed, detail) => checks.push({ id, passed, detail });

  // --- silence before the first gesture -------------------------------------------------------
  // Runs FIRST, on its own engine, because the measurement is a count of source `.start()` calls
  // across the page and a second engine already running would make the count unattributable.
  //
  // Not a peak measurement, deliberately. Nothing in production exposes the output — there is no
  // analyser anywhere in `src/` — so a dBFS reading would mean adding a permanent node to the mix
  // to serve a test. What actually makes sound is a source being started, so that is what this
  // counts. It is a stricter reading than silence: a started source into a suspended context is
  // inaudible today and audible the moment anything resumes the context.
  //
  // `prewarm()` is the path that builds without unlocking. The suite launches with
  // `--autoplay-policy=no-user-gesture-required`, so a fresh context here starts `running` — this
  // is the environment where the guard is load-bearing rather than decorative.
  const started = [];
  const patched = [];
  for (const name of ['AudioBufferSourceNode', 'OscillatorNode', 'ConstantSourceNode']) {
    const Ctor = globalThis[name];
    if (!Ctor || typeof Ctor.prototype.start !== 'function') continue;
    const original = Ctor.prototype.start;
    patched.push({ Ctor, original });
    Ctor.prototype.start = function instrumented(...args) {
      started.push(name);
      return original.apply(this, args);
    };
  }

  const quiet = new AudioEngine({ seed: 13 });
  await quiet.prewarm();
  // Poll rather than sleep: `suspend()` is async, and a fixed wait either flakes or hides a
  // regression behind its own slack. A mutation that never suspends burns the full budget and
  // then reports what it actually saw.
  const quietReach = async (want, ms = 1000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (quiet.debugMixState()?.contextState === want) return true;
      await wait(25);
    }
    return false;
  };
  const settledSuspended = await quietReach('suspended');
  const stateBefore = quiet.debugMixState()?.contextState ?? 'NO GRAPH';
  const startsBefore = started.length;
  const unlockedBefore = quiet.unlocked;

  await quiet.unlock();
  const settledRunning = await quietReach('running');
  const stateAfter = quiet.debugMixState()?.contextState ?? 'NO GRAPH';
  const startsAfter = started.length;
  const unlockedAfter = quiet.unlocked;

  for (const { Ctor, original } of patched) Ctor.prototype.start = original;
  quiet.dispose();

  add(
    // Verified by ab-mutations P9a at 76fe8c1: deleting the build() guard that re-suspends a context
    // the browser handed us already running makes this check fail, while LIVE.first-gesture-starts-audio
    // and LIVE.suspend-then-resume stay green.
    // Verified by ab-mutations P9b at 76fe8c1: deleting the deferral of engine.start()/music.start()
    // out of build() and into unlock() makes this check fail, while LIVE.first-gesture-starts-audio
    // and LIVE.context-running stay green.
    'LIVE.silent-until-first-gesture',
    settledSuspended && startsBefore === 0 && unlockedBefore === false,
    `after prewarm() with autoplay permitted: ctx ${stateBefore} (want suspended), ` +
      `${startsBefore} source .start() calls (want 0), unlocked ${unlockedBefore} (want false). ` +
      'Both halves matter: the context guard and the deferred source start each keep this true ' +
      'alone, so each is asserted separately or one can rot while the other carries the check',
  );
  // Absolute count, not `startsAfter > startsBefore`. The delta form coupled this check to the one
  // above: a regression that starts the sources in build() makes the gesture start nothing, so the
  // delta is zero and BOTH checks red. Two reds for one defect reads as two defects, and it left
  // the silence check with no mutation that reds it alone — ab-mutations P9b called this out.
  //
  // What is given up is real and small: this no longer asserts on its own that the GESTURE is what
  // started the sources. The pair still asserts it — zero before and non-zero after can only mean
  // the gesture — but no single check does. The job here is narrower: prove the engine makes sound
  // at all, so the silence check above cannot be satisfied by a dead engine.
  add(
    'LIVE.first-gesture-starts-audio',
    settledRunning && startsAfter > 0 && unlockedAfter === true,
    `after unlock(): ctx ${stateAfter} (want running), ${startsAfter} sources started in total ` +
      `(want > 0), ${startsAfter - startsBefore} of them by the gesture, unlocked ` +
      `${unlockedAfter} (want true)`,
  );

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
  const reach = async (want, ms = 1500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (state().contextState === want) return true;
      await wait(25);
    }
    return false;
  };
  engine.suspend();
  const didSuspend = await reach('suspended');
  engine.resume();
  const didResume = await reach('running');
  add(
    // Verified by ab-mutations P3 at 8e8291d: deleting AudioEngine.suspend() makes this check fail,
    // while GAME.score-slider-reaches-the-mix and LIVE.production-reclaims-nodes stay green.
    'LIVE.suspend-then-resume',
    didSuspend && didResume,
    `suspend -> ${didSuspend ? 'suspended' : 'NEVER suspended'}, resume -> ` +
      `${didResume ? 'running' : 'NEVER resumed'} (both halves asserted: the previous version ` +
      'checked only the second, so a no-op suspend() passed)',
  );

  // Resuming a context that was never suspended must be a harmless no-op, not an error.
  engine.resume();
  await wait(120);
  add('LIVE.redundant-resume', state().contextState === 'running', `ctx.state = ${state().contextState}`);

  // --- the Score slider must reach every path the score travels ---------------------------------
  // The offline probe proves the graph CAN be silenced; this proves the shipped method drives both
  // nodes. Splitting it that way matters: the round-5 fix made the graph duckable and left
  // `setMusicVolume` touching only the dry path, so a graph-only assertion would still have passed.
  engine.setMusicVolume(0);
  await wait(400);
  const volZero = state();
  add(
    'LIVE.music-volume-zero-reaches-both-paths',
    near(volZero.musicVolume, 0) && near(volZero.musicSendVolume, 0),
    `musicVolume ${volZero.musicVolume.toFixed(3)}, musicSendVolume ${volZero.musicSendVolume.toFixed(3)} after ` +
      `setMusicVolume(0) — both must reach 0, or the slider silences the pad and leaves its reverb`,
  );
  engine.setMusicVolume(0.65);
  await wait(400);
  const volBack = state();
  add(
    'LIVE.music-volume-tracks-both-paths',
    near(volBack.musicVolume, 0.65) && near(volBack.musicSendVolume, 0.65),
    `musicVolume ${volBack.musicVolume.toFixed(3)}, musicSendVolume ${volBack.musicSendVolume.toFixed(3)} after setMusicVolume(0.65)`,
  );

  // --- static menu trim -------------------------------------------------------------------------
  engine.menuMix(true);
  await wait(settleMs);
  let s = state();
  add(
    'LIVE.menu-duck-applied',
    near(s.engineDuck, MENU_DUCK_DEPTH) && near(s.musicDuck, MENU_MUSIC_DEPTH),
    `engineDuck ${s.engineDuck.toFixed(3)} (want ${MENU_DUCK_DEPTH}), musicDuck ${s.musicDuck.toFixed(3)} (want ${MENU_MUSIC_DEPTH})`,
  );

  // The score reaches the mix by two paths and one of them bypasses `musicDuck`. Ducking only the
  // bus left ~93% of the pad's power at full level for the entire life of the project, audible as
  // its reverb tail. Assert the send trim tracks the bus so a future third path cannot quietly
  // reintroduce the same gap.
  add(
    'LIVE.music-send-trim-tracks-duck',
    near(s.musicSendTrim, s.musicDuck),
    `musicSendTrim ${s.musicSendTrim.toFixed(3)} vs musicDuck ${s.musicDuck.toFixed(3)} — the ` +
      `reverb-send path must be ducked in step with the dry path or the duck only reaches the pad`,
  );

  // --- the regression: a transient duck must not cancel the static trim -----------------------
  engine.play('uiClick', 0.5);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.menu-floor-survives-a-ui-click',
    near(s.engineDuck, MENU_DUCK_DEPTH),
    `engineDuck ${s.engineDuck.toFixed(3)} after a UI click in a menu (want ${MENU_DUCK_DEPTH}; ` +
      `1.000 means the click released to unity and un-ducked the drive for the rest of the menu)`,
  );

  engine.play('finish', 1);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.menu-floor-survives-a-ducking-cue',
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

  // The RESUME button, reproduced exactly: a UI confirmation and the menu closing on the SAME
  // tick. The check above could never catch this — it waits 900 ms between the click and the
  // release, by which time the transient duck has finished and there is nothing pending to
  // outrank the state change. The defect only exists inside the ~160 ms window where the click's
  // scheduled release is still in the future, which is precisely when a player clicks RESUME.
  engine.menuMix(true);
  await wait(settleMs);
  engine.play('uiClick', 0.5);
  engine.menuMix(false);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.menu-release-same-tick-as-click',
    near(s.engineDuck, 1) && near(s.musicDuck, 1),
    `engineDuck ${s.engineDuck.toFixed(3)}, musicDuck ${s.musicDuck.toFixed(3)} after a click and ` +
      `menuMix(false) in the same tick (both want 1; the menu floor means the click's pending ` +
      `release outranked the state change and the drive never came back)`,
  );

  // And the mirror: the menu opening on the same tick as a click, which is the PAUSE button.
  engine.play('uiClick', 0.5);
  engine.menuMix(true);
  await wait(settleMs);
  s = state();
  add(
    'LIVE.menu-apply-same-tick-as-click',
    near(s.engineDuck, MENU_DUCK_DEPTH) && near(s.musicDuck, MENU_MUSIC_DEPTH),
    `engineDuck ${s.engineDuck.toFixed(3)}, musicDuck ${s.musicDuck.toFixed(3)} after a click and ` +
      `menuMix(true) in the same tick (want ${MENU_DUCK_DEPTH} / ${MENU_MUSIC_DEPTH})`,
  );
  engine.menuMix(false);
  await wait(settleMs);

  // --- a duck during flight still returns to unity ---------------------------------------------
  engine.play('uiClick', 0.5);
  await wait(settleMs);
  s = state();
  // Minimum over a window rather than a sample at a chosen instant. The value sits inside the
  // assertion's tolerance from 38.1 ms to 164.3 ms — 126.1 ms wide, derived from the attack tau
  // 0.012, the release start at 0.16, and TOL — so ~12 polls land inside it and host load would
  // have to stretch the interval tenfold before none did. A point sample would need a defensible
  // instant; an extremum needs only that the window contains the event.
  const duckFloor = async (event, ms = 400) => {
    engine.play(event, 0.5);
    let lowestEngine = Infinity;
    let lowestMusic = Infinity;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const now = state();
      lowestEngine = Math.min(lowestEngine, now.engineDuck);
      lowestMusic = Math.min(lowestMusic, now.musicDuck);
      await wait(10);
    }
    return { lowestEngine, lowestMusic };
  };

  engine.menuMix(false);
  await wait(settleMs);
  const uiDuck = await duckFloor('uiClick');
  await wait(settleMs);
  add(
    // Verified by ab-mutations P7 at 8e8291d: deleting duckEngine() makes this check fail, while
    // LIVE.menu-duck-applied and LIVE.menu-floor-survives-a-ui-click stay green.
    'LIVE.ui-duck-fires-and-releases',
    uiDuck.lowestEngine <= UI_DUCK_DEPTH + tol && near(state().engineDuck, 1),
    `engineDuck fell to ${uiDuck.lowestEngine.toFixed(3)} (want <= ${UI_DUCK_DEPTH + tol}) and ` +
      `returned to ${state().engineDuck.toFixed(3)} (want 1)`,
  );

  const evDuck = await duckFloor('finish');
  await wait(settleMs);
  add(
    // Verified by ab-mutations P8 at 8e8291d: deleting duck() makes this check fail, while
    // LIVE.menu-duck-applied stays green.
    'LIVE.event-duck-fires-and-releases',
    evDuck.lowestMusic <= 0.7 + tol && near(state().musicDuck, 1),
    `musicDuck fell to ${evDuck.lowestMusic.toFixed(3)} (want <= ${0.7 + tol}) and returned to ` +
      `${state().musicDuck.toFixed(3)} (want 1)`,
  );

  // --- production reclaims its own nodes ---------------------------------------------------------
  // No harness sweep anywhere in this block: only AudioEngine's own ticker runs. Every ledger.sweep
  // in audio-probe is called by the harness, so nothing anywhere tested that production reclaims.
  // Measured against the PERMANENT count, not against a starting reading. The first version
  // compared to `debugNodeCount()` sampled immediately after the duck tests, which still had
  // voices in flight — so the baseline was inflated and "returned to where it started" was the
  // wrong question. Quiescent means equal to the permanent graph, and that is a fixed reference.
  const permanent = engine.debugPermanentNodeCount();
  for (let i = 0; i < 40; i++) engine.play('uiClick', 0.5);
  const nodesPeak = engine.debugNodeCount();
  await wait(4000);
  const nodesAfter = engine.debugNodeCount();
  add(
    // Verified by ab-mutations P5 at 8e8291d: deleting the production ticker's ledger sweep
    // (AudioEngine.ts:496) makes this check fail, while LIVE.suspend-then-resume and
    // GAME.score-slider-reaches-the-mix stay green.
    'LIVE.production-reclaims-nodes',
    nodesPeak > permanent && nodesAfter === permanent,
    `permanent ${permanent}, peak ${nodesPeak} after 40 cues, ${nodesAfter} after 4 s with only ` +
      'the engine\'s own ticker running (no harness sweep in this block)',
  );

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
  const options = { out: resolve(REPO_ROOT, 'playtest-out/audio-live'), json: false, requireClean: false, noGame: false, artifactLocked: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = resolve(REPO_ROOT, argv[++i] ?? '.');
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--require-clean') options.requireClean = true;
    // Audio-layer phase only. The game phase rebuilds dist/ when sources are newer, which is
    // wrong to do while someone else has an in-progress edit in src/ — you would be building and
    // testing their half-finished work and attributing the result to yours.
    else if (argv[i] === '--no-game') options.noGame = true;
    // Refuse to regenerate dist/. For runs that happen while somebody else is reading the
    // artefact — a review round, a panel wave — a suite that rebuilds it mid-read can hand a
    // reviewer a torn asset, and the symptom is a failed run they will attribute to the product.
    // I did exactly that during round 5. Locked runs fail loudly instead, before touching anything.
    else if (argv[i] === '--artifact-locked') options.artifactLocked = true;
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
  // Scoped to the paths this suite's evidence actually depends on.
  //
  // Unscoped, `--require-clean` was a shared tripwire: ANY uncommitted file anywhere in the repo,
  // by any author — a docs edit, a UI file, another agent mid-change — turned both audio suites
  // into exit-2 infrastructure errors for every reviewer running the full suite at once. And it
  // presents as "the audio gate is broken" rather than as "somebody has an uncommitted file",
  // with only the exit code separating those readings.
  //
  // The property the flag exists for is "these numbers describe a commit". That is preserved by
  // watching what the numbers are made of; watching the whole tree adds "and nobody else is
  // working", which was never intended and is false by construction on a shared repo.
  // What this suite's numbers are made of. The audio-layer phase builds src/audio alone; the
  // game phase builds dist, and its provenance is recorded separately as distDecision and
  // distBuiltByThisRun rather than by refusing to run.
  const RELEVANT = ['src/audio/', 'src/core/', 'src/game/', 'scripts/playtest/audio-live.mjs'];
  const status = await git(['status', '--porcelain'], true);
  const allDirty = status ? status.split('\n').filter(Boolean).map((l) => l.slice(3)) : [];
  const dirtyFiles = allDirty.filter((f) => RELEVANT.some((r) => f.startsWith(r)));
  return {
    commit,
    clean: dirtyFiles.length === 0,
    dirtyOutsideScope: allDirty.filter((f) => !dirtyFiles.includes(f)),
    dirtyFiles,
    measuredAt: commit ? `${commit.slice(0, 7)}${dirtyFiles.length === 0 ? '' : ' (DIRTY TREE)'}` : 'unknown',
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
class ArtifactLockedError extends Error {}

async function ensureDist(locked = false) {
  const { stat, readdir } = await import('node:fs/promises');
  const dist = resolve(REPO_ROOT, 'dist');
  const rebuild = async (reason) => {
    if (locked) throw new ArtifactLockedError(reason);
    const { build } = await import('vite');
    await build({ root: REPO_ROOT, cacheDir: '.vite-cache', logLevel: 'silent' });
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
    // See audio-probe: the worktree's node_modules is a symlink and vite writes into it.
    cacheDir: '.vite-cache',
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

    // The player's route is slider -> settings -> Game.onSettingsChanged -> setMusicVolume. The
    // LIVE pair tests the method; nothing tested the hop into it, so disconnecting the Score slider
    // from the engine entirely would leave every other check in both suites green.
    //
    // Two positions, because a stub hardcoding setMusicVolume(0) satisfies the zero half alone.
    await page.evaluate(() => window.__LV.setSettings({ musicVolume: 0 }));
    await page.waitForTimeout(400);
    const volOff = await page.evaluate(() => window.__LV.audioState());
    await page.evaluate(() => window.__LV.setSettings({ musicVolume: 0.3 }));
    await page.waitForTimeout(400);
    const volPart = await page.evaluate(() => window.__LV.audioState());
    await page.evaluate(() => window.__LV.setSettings({ musicVolume: 0.65 }));
    add(
      // Verified by ab-mutations P0 at 8e8291d: deleting the settings->engine call at Game.ts:1404,
      // leaving setMusicVolume itself intact, makes this check fail, while
      // LIVE.music-volume-zero-reaches-both-paths and LIVE.music-volume-tracks-both-paths stay green.
      'GAME.score-slider-reaches-the-mix',
      volOff !== null && volPart !== null
        && Math.abs(volOff.musicVolume) <= TOL && Math.abs(volOff.musicSendVolume) <= TOL
        && Math.abs(volPart.musicVolume - 0.3) <= TOL && Math.abs(volPart.musicSendVolume - 0.3) <= TOL,
      `setSettings musicVolume 0 -> ${volOff?.musicVolume}/${volOff?.musicSendVolume}, `
        + `0.3 -> ${volPart?.musicVolume}/${volPart?.musicSendVolume} (dry/send; both paths must follow)`,
    );

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
          `mix state as a real ESC. Both are asserted against the same expected values above; the ` +
          `two readings are not compared to each other`,
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
    // Verified by ab-mutations P4 at 8e8291d: deleting the game's suspend-on-hidden call site,
    // leaving AudioEngine.suspend() intact, makes this check fail, while LIVE.suspend-then-resume
    // stays green.
    add('GAME.visibility-roundtrip-while-paused',
      hiddenState?.contextState === 'suspended' && st !== null && st.contextState === 'running',
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

/**
 * Nothing may be scheduled into the context before the player has touched anything.
 *
 * `LIVE.silent-until-first-gesture` asserts a NEARBY BUT WEAKER property: that an `AudioEngine`
 * constructed directly starts no sources of its own. That is true and was true throughout the
 * defect this phase exists for — 27 voices queued on the title screen with no input, because the
 * attract autopilot boosts, `play()` had no `unlockedFlag` guard, and a suspended context's clock
 * is frozen, so every `.start(when)` landed in the past and they all fired together on the first
 * click. The engine started nothing on its own; the GAME started 27 things through it.
 *
 * So the predicate here is not "how many sources started" but "what was the context's state when
 * each one did". Starts after the gesture are the point of the program; starts into a frozen clock
 * are the bug.
 *
 * Two environmental requirements, both load-bearing:
 *
 * - DEFAULT autoplay policy. The other checks in this file deliberately pass
 *   `--autoplay-policy=no-user-gesture-required`, because that is the setting under which the
 *   `build()` suspend guard is load-bearing rather than decorative. This phase must instead see
 *   what a player sees. Different environment, different property: folding the two into one launch
 *   would leave neither honest.
 * - The prototype patch is installed via `addInitScript`, so it is in place before `main.ts` runs.
 *   Patched after boot, `prewarm()` and the whole attract sequence have already happened and the
 *   check would pass by arriving late — the vacuous pass this suite has been caught by before.
 */
async function runTitleSilencePhase(playwright, distDir) {
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed, detail });
  const served = await serveDir(distDir);
  // Same GPU flags as the phase above, deliberately WITHOUT the autoplay override.
  const browser = await playwright.chromium.launch({
    args: [
      ...(process.platform === 'darwin'
        ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
        : []),
    ],
  });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.addInitScript(() => {
      window.__lvStarts = [];
      for (const name of ['AudioBufferSourceNode', 'OscillatorNode', 'ConstantSourceNode']) {
        const Ctor = window[name];
        if (!Ctor || typeof Ctor.prototype.start !== 'function') continue;
        const original = Ctor.prototype.start;
        Ctor.prototype.start = function instrumented(...args) {
          try {
            window.__lvStarts.push({
              name,
              state: this.context.state,
              when: typeof args[0] === 'number' ? args[0] : null,
              now: this.context.currentTime,
            });
          } catch { /* never let instrumentation break the run it is measuring */ }
          return original.apply(this, args);
        };
      }
    });
    await page.goto(`${served.origin}/`, { waitUntil: 'load' });
    const booted = await page
      .waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (!booted) {
      add('GAME.silent-on-title-until-gesture', false,
        `window.__LV never appeared within 45 s; served from ${distDir}. ` +
        (errors.length ? `page errors: ${errors.slice(0, 3).join(' ; ')}` : 'no page errors'));
      return checks;
    }
    await page.evaluate(() => window.__LV.ready());

    // Sit on the title with ZERO input. Long enough to clear several attract boost cycles: the
    // defect fired on autopilot ignition, so a short idle could miss it by landing between two.
    await page.waitForTimeout(TITLE_IDLE_MS);

    const beforeGesture = await page.evaluate(() => window.__lvStarts.slice());
    const suspendedStarts = beforeGesture.filter((s) => s.state === 'suspended');

    // The gesture, then a moment for the resumed graph to schedule.
    await page.mouse.click(400, 400);
    await page.waitForTimeout(1200);
    const afterGesture = await page.evaluate(() => window.__lvStarts.slice());
    const runningStarts = afterGesture.filter((s) => s.state === 'running');

    const sample = suspendedStarts.slice(0, 3)
      .map((s) => `${s.name} when=${s.when} now=${s.now}`)
      .join(' | ');
    add(
      // Verified by ab-mutations P10a at 9b9129d: deleting the unlockedFlag guard on play(), the sfx
      // entry point makes this check fail, while GAME.title-gesture-starts-audio and
      // LIVE.silent-until-first-gesture stay green.
      // Verified by ab-mutations P10b at 9b9129d: deleting the unlockedFlag guard on update(), the
      // engine-layer entry point makes this check fail, while GAME.title-gesture-starts-audio and
      // LIVE.silent-until-first-gesture stay green.
      // The pair matters more than either line: it proves this check distinguishes the two entry
      // points, so neither guard can be deleted as redundant with the gate still green.
      'GAME.silent-on-title-until-gesture',
      suspendedStarts.length === 0,
      `${TITLE_IDLE_MS} ms idle on the title under the default autoplay policy: ` +
        `${beforeGesture.length} source starts, ${suspendedStarts.length} of them into a SUSPENDED ` +
        `context (want 0)${sample ? `. First offenders: ${sample} — note when <= now, so these fire ` +
        'the instant anything resumes the context' : ''}`,
    );
    // Absolute count, for the reason ab-mutations P9b established: a delta would couple this to the
    // check above, and one defect showing as two failures reads as two defects.
    add(
      'GAME.title-gesture-starts-audio',
      runningStarts.length > 0,
      `after one click: ${runningStarts.length} sources started with the context RUNNING (want > 0). ` +
        'Without this, a game that never makes any sound satisfies the check above',
    );
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => served.server.close(r));
  }
  return checks;
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
    if (options.noGame) {
      gameChecks = [];
    } else try {
      distInfo = await ensureDist(options.artifactLocked);
      gameChecks = await runGamePhase(playwright, distInfo.dist);
      // Separate launch: this one must run under the default autoplay policy, and the phase above
      // must not. Same dist, so no extra build.
      gameChecks = gameChecks.concat(await runTitleSilencePhase(playwright, distInfo.dist));
    } catch (error) {
      if (error instanceof ArtifactLockedError) {
        console.error(
          `Refusing to rebuild dist/ under --artifact-locked: ${error.message}.\n` +
          `Build it once before the round, verify the served hash, then lock. Rebuilding now would ` +
          `regenerate the artefact anyone currently reading it was handed.`,
        );
        process.exitCode = 2;
        return;
      }
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
      artifactLocked: options.artifactLocked,
      distBuiltByThisRun: distInfo?.built ?? null,
      distDecision: distInfo?.reason ?? null,
      notCovered: [
        'Whether any of it sounds good. Every check here is a state assertion; none is perceptual.',
        ...(options.noGame ? ['Game phase skipped via --no-game: nothing here exercises Game.ts wiring.'] : []),
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
