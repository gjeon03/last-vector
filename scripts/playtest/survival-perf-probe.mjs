import { cpus, loadavg } from 'node:os';
import {
  callHarness,
  finiteNumber,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'runMode',
  'startRun',
  'phase',
  'setAutopilot',
  'setDriven',
  'step',
  'present',
  'profile',
  'settings',
  'setSettings',
  'setSurvivalElapsed',
  'setSurvivalCameraMode',
  'survivalDebug',
  'errors',
];

const CAMERA_MODES = ['chase', 'cockpit', 'far-chase'];
const MAX_DIFFICULTY_SECONDS = 300;
const SOAK_FRAMES = 300;
const SOAK_DT = 0.2;
const SOAK_SIM_SECONDS = SOAK_FRAMES * SOAK_DT;
const FRAME_BUDGET = Object.freeze({
  meanFrameMs: 16.9,
  p95FrameMs: 20,
  p99FrameMs: 25,
  maxFrameMs: 40,
  maxLongFrameFraction: 0.01,
  minRenderScale: 0.58,
});

await runManagedSuite({
  suite: 'survival-perf-probe',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runSurvivalPerfProbe,
});

async function runSurvivalPerfProbe({ report, session, options }) {
  const page = session.page;

  await report.check({
    id: 'API.ready',
    name: 'The survival document and its first rendered frame are ready',
    assertion:
      'The managed target reloads with mode=meteor-survival, window.__LV.ready() resolves, and '
      + 'runMode() confirms the survival boot rather than the default time trial.',
  }, async () => {
    const navigation = await bootSurvivalMode(page, options.timeoutMs);
    await callHarness(page, 'ready', [], options.timeoutMs);
    const runMode = await callHarness(page, 'runMode');
    const evidence = { timeoutMs: options.timeoutMs, navigation, runMode };
    verify(runMode === 'meteor-survival',
      `runMode() returned ${String(runMode)} instead of meteor-survival.`, evidence);
    return evidence;
  });

  await report.check({
    id: 'SURVIVAL.environment',
    name: 'The probe runs in a declared native or HiDPI arm',
    assertion:
      'The viewport is 1920x1080 and deviceScaleFactor is explicitly 1 (normal) or 2 (HiDPI). '
      + 'Run this suite once per arm with distinct --out directories.',
  }, async () => {
    const evidence = {
      viewport: options.viewport,
      deviceScaleFactor: options.deviceScaleFactor,
      arm: options.deviceScaleFactor === 2 ? 'dsf2' : 'normal',
    };
    verify(options.viewport.width === 1920 && options.viewport.height === 1080,
      'Survival performance must be measured at a 1920x1080 CSS viewport.', evidence);
    verify(options.deviceScaleFactor === 1 || options.deviceScaleFactor === 2,
      'Use deviceScaleFactor 1 or 2 for a declared performance arm.', evidence);
    return evidence;
  });

  const settingsOutcome = await capture(async () => {
    await callHarness(page, 'setSettings', [{
      quality: options.quality,
      renderScale: 1,
      showFps: false,
      cameraMode: 'chase',
    }]);
    const actual = await callHarness(page, 'settings');
    return {
      requested: {
        quality: options.quality,
        renderScale: 1,
        showFps: false,
        cameraMode: 'chase',
      },
      actual,
    };
  });

  await report.check({
    id: 'SURVIVAL.settings',
    name: 'The performance quality baseline is applied',
    assertion:
      `quality=${options.quality}, renderScale=1, showFps=false and the ordinary chase camera `
      + 'are applied before survival-only camera control begins.',
  }, async () => {
    const evidence = unwrap(settingsOutcome);
    verify(evidence.actual?.quality === options.quality, 'Quality setting did not apply.', evidence);
    verify(evidence.actual?.renderScale === 1, 'Render scale setting did not apply.', evidence);
    verify(evidence.actual?.showFps === false, 'FPS overlay was not disabled.', evidence);
    verify(evidence.actual?.cameraMode === 'chase', 'Ordinary camera baseline is not chase.', evidence);
    return evidence;
  });

  const instrumentationOutcome = await capture(() => installShaderInstrumentation(page));
  const injectionOutcome = await capture(async () => {
    unwrap(settingsOutcome);
    const instrumentation = unwrap(instrumentationOutcome);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    await callHarness(page, 'present', [], options.timeoutMs);
    const phase = await callHarness(page, 'phase');
    const before = await callHarness(page, 'survivalDebug');

    await resetShaderInstrumentation(page, 'max-difficulty-injection');
    const injected = await callHarness(page, 'setSurvivalElapsed', [MAX_DIFFICULTY_SECONDS]);
    await callHarness(page, 'present', [], options.timeoutMs);
    const after = await callHarness(page, 'survivalDebug');
    const shaders = await shaderInstrumentationSummary(page);

    return { phase, instrumentation, before, injected, after, shaders };
  });

  const prewarmOutcome = await capture(async () => {
    unwrap(injectionOutcome);
    await resetShaderInstrumentation(page, 'camera-prewarm');
    const cameras = [];
    for (const mode of CAMERA_MODES) {
      const applied = await callHarness(page, 'setSurvivalCameraMode', [mode]);
      await callHarness(page, 'present', [], options.timeoutMs);
      const presented = await callHarness(page, 'survivalDebug');
      cameras.push({ mode, applied, presented });
    }
    const returnedToChase = await callHarness(page, 'setSurvivalCameraMode', ['chase']);
    await waitRafFrames(page, 120, options.timeoutMs);
    const baseline = await callHarness(page, 'survivalDebug');
    const shaders = await shaderInstrumentationSummary(page);
    return { cameras, returnedToChase, warmFrames: 120, baseline, shaders };
  });

  const profilesOutcome = await capture(async () => {
    unwrap(prewarmOutcome);
    const profiles = [];
    const timeoutMs = Math.max(options.timeoutMs, (options.profileSeconds + 10) * 1_000);

    for (const mode of CAMERA_MODES) {
      await resetShaderInstrumentation(page, `camera-${mode}`);
      const before = await callHarness(page, 'survivalDebug');
      const staged = await callHarness(page, 'setSurvivalElapsed', [MAX_DIFFICULTY_SECONDS]);
      const camera = await callHarness(page, 'setSurvivalCameraMode', [mode]);
      const sample = await callHarness(page, 'profile', [options.profileSeconds], timeoutMs);
      const after = await callHarness(page, 'survivalDebug');
      const shaders = await shaderInstrumentationSummary(page);
      profiles.push({ mode, before, staged, camera, after, sample, shaders });
    }
    return profiles;
  });

  const soakOutcome = await capture(async () => {
    unwrap(profilesOutcome);
    await callHarness(page, 'setSurvivalCameraMode', ['far-chase']);
    await callHarness(page, 'setSurvivalElapsed', [MAX_DIFFICULTY_SECONDS]);
    const before = await callHarness(page, 'survivalDebug');
    await resetShaderInstrumentation(page, 'accelerated-soak');
    const wallStart = performance.now();
    await callHarness(
      page,
      'step',
      [SOAK_FRAMES, SOAK_DT],
      Math.max(options.timeoutMs, 120_000),
    );
    const wallMs = performance.now() - wallStart;
    const after = await callHarness(page, 'survivalDebug');
    const shaders = await shaderInstrumentationSummary(page);
    return {
      contract: {
        startSeconds: MAX_DIFFICULTY_SECONDS,
        frames: SOAK_FRAMES,
        dt: SOAK_DT,
        simulatedSeconds: SOAK_SIM_SECONDS,
      },
      before,
      after,
      shaders,
      wallMs,
    };
  });

  await report.check({
    id: 'SURVIVAL.state-contract',
    name: 'Survival debug snapshots are complete and internally consistent',
    assertion:
      'Every captured state has a valid max-difficulty clock, survival-only camera mode, pool '
      + 'partition, counters, renderer counts and optional paired simulation timing fields.',
  }, async () => {
    const injection = unwrap(injectionOutcome);
    const prewarm = unwrap(prewarmOutcome);
    const profiles = unwrap(profilesOutcome);
    const soak = unwrap(soakOutcome);
    const snapshots = [
      ['injection.before', injection.before],
      ['injection.injected', injection.injected],
      ['injection.after', injection.after],
      ...prewarm.cameras.flatMap((camera) => [
        [`prewarm.${camera.mode}.applied`, camera.applied],
        [`prewarm.${camera.mode}.presented`, camera.presented],
      ]),
      ['prewarm.returnedToChase', prewarm.returnedToChase],
      ['prewarm.baseline', prewarm.baseline],
      ...profiles.flatMap((profile) => [
        [`${profile.mode}.before`, profile.before],
        [`${profile.mode}.staged`, profile.staged],
        [`${profile.mode}.camera`, profile.camera],
        [`${profile.mode}.after`, profile.after],
      ]),
      ['soak.before', soak.before],
      ['soak.after', soak.after],
    ];
    for (const [label, state] of snapshots) validateSurvivalState(state, label, snapshots);
    return {
      snapshots: snapshots.map(([label, state]) => ({ label, state })),
    };
  });

  await report.check({
    id: 'SURVIVAL.max-difficulty',
    name: 'The 300-second maximum difficulty state is injected without allocation',
    assertion:
      'setSurvivalElapsed(300) reports difficulty 1, fills the active pool to its cap, keeps '
      + 'pool and renderer resources unchanged, and causes no shader compile or program link.',
  }, async () => {
    const evidence = unwrap(injectionOutcome);
    verify(evidence.phase === 'flying', 'Maximum difficulty was not staged during active flight.', evidence);
    verify(evidence.injected.enabled === true, 'Survival mode is not enabled.', evidence);
    verify(evidence.injected.elapsedSeconds === MAX_DIFFICULTY_SECONDS,
      `Injected elapsed time is ${evidence.injected.elapsedSeconds}, expected 300.`, evidence);
    verify(evidence.injected.maxDifficultySeconds === MAX_DIFFICULTY_SECONDS,
      'The production maximum-difficulty time is not 300 seconds.', evidence);
    verify(evidence.injected.difficulty === 1, 'The injected difficulty is not exactly 1.', evidence);
    verify(evidence.injected.activeMeteors === evidence.injected.activeCap,
      'Maximum difficulty did not deterministically fill the active meteor cap.', evidence);
    verify(evidence.instrumentation.installed === true
      && evidence.instrumentation.patched.length >= 2,
    'WebGL shader instrumentation did not patch a rendering context.', evidence);
    verify(resourcesEqual(evidence.before, evidence.injected)
      && resourcesEqual(evidence.injected, evidence.after),
    'Injecting or presenting maximum difficulty changed renderer resources.', evidence);
    verify(evidence.before.poolSize === evidence.injected.poolSize
      && evidence.injected.poolSize === evidence.after.poolSize,
    'Maximum-difficulty injection resized the meteor pool.', evidence);
    verify(evidence.shaders.compileShaderCalls === 0 && evidence.shaders.linkProgramCalls === 0,
      'Maximum-difficulty injection discovered a late shader or program.', evidence);
    return evidence;
  });

  await report.check({
    id: 'SURVIVAL.camera-profiles',
    name: 'All survival cameras return valid live-rAF profiles',
    assertion:
      'Chase, cockpit and far-chase each remain at maximum difficulty and return ordered, finite '
      + 'rAF timing percentiles plus render scale, draw, triangle and resource measurements.',
  }, async () => {
    const profiles = unwrap(profilesOutcome);
    for (const profile of profiles) {
      validatePerfSample(profile.sample, profile.mode, options);
      verify(profile.camera.cameraMode === profile.mode && profile.after.cameraMode === profile.mode,
        `${profile.mode} did not remain the active survival camera.`, profile);
      verify(profile.staged.difficulty === 1 && profile.after.difficulty === 1,
        `${profile.mode} was not measured at maximum difficulty.`, profile);
      verify(profile.sample.drawCalls === profile.after.drawCalls,
        `${profile.mode} draw count disagrees between profile and survivalDebug.`, profile);
      verify(profile.sample.triangles === profile.after.triangles,
        `${profile.mode} triangle count disagrees between profile and survivalDebug.`, profile);
    }
    return {
      requestedProfileSeconds: options.profileSeconds,
      deviceScaleFactor: options.deviceScaleFactor,
      hostLoad: loadavg().map((value) => Math.round(value * 100) / 100),
      hostCpus: cpus().length,
      profiles,
    };
  });

  await report.check({
    id: 'SURVIVAL.frame-budget',
    name: 'Maximum difficulty stays within the presented-frame budget',
    assertion:
      'For every camera: mean <= 16.9 ms, p95 <= 20 ms, p99 <= 25 ms, max <= 40 ms, at most '
      + '1% of frames exceed 20 ms, and adaptive render scale remains >= 0.58.',
  }, async () => {
    const profiles = unwrap(profilesOutcome);
    for (const profile of profiles) {
      const { sample, mode } = profile;
      const maximumLongFrames = Math.ceil(sample.frames * FRAME_BUDGET.maxLongFrameFraction);
      verify(sample.meanFrameMs <= FRAME_BUDGET.meanFrameMs,
        `${mode} mean ${sample.meanFrameMs.toFixed(2)} ms exceeds 16.9 ms.`, profile);
      verify(sample.p95FrameMs <= FRAME_BUDGET.p95FrameMs,
        `${mode} p95 ${sample.p95FrameMs.toFixed(2)} ms exceeds 20 ms.`, profile);
      verify(sample.p99FrameMs <= FRAME_BUDGET.p99FrameMs,
        `${mode} p99 ${sample.p99FrameMs.toFixed(2)} ms exceeds 25 ms.`, profile);
      verify(sample.maxFrameMs <= FRAME_BUDGET.maxFrameMs,
        `${mode} max ${sample.maxFrameMs.toFixed(2)} ms exceeds 40 ms.`, profile);
      verify(sample.longFrames <= maximumLongFrames,
        `${mode} has ${sample.longFrames}/${sample.frames} long frames; maximum is ${maximumLongFrames}.`, profile);
      verify(sample.renderScale >= FRAME_BUDGET.minRenderScale,
        `${mode} adaptive render scale collapsed to ${sample.renderScale.toFixed(3)}.`, profile);
    }
    return { budget: FRAME_BUDGET, profiles };
  });

  await report.check({
    id: 'SURVIVAL.no-late-shaders',
    name: 'Maximum difficulty and all cameras are shader-prewarmed',
    assertion:
      'The max-difficulty injection, three-camera prewarm and each live profile perform zero '
      + 'WebGL compileShader calls and zero linkProgram calls.',
  }, async () => {
    const injection = unwrap(injectionOutcome);
    const prewarm = unwrap(prewarmOutcome);
    const profiles = unwrap(profilesOutcome);
    const windows = [
      { name: 'max-difficulty-injection', ...injection.shaders },
      { name: 'camera-prewarm', ...prewarm.shaders },
      ...profiles.map((profile) => ({ name: profile.mode, ...profile.shaders })),
    ];
    for (const window of windows) {
      verify(window.compileShaderCalls === 0,
        `${window.name} performed ${window.compileShaderCalls} compileShader call(s).`, windows);
      verify(window.linkProgramCalls === 0,
        `${window.name} performed ${window.linkProgramCalls} linkProgram call(s).`, windows);
    }
    return { windows };
  });

  await report.check({
    id: 'SURVIVAL.resource-stability',
    name: 'Renderer and meteor-pool resources remain stable across camera modes',
    assertion:
      'After each camera has presented once, programs, geometries, textures and pool capacity '
      + 'remain exactly equal through all three live profiles and the accelerated soak.',
  }, async () => {
    const prewarm = unwrap(prewarmOutcome);
    const profiles = unwrap(profilesOutcome);
    const soak = unwrap(soakOutcome);
    const baseline = prewarm.baseline;
    const snapshots = [
      ...profiles.flatMap((profile) => [
        [`${profile.mode}.staged`, profile.staged],
        [`${profile.mode}.camera`, profile.camera],
        [`${profile.mode}.after`, profile.after],
      ]),
      ['soak.before', soak.before],
      ['soak.after', soak.after],
    ];
    for (const [label, state] of snapshots) {
      verify(resourcesEqual(baseline, state),
        `${label} changed programs/geometries/textures.`, { baseline, label, state });
      verify(state.poolSize === baseline.poolSize,
        `${label} resized the meteor pool from ${baseline.poolSize} to ${state.poolSize}.`, {
          baseline,
          label,
          state,
        });
    }
    return {
      baseline: resourceEvidence(baseline),
      snapshots: snapshots.map(([label, state]) => ({ label, ...resourceEvidence(state) })),
    };
  });

  await report.check({
    id: 'SURVIVAL.active-cap',
    name: 'The active meteor cap is never exceeded',
    assertion:
      'The 300-second injection reaches the configured cap, every later active/peak count stays '
      + 'at or below it, and active plus free slots always equals fixed pool capacity.',
  }, async () => {
    const injection = unwrap(injectionOutcome);
    const profiles = unwrap(profilesOutcome);
    const soak = unwrap(soakOutcome);
    const snapshots = [
      ['injected', injection.injected],
      ['injection.after', injection.after],
      ...profiles.flatMap((profile) => [
        [`${profile.mode}.staged`, profile.staged],
        [`${profile.mode}.after`, profile.after],
      ]),
      ['soak.before', soak.before],
      ['soak.after', soak.after],
    ];
    verify(injection.injected.activeMeteors === injection.injected.activeCap,
      'The max-difficulty injection did not initially reach the active cap.', injection);
    for (const [label, state] of snapshots) {
      verify(state.activeMeteors <= state.activeCap,
        `${label} active count ${state.activeMeteors} exceeds cap ${state.activeCap}.`, snapshots);
      verify(state.peakActiveMeteors <= state.activeCap,
        `${label} peak ${state.peakActiveMeteors} exceeds cap ${state.activeCap}.`, snapshots);
      verify(state.activeMeteors + state.freeMeteors === state.poolSize,
        `${label} pool partition does not sum to ${state.poolSize}.`, snapshots);
    }
    return { snapshots: snapshots.map(([label, state]) => ({ label, state })) };
  });

  await report.check({
    id: 'SURVIVAL.accelerated-soak',
    name: 'A short accelerated maximum-difficulty soak stays bounded',
    assertion:
      `${SOAK_FRAMES} driven frames at dt=${SOAK_DT} advance survival by exactly `
      + `${SOAK_SIM_SECONDS} seconds while preserving resources, counters, cap and prewarmed shaders.`,
  }, async () => {
    const evidence = unwrap(soakOutcome);
    const elapsedDelta = evidence.after.elapsedSeconds - evidence.before.elapsedSeconds;
    verify(Math.abs(elapsedDelta - SOAK_SIM_SECONDS) <= 1e-6,
      `Accelerated soak advanced ${elapsedDelta} seconds, expected ${SOAK_SIM_SECONDS}.`, evidence);
    verify(evidence.after.totalSpawned >= evidence.before.totalSpawned,
      'Spawn counter moved backwards during the soak.', evidence);
    verify(evidence.after.totalRecycled >= evidence.before.totalRecycled,
      'Recycle counter moved backwards during the soak.', evidence);
    verify(evidence.after.activeMeteors <= evidence.after.activeCap
      && evidence.after.peakActiveMeteors <= evidence.after.activeCap,
    'The active or peak count exceeded the cap during the soak.', evidence);
    verify(evidence.after.poolSize === evidence.before.poolSize
      && resourcesEqual(evidence.before, evidence.after),
    'The accelerated soak allocated renderer or pool resources.', evidence);
    verify(evidence.shaders.compileShaderCalls === 0 && evidence.shaders.linkProgramCalls === 0,
      'The accelerated soak discovered a late shader or program.', evidence);
    return { ...evidence, elapsedDelta };
  });

  const cleanupOutcome = await capture(async () => {
    const autopilotDisabled = await bestEffort(page, 'setAutopilot', [false]);
    const drivenReleased = await bestEffort(page, 'setDriven', [false]);
    const instrumentation = await restoreShaderInstrumentation(page);
    return { autopilotDisabled, drivenReleased, instrumentation };
  });

  await report.check({
    id: 'SURVIVAL.instrumentation-cleanup',
    name: 'WebGL instrumentation and driven controls are released',
    assertion: 'Every patched WebGL method is restored and test-only flight control is released.',
  }, async () => {
    const evidence = unwrap(cleanupOutcome);
    verify(evidence.autopilotDisabled === true && evidence.drivenReleased === true,
      'Test-only flight control was not released.', evidence);
    verify(evidence.instrumentation.restored === true,
      'A WebGL descriptor was not restored.', evidence);
    return evidence;
  });
}

async function bootSurvivalMode(page, timeoutMs) {
  verify(page, 'Browser page is unavailable.');
  const url = new URL(page.url());
  url.searchParams.set('mode', 'meteor-survival');
  if (url.href === page.url()) {
    await waitForHarness(page, timeoutMs);
    return { reloaded: false, status: null, url: url.href };
  }
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: timeoutMs });
  verify(response && response.ok(), 'Survival-mode reload returned a non-success document.', {
    status: response?.status() ?? null,
    url: url.href,
  });
  const present = await waitForHarness(page, timeoutMs);
  verify(present, 'window.__LV did not appear after the survival-mode reload.', { url: url.href });
  return { reloaded: true, status: response.status(), url: response.url() };
}

async function waitRafFrames(page, frames, timeoutMs) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate(async ({ requestedFrames, callTimeoutMs }) => {
    let timer;
    try {
      await Promise.race([
        new Promise((resolve) => {
          let remaining = requestedFrames;
          const tick = () => {
            remaining -= 1;
            if (remaining <= 0) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
        new Promise((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`rAF warmup timed out after ${callTimeoutMs} ms.`)),
            callTimeoutMs,
          );
        }),
      ]);
      return requestedFrames;
    } finally {
      window.clearTimeout(timer);
    }
  }, { requestedFrames: frames, callTimeoutMs: timeoutMs });
}

function validateSurvivalState(state, label, evidence) {
  verify(state && typeof state === 'object', `${label} is not an object.`, evidence);
  verify(typeof state.enabled === 'boolean', `${label}.enabled is not boolean.`, evidence);
  verify(CAMERA_MODES.includes(state.cameraMode), `${label}.cameraMode is invalid.`, evidence);
  const finiteKeys = [
    'elapsedSeconds',
    'difficulty',
    'maxDifficultySeconds',
    'activeMeteors',
    'activeCap',
    'peakActiveMeteors',
    'poolSize',
    'freeMeteors',
    'totalSpawned',
    'totalRecycled',
    'drawCalls',
    'triangles',
    'programs',
    'geometries',
    'textures',
  ];
  verify(finiteKeys.every((key) => finiteNumber(state[key]) && state[key] >= 0),
    `${label} contains an invalid numeric field.`, evidence);
  const integerKeys = finiteKeys.filter((key) => ![
    'elapsedSeconds',
    'difficulty',
    'maxDifficultySeconds',
  ].includes(key));
  verify(integerKeys.every((key) => Number.isInteger(state[key])),
    `${label} contains a non-integer count.`, evidence);
  verify(state.difficulty <= 1, `${label}.difficulty exceeds 1.`, evidence);
  verify(state.activeCap <= state.poolSize, `${label}.activeCap exceeds poolSize.`, evidence);
  verify(state.activeMeteors + state.freeMeteors === state.poolSize,
    `${label} active/free pool partition is inconsistent.`, evidence);
  const hasLast = state.simulationMsLast !== undefined;
  const hasMax = state.simulationMsMax !== undefined;
  verify(hasLast === hasMax, `${label} exposes only one simulation timing field.`, evidence);
  if (hasLast) {
    verify(finiteNumber(state.simulationMsLast) && state.simulationMsLast >= 0
      && finiteNumber(state.simulationMsMax) && state.simulationMsMax >= state.simulationMsLast,
    `${label} has invalid simulation timing.`, evidence);
  }
}

function validatePerfSample(sample, label, options) {
  const evidence = { label, sample, viewport: options.viewport, deviceScaleFactor: options.deviceScaleFactor };
  verify(sample && typeof sample === 'object', `${label} profile is missing.`, evidence);
  verify(finiteNumber(sample.seconds) && sample.seconds > 0, `${label} seconds is invalid.`, evidence);
  verify(finiteNumber(sample.fps) && sample.fps > 0, `${label} FPS is invalid.`, evidence);
  for (const key of ['meanFrameMs', 'p50FrameMs', 'p95FrameMs', 'p99FrameMs', 'maxFrameMs']) {
    verify(finiteNumber(sample[key]) && sample[key] >= 0, `${label}.${key} is invalid.`, evidence);
  }
  for (const key of [
    'frames',
    'longFrames',
    'drawCalls',
    'triangles',
    'programs',
    'geometries',
    'textures',
    'drawingBufferWidth',
    'drawingBufferHeight',
  ]) {
    verify(Number.isInteger(sample[key]) && sample[key] >= 0, `${label}.${key} is invalid.`, evidence);
  }
  verify(sample.frames > 0 && sample.drawCalls > 0 && sample.triangles > 0,
    `${label} did not render a positive sample.`, evidence);
  verify(sample.p50FrameMs <= sample.p95FrameMs
    && sample.p95FrameMs <= sample.p99FrameMs
    && sample.p99FrameMs <= sample.maxFrameMs,
  `${label} timing percentiles are not ordered.`, evidence);
  verify(finiteNumber(sample.renderScale) && sample.renderScale > 0 && sample.renderScale <= 1,
    `${label} renderScale is invalid.`, evidence);
  verify(sample.drawingBufferWidth > 0 && sample.drawingBufferHeight > 0,
    `${label} drawing buffer is empty.`, evidence);
  const calculatedFps = sample.frames / sample.seconds;
  verify(Math.abs(calculatedFps - sample.fps) <= Math.max(1, sample.fps * 0.05),
    `${label} FPS is inconsistent with frames / seconds.`, { ...evidence, calculatedFps });
  const allocationWidth = Math.round(sample.drawingBufferWidth / sample.renderScale);
  const allocationHeight = Math.round(sample.drawingBufferHeight / sample.renderScale);
  verify(allocationWidth * allocationHeight <= 2_600_000,
    `${label} backing allocation exceeds the 2.6 Mpx fill budget.`, {
      ...evidence,
      allocationWidth,
      allocationHeight,
    });
  const allocationAspect = allocationWidth / allocationHeight;
  const viewportAspect = options.viewport.width / options.viewport.height;
  verify(Math.abs(allocationAspect - viewportAspect) < 0.02,
    `${label} backing allocation has the wrong aspect ratio.`, {
      ...evidence,
      allocationWidth,
      allocationHeight,
      allocationAspect,
      viewportAspect,
    });
}

function resourcesEqual(a, b) {
  return a.programs === b.programs
    && a.geometries === b.geometries
    && a.textures === b.textures;
}

function resourceEvidence(state) {
  return {
    programs: state.programs,
    geometries: state.geometries,
    textures: state.textures,
    poolSize: state.poolSize,
    drawCalls: state.drawCalls,
    triangles: state.triangles,
  };
}

async function installShaderInstrumentation(page) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate(() => {
    const key = '__LV_SURVIVAL_PERF_SHADER__';
    const existing = window[key];
    if (existing) return existing.summary();

    const state = {
      active: false,
      label: null,
      startedAt: performance.now(),
      events: [],
      patches: [],
    };
    const record = (kind, context) => {
      if (!state.active) return;
      state.events.push({
        kind,
        context,
        label: state.label,
        atMs: Math.round((performance.now() - state.startedAt) * 1_000) / 1_000,
      });
    };
    for (const constructorName of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const prototype = window[constructorName]?.prototype;
      if (!prototype) continue;
      for (const method of ['compileShader', 'linkProgram']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        const original = descriptor.value;
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function instrumentedSurvivalWebGLCall(...args) {
            const result = Reflect.apply(original, this, args);
            record(method, constructorName);
            return result;
          },
        });
        state.patches.push({ constructorName, prototype, method, descriptor });
      }
    }
    state.reset = (label) => {
      state.events.length = 0;
      state.label = label;
      state.startedAt = performance.now();
      state.active = true;
      return state.summary();
    };
    state.summary = () => ({
      installed: state.patches.length > 0,
      label: state.label,
      compileShaderCalls: state.events.filter((event) => event.kind === 'compileShader').length,
      linkProgramCalls: state.events.filter((event) => event.kind === 'linkProgram').length,
      patched: state.patches.map(({ constructorName, method }) => `${constructorName}.${method}`),
      events: state.events.map((event) => ({ ...event })),
    });
    window[key] = state;
    return state.summary();
  });
}

async function resetShaderInstrumentation(page, label) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate((nextLabel) => {
    const state = window.__LV_SURVIVAL_PERF_SHADER__;
    if (!state) throw new Error('Survival shader instrumentation is unavailable.');
    return state.reset(nextLabel);
  }, label);
}

async function shaderInstrumentationSummary(page) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate(() => {
    const state = window.__LV_SURVIVAL_PERF_SHADER__;
    if (!state) throw new Error('Survival shader instrumentation is unavailable.');
    state.active = false;
    return state.summary();
  });
}

async function restoreShaderInstrumentation(page) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate(() => {
    const key = '__LV_SURVIVAL_PERF_SHADER__';
    const state = window[key];
    if (!state) return { installed: false, restored: true, patched: [] };
    state.active = false;
    const patched = state.patches.map(({ constructorName, method }) => `${constructorName}.${method}`);
    let restored = state.patches.length > 0;
    for (let index = state.patches.length - 1; index >= 0; index -= 1) {
      const entry = state.patches[index];
      try {
        Object.defineProperty(entry.prototype, entry.method, entry.descriptor);
        restored &&= Object.getOwnPropertyDescriptor(entry.prototype, entry.method)?.value
          === entry.descriptor.value;
      } catch {
        restored = false;
      }
    }
    delete window[key];
    return { installed: true, restored, patched };
  });
}

async function bestEffort(page, method, args) {
  try {
    await callHarness(page, method, args);
    return true;
  } catch {
    return false;
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
