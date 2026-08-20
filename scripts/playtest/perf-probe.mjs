import { loadavg, cpus } from 'node:os';
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
  'cameraMode',
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
    assertion: `setSettings applies quality=${options.quality}, renderScale=1, showFps=false, and the cockpit camera before sampling.`,
  }, async () => {
    await callHarness(page, 'setSettings', [{
      quality: options.quality,
      renderScale: 1,
      showFps: false,
      cameraMode: 'cockpit',
    }]);
    const settings = await callHarness(page, 'settings');
    const evidence = {
      requested: { quality: options.quality, renderScale: 1, showFps: false, cameraMode: 'cockpit' },
      actual: settings,
    };
    verify(settings?.quality === options.quality, 'Quality setting did not apply.', evidence);
    verify(settings?.renderScale === 1, 'Render scale setting did not apply.', evidence);
    verify(settings?.showFps === false, 'FPS overlay setting did not apply.', evidence);
    verify(settings?.cameraMode === 'cockpit', 'Cockpit camera setting did not apply.', evidence);
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
    // The rendered sub-rectangle is a fraction of the ALLOCATION, and the allocation is capped by
    // a fill budget (FILL_BUDGET_PIXELS) rather than by the device ratio — so `viewport x
    // renderScale` is only the right expectation at a device scale factor of 1 on a window under
    // the budget. Checked against the allocation the game reports instead, plus the budget itself.
    const allocW = Math.round(sample.drawingBufferWidth / sample.renderScale);
    const allocH = Math.round(sample.drawingBufferHeight / sample.renderScale);
    const aspect = allocW / allocH;
    const viewportAspect = evidence.viewport.width / evidence.viewport.height;
    verify(
      Math.abs(aspect - viewportAspect) < 0.02,
      'Drawing-buffer aspect does not match the viewport aspect.',
      { ...evidence, allocW, allocH, aspect, viewportAspect },
    );
    verify(
      allocW * allocH <= 2_600_000,
      `Allocation ${allocW}x${allocH} = ${(allocW * allocH / 1e6).toFixed(2)} Mpx exceeds the fill budget.`,
      { ...evidence, allocW, allocH },
    );
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
    name: 'Game holds the 60 Hz frame budget at 1920x1080',
    criteria: [criterion('M5', 'full', 'Combines this 1080p FPS threshold with M5.runtime-errors in the same run.')],
    assertion:
      `At a 1920x1080 CSS-pixel viewport and deviceScaleFactor ${options.deviceScaleFactor}, ` +
      `the applied cockpit camera and its live MFD sustain the ` +
      '60 Hz budget: mean frame time <= 16.9 ms, p95 <= 20 ms, no frame over 33 ms, and the adaptive ' +
      'renderer did not buy that budget by collapsing internal resolution (renderScale >= 0.58, the adaptive controller own floor).',
  }, async () => {
    const evidence = unwrap(profileOutcome);
    verify(settingsOutcome.ok, 'Requested performance quality settings were not confirmed; see PERF.settings.', settingsOutcome.error);
    // The device scale factor is CONFIGURED, not asserted at 1. Hard-asserting 1 made this gate
    // structurally incapable of ever seeing the configuration the game ships in: `min(dpr, 2)`
    // meant a 1920x1080 window on a Retina or 4K panel allocated 3840x2160, four times what every
    // measurement in four review rounds was taken at. Measured before the fill budget landed:
    // 55.4 fps with 36 long frames and the scaler already down at 0.76.
    verify(
      evidence.viewport.width === 1920 && evidence.viewport.height === 1080
        && evidence.deviceScaleFactor === options.deviceScaleFactor,
      'Performance probe did not run at the requested resolution and device scale factor.',
      evidence,
    );
    verify(evidence.cameraMode === 'cockpit',
      `Performance probe sampled ${evidence.cameraMode} instead of the cockpit camera.`, evidence);

    // NOT `fps >= 60`. The compositor caps presentation at the display refresh, and the sample
    // window is wall-clock, so a perfectly vsynced run measures 59.99 and a strict >= 60 can
    // never pass. Frame time is the quantity that actually describes smoothness, and the
    // render scale is what stops the adaptive renderer from cheating its way to a green light.
    const s = evidence.sample;
    verify(s.meanFrameMs <= 16.9, `Mean frame time ${s.meanFrameMs.toFixed(2)} ms exceeds the 16.9 ms budget.`, evidence);
    verify(s.p95FrameMs <= 20, `p95 frame time ${s.p95FrameMs.toFixed(2)} ms exceeds 20 ms.`, evidence);
    verify(s.maxFrameMs <= 33, `Worst frame ${s.maxFrameMs.toFixed(2)} ms exceeds 33 ms.`, evidence);
    verify(
      s.renderScale >= 0.58,
      `Adaptive resolution collapsed to ${s.renderScale.toFixed(2)}; the frame budget was met only by dropping internal resolution.`,
      evidence,
    );
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
    const cameraMode = await callHarness(page, 'cameraMode');
    const profileTimeoutMs = Math.max(options.timeoutMs, (options.profileSeconds + 5) * 1_000);
    const sample = await callHarness(page, 'profile', [options.profileSeconds], profileTimeoutMs);
    return {
      seed: options.seed,
      warmupFrames: 120,
      fixedTimestep: 1 / 60,
      viewport: options.viewport,
      deviceScaleFactor: options.deviceScaleFactor,
      cameraMode,
      // Recorded, not asserted. Two of round 2's performance blockers were measured at load
      // average 19-36 and one verifier's magnitudes at 91-260; without this number in the
      // evidence, a failure cannot be told apart from a busy machine.
      hostLoad: loadavg().map((v) => Math.round(v * 100) / 100),
      hostCpus: cpus().length,
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
