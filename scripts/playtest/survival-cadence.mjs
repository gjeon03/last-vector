import {
  callHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const RUN_MODE = 'meteor-survival';
const FIXED_STEP = 1 / 60;
const CADENCES = [30, 60, 120];
const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'phase',
  'telemetry',
  'survivalDebug',
  'setDriven',
  'step',
  'setSettings',
  'pauseMenu',
  'errors',
];

await runManagedSuite({
  suite: 'survival-cadence',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runSurvivalCadence,
});

async function runSurvivalCadence({ report, session, options }) {
  const page = session.page;
  const url = new URL(page.url());
  url.searchParams.set('mode', RUN_MODE);
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: options.timeoutMs });
  verify(response?.ok(), 'Survival-mode reload returned a non-success document.', {
    status: response?.status() ?? null,
    url: url.href,
  });
  await waitForHarness(page, options.timeoutMs);
  await callHarness(page, 'ready', [], options.timeoutMs);
  await page.setViewportSize({ width: 320, height: 180 });
  await callHarness(page, 'setSettings', [{
    quality: 'low',
    renderScale: 0.6,
    filmGrain: false,
    chromaticAberration: false,
    motionBlur: false,
  }]);
  await callHarness(page, 'setDriven', [true]);

  await report.check({
    id: 'SURVIVAL.fixed-step-boundaries',
    name: 'Partial survival time survives pause but not a new run',
    assertion:
      'A 120 Hz half-step does not advance simulation, paused frames add no catch-up debt, '
      + 'resuming completes exactly one 60 Hz step, and starting a new run discards a partial step.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'step', [1, 1 / 120], 120_000);
    const partial = await callHarness(page, 'survivalDebug');
    await callHarness(page, 'pauseMenu', [true]);
    await callHarness(page, 'step', [120, 1 / 120], 120_000);
    const paused = await callHarness(page, 'survivalDebug');
    await callHarness(page, 'pauseMenu', [false]);
    await callHarness(page, 'step', [1, 1 / 120], 120_000);
    const resumed = await callHarness(page, 'survivalDebug');

    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'step', [1, 1 / 120], 120_000);
    const resetPartial = await callHarness(page, 'survivalDebug');
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'step', [1, 1 / 120], 120_000);
    const afterReset = await callHarness(page, 'survivalDebug');
    await callHarness(page, 'step', [1, 1 / 120], 120_000);
    const resetCompleted = await callHarness(page, 'survivalDebug');

    const evidence = { partial, paused, resumed, resetPartial, afterReset, resetCompleted };
    verify(partial.elapsedSeconds === 0 && paused.elapsedSeconds === 0,
      'A partial or paused frame advanced survival.', evidence);
    verify(Math.abs(resumed.elapsedSeconds - FIXED_STEP) <= 1e-9,
      'Resume did not retain exactly the pre-pause partial step.', evidence);
    verify(resetPartial.elapsedSeconds === 0 && afterReset.elapsedSeconds === 0,
      'A new run inherited a partial simulation step.', evidence);
    verify(Math.abs(resetCompleted.elapsedSeconds - FIXED_STEP) <= 1e-9,
      'A clean pair of 120 Hz frames did not produce one fixed step.', evidence);
    return evidence;
  });

  await report.check({
    id: 'SURVIVAL.cadence-determinism',
    name: 'No-input survival outcome is deterministic at 30, 60 and 120 Hz',
    assertion:
      'The same seed and no-input run finishes at all three presentation cadences with terminal '
      + 'times within one 60 Hz step and byte-identical avoidance/contact statistics.',
  }, async () => {
    const runs = [];
    for (const hz of CADENCES) runs.push(await runToCompletion(page, hz, options.maxSimSeconds));

    for (const run of runs) {
      verify(run.phase === 'finished',
        `${run.hz} Hz did not finish within ${options.maxSimSeconds} simulated seconds.`, runs);
    }
    const elapsed = runs.map((run) => run.elapsedSeconds);
    const spread = Math.max(...elapsed) - Math.min(...elapsed);
    verify(spread <= FIXED_STEP + 1e-9,
      `Terminal survival times differ by ${spread}s, more than one fixed step.`, runs);
    const referenceStats = JSON.stringify(runs[0].stats);
    verify(runs.every((run) => JSON.stringify(run.stats) === referenceStats),
      'Terminal survival statistics vary by presentation cadence.', runs);
    return { fixedStepSeconds: FIXED_STEP, spreadSeconds: spread, runs };
  });

  await report.check({
    id: 'SURVIVAL.catch-up-cap',
    name: 'A long frame has bounded survival catch-up work',
    assertion:
      'One one-second driven frame cannot request an unbounded number of fixed simulation steps.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'step', [1, 1], 120_000);
    const evidence = await callHarness(page, 'survivalDebug');
    verify(evidence.elapsedSeconds > 0 && evidence.elapsedSeconds <= 0.2 + 1e-9,
      'The long frame was not capped at a bounded catch-up window.', evidence);
    return evidence;
  });
}

async function runToCompletion(page, hz, maxSimSeconds) {
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  const dt = 1 / hz;
  const chunkFrames = hz * 10;
  let submittedFrames = 0;
  let phase = await callHarness(page, 'phase');
  while (phase === 'flying' && submittedFrames < maxSimSeconds * hz) {
    const frames = Math.min(chunkFrames, maxSimSeconds * hz - submittedFrames);
    await callHarness(page, 'step', [frames, dt], 120_000);
    submittedFrames += frames;
    phase = await callHarness(page, 'phase');
  }
  const telemetry = await callHarness(page, 'telemetry');
  const debug = await callHarness(page, 'survivalDebug');
  return {
    hz,
    phase,
    elapsedSeconds: telemetry.elapsed,
    submittedSeconds: submittedFrames / hz,
    stats: {
      meteorsDodged: telemetry.survival?.meteorsDodged ?? null,
      nearMisses: telemetry.survival?.nearMisses ?? null,
      collisions: telemetry.survival?.collisions ?? null,
      peakActive: debug.peakActiveMeteors,
      totalSpawned: debug.totalSpawned,
      totalRecycled: debug.totalRecycled,
    },
  };
}
