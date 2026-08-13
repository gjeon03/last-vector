import {
  callHarness,
  criterion,
  finiteNumber,
  runManagedSuite,
  verify,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'phase',
  'setAutopilot',
  'step',
  'setDriven',
  'profile',
  'settings',
  'setSettings',
  'setFixedTimestep',
  'errors',
];

await runManagedSuite({
  suite: 'perf-probe',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runPerfProbe,
});

async function runPerfProbe({ report, session, options }) {
  const page = session.page;

  await report.check({
    id: 'API.ready',
    name: 'First rendered frame is ready',
    criteria: [],
    assertion: 'window.__LV.ready() resolves within the configured timeout.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    return { timeoutMs: options.timeoutMs };
  });

  const settingsOutcome = await report.check({
    id: 'PERF.settings',
    name: 'Performance quality settings are applied',
    criteria: [],
    assertion: `setSettings applies quality=${options.quality}, renderScale=1, and showFps=false before sampling.`,
  }, async () => {
    await callHarness(page, 'setSettings', [{ quality: options.quality, renderScale: 1, showFps: false }]);
    const settings = await callHarness(page, 'settings');
    const evidence = {
      requested: { quality: options.quality, renderScale: 1, showFps: false },
      actual: settings,
    };
    verify(settings?.quality === options.quality, 'Quality setting did not apply.', evidence);
    verify(settings?.renderScale === 1, 'Render scale setting did not apply.', evidence);
    verify(settings?.showFps === false, 'FPS overlay setting did not apply.', evidence);
    return evidence;
  });

  const profileOutcome = await capture(async () => collectProfile(page, options));

  await report.check({
    id: 'PERF.sample-shape',
    name: 'Profile sample is internally consistent',
    criteria: [],
    assertion: 'Profile returns positive frames/seconds, finite non-negative timings and renderer counts, ordered p50 <= p95 <= p99 <= max, FPS consistent with frames/seconds, and a valid effective render scale/buffer.',
  }, async () => {
    const evidence = unwrap(profileOutcome);
    const sample = evidence.sample;
    const timingKeys = ['meanFrameMs', 'p50FrameMs', 'p95FrameMs', 'p99FrameMs', 'maxFrameMs'];
    const countKeys = ['frames', 'longFrames', 'drawCalls', 'triangles', 'programs', 'geometries', 'textures'];
    verify(finiteNumber(sample?.seconds) && sample.seconds > 0, 'Profile seconds is not positive and finite.', evidence);
    verify(finiteNumber(sample?.fps) && sample.fps > 0, 'Profile FPS is not positive and finite.', evidence);
    verify(timingKeys.every((key) => finiteNumber(sample?.[key]) && sample[key] >= 0), 'Profile has an invalid frame-time value.', evidence);
    verify(countKeys.every((key) => Number.isInteger(sample?.[key]) && sample[key] >= 0), 'Profile has an invalid count.', evidence);
    verify(finiteNumber(sample?.renderScale) && sample.renderScale > 0 && sample.renderScale <= 1, 'Profile has an invalid effective render scale.', evidence);
    verify(Number.isInteger(sample?.drawingBufferWidth) && sample.drawingBufferWidth > 0 && Number.isInteger(sample?.drawingBufferHeight) && sample.drawingBufferHeight > 0, 'Profile has an invalid drawing-buffer size.', evidence);
    verify(Math.abs(sample.drawingBufferWidth - Math.round(evidence.viewport.width * sample.renderScale)) <= 1 && Math.abs(sample.drawingBufferHeight - Math.round(evidence.viewport.height * sample.renderScale)) <= 1, 'Drawing-buffer size is inconsistent with viewport and effective render scale.', evidence);
    verify(sample.p50FrameMs <= sample.p95FrameMs && sample.p95FrameMs <= sample.p99FrameMs && sample.p99FrameMs <= sample.maxFrameMs, 'Profile percentiles are not ordered.', evidence);
    const calculatedFps = sample.frames / sample.seconds;
    verify(Math.abs(calculatedFps - sample.fps) <= Math.max(1, sample.fps * 0.05), 'FPS is inconsistent with frames / seconds.', {
      ...evidence,
      calculatedFps,
    });
    return { ...evidence, calculatedFps };
  });

  await report.check({
    id: 'M5.performance-1080p',
    name: 'Game sustains 60 FPS at 1920x1080',
    criteria: [criterion('M5', 'full', 'Combines this 1080p FPS threshold with M5.runtime-errors in the same run.')],
    assertion: `At a 1920x1080 CSS-pixel viewport and deviceScaleFactor 1, __LV.profile(${options.profileSeconds}) reports fps >= 60.`,
  }, async () => {
    const evidence = unwrap(profileOutcome);
    verify(settingsOutcome.ok, 'Requested performance quality settings were not confirmed; see PERF.settings.', settingsOutcome.error);
    verify(evidence.viewport.width === 1920 && evidence.viewport.height === 1080 && evidence.deviceScaleFactor === 1, 'Performance probe did not run at the mandatory 1920x1080 resolution.', evidence);
    verify(evidence.sample.fps >= 60, `Measured FPS ${evidence.sample.fps} is below 60.`, evidence);
    return evidence;
  });
}

async function collectProfile(page, options) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);

  try {
    await stepUntilFlying(page, options.timeoutMs);
    await callHarness(page, 'step', [120], options.timeoutMs);
    const profileTimeoutMs = Math.max(options.timeoutMs, (options.profileSeconds + 5) * 1_000);
    const sample = await callHarness(page, 'profile', [options.profileSeconds], profileTimeoutMs);
    return {
      seed: options.seed,
      warmupFrames: 120,
      fixedTimestep: 1 / 60,
      viewport: options.viewport,
      deviceScaleFactor: 1,
      quality: options.quality,
      requestedProfileSeconds: options.profileSeconds,
      sample,
    };
  } finally {
    await bestEffort(page, 'setAutopilot', [false]);
    await bestEffort(page, 'setDriven', [false]);
  }
}

async function stepUntilFlying(page, timeoutMs) {
  let simulatedFrames = 0;
  while (simulatedFrames <= 600) {
    const phase = await callHarness(page, 'phase');
    if (phase === 'flying') return;
    if (phase === 'finished') throw new Error('Run finished before the performance probe reached flying.');
    await callHarness(page, 'step', [30], timeoutMs);
    simulatedFrames += 30;
  }
  throw new Error('Run did not reach flying within 10 simulated seconds.');
}

async function bestEffort(page, method, args) {
  try {
    await callHarness(page, method, args);
  } catch {
    // The originating check records the actionable failure.
  }
}

async function capture(operation) {
  try {
    return { ok: true, value: await operation(), error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

function unwrap(outcome) {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}
