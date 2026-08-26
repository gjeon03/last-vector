import { cpus, loadavg } from 'node:os';
import {
  callHarness,
  finiteNumber,
  installNetworkBoundary,
  installPageObservers,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
const DEVICE_SCALE_FACTORS = Object.freeze([1, 2]);
const STAGES = Object.freeze([
  { id: 'cairn-drift', heaviestVantage: 'shelf-edge' },
  { id: 'wreckline', heaviestVantage: 'signature' },
  { id: 'ringfall', heaviestVantage: 'signature' },
]);
const WARMUP_FRAMES = 120;
const PROFILE_SECONDS = 5;
const RETRY_SECONDS = 10;
const BUDGETS = Object.freeze({
  meanFrameMs: 16.9,
  p95FrameMs: 20,
  maxFrameMs: 33,
  renderScale: 0.58,
  lateShaders: 0,
  errors: 0,
  drawCalls: 160,
  triangles: 620_000,
  geometries: 155,
  textures: 16,
  programs: 55,
});
const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'phase',
  'course',
  'installProgress',
  'vantage',
  'clearVantage',
  'vantages',
  'setAutopilot',
  'setDriven',
  'setFixedTimestep',
  'step',
  'present',
  'profile',
  'settings',
  'setSettings',
  'errors',
];

await runManagedSuite({
  suite: 'chapter-perf',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runChapterPerf,
});

async function runChapterPerf({ report, session, options }) {
  verify(session.browser && session.target, 'Managed browser or local target is unavailable.');
  verify(options.viewport.width === VIEWPORT.width && options.viewport.height === VIEWPORT.height,
    'Chapter performance must run at a 1920x1080 CSS viewport.', options.viewport);

  report.data.configuration.quality = 'high';
  report.data.configuration.profileSeconds = PROFILE_SECONDS;
  report.data.configuration.chapterPerformance = {
    stages: STAGES.map(({ id }) => id),
    deviceScaleFactors: DEVICE_SCALE_FACTORS,
    arms: STAGES.length * DEVICE_SCALE_FACTORS.length,
    warmupFrames: WARMUP_FRAMES,
    framePacing: 'live requestAnimationFrame',
    courseTransition: 'full URL reload',
    budgets: BUDGETS,
    resourceBudgetShorthand: '160/620k/155/16/55',
    retry: { failedArmOnly: true, attempts: 1, seconds: RETRY_SECONDS },
  };

  // `runManagedSuite` owns an entry page in addition to the DPR-specific page below. Leaving
  // that page on live rAF makes two full games compete for one GPU; with background throttling
  // deliberately disabled by the browser contract, every arm then lands on alternating vsyncs
  // at ~30 fps. Keep the management page alive for observations, but stop its render loop before
  // measuring the one intentional scene.
  await callHarness(session.page, 'setDriven', [true]);

  const outcomes = [];
  for (const deviceScaleFactor of DEVICE_SCALE_FACTORS) {
    const armSession = await openDprSession(session, options, deviceScaleFactor);
    try {
      for (const stage of STAGES) {
        const outcome = await report.check({
          id: `CHAPTER_PERF.${stage.id}-dpr${deviceScaleFactor}`,
          name: `${stage.id} DPR${deviceScaleFactor} holds the Chapter 01 frame and resource budgets`,
          assertion:
            'After URL reload, High/renderScale 1, every authored vantage presented, and 120 live rAF warm-up frames, a five-second live profile stays within 16.9/20/33 ms, scale 0.58, zero late shaders/errors, and 160/620k/155/16/55 resources. Only a failed primary arm receives one ten-second retry.',
        }, async () => runArmWithRetry(
          armSession,
          session,
          options,
          stage,
          deviceScaleFactor,
        ));
        outcomes.push({ stageId: stage.id, deviceScaleFactor, ok: outcome.ok });
      }
    } finally {
      await armSession.context.close().catch(() => {});
    }
  }

  await report.check({
    id: 'CHAPTER_PERF.six-arm-matrix',
    name: 'Chapter performance matrix contains exactly six primary arms',
    assertion: 'CAIRN, WRECKLINE, and RINGFALL each run once at DPR1 and DPR2; retries remain nested under their failed primary arm.',
  }, async () => {
    const expected = DEVICE_SCALE_FACTORS.flatMap((deviceScaleFactor) =>
      STAGES.map(({ id }) => `${id}@${deviceScaleFactor}`));
    const actual = outcomes.map(({ stageId, deviceScaleFactor }) => `${stageId}@${deviceScaleFactor}`);
    verify(actual.length === 6
      && expected.every((arm) => actual.includes(arm))
      && outcomes.every(({ ok }) => ok),
    'The six-arm Chapter performance matrix is incomplete or contains a failed arm.', {
      expected,
      actual,
      outcomes,
    });
    return { expected, actual, outcomes };
  });
}

async function openDprSession(session, options, deviceScaleFactor) {
  const context = await session.browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor,
    serviceWorkers: 'block',
  });
  await installNetworkBoundary(context, session.observations);
  const page = await context.newPage();
  installPageObservers(page, session.observations);

  const observations = { consoleErrors: [], pageErrors: [] };
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    observations.consoleErrors.push({ text: message.text(), location: message.location() });
  });
  page.on('pageerror', (error) => {
    observations.pageErrors.push({ name: error.name, message: error.message });
  });

  const url = new URL(session.target.url);
  url.searchParams.set('seed', String(options.seed));
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: options.timeoutMs });
  verify(response?.ok(), 'DPR session entry document failed to load.', {
    deviceScaleFactor,
    status: response?.status() ?? null,
    url: url.href,
  });
  verify(await waitForHarness(page, options.timeoutMs), 'Harness did not load in DPR session.', {
    deviceScaleFactor,
    url: url.href,
  });
  await callHarness(page, 'ready', [], options.timeoutMs);
  const persistence = await callHarness(page, 'installProgress', [completedProgress()]);
  verify(persistence?.reloadSafe === true && persistence?.localWritten === false,
    'DPR session progress is not reload-safe and session-only.', persistence);
  return { context, page, observations };
}

async function runArmWithRetry(armSession, session, options, stage, deviceScaleFactor) {
  let primary;
  try {
    primary = await measureArm(
      armSession,
      session,
      options,
      stage,
      deviceScaleFactor,
      PROFILE_SECONDS,
      'primary',
    );
    assertArm(primary);
    return { acceptedAttempt: 'primary', primary, retry: null };
  } catch (error) {
    const primaryFailure = normaliseError(error);
    let retry;
    try {
      retry = await measureArm(
        armSession,
        session,
        options,
        stage,
        deviceScaleFactor,
        RETRY_SECONDS,
        'retry',
      );
      assertArm(retry);
      return {
        acceptedAttempt: 'retry',
        primary: primary ?? null,
        primaryFailure,
        retry,
      };
    } catch (retryError) {
      const combined = new Error(
        `${stage.id} DPR${deviceScaleFactor} failed its five-second primary and one ten-second retry.`,
      );
      combined.name = 'ChapterPerfArmError';
      combined.evidence = {
        stageId: stage.id,
        deviceScaleFactor,
        primary: primary ?? null,
        primaryFailure,
        retry: retry ?? null,
        retryFailure: normaliseError(retryError),
      };
      throw combined;
    }
  }
}

async function measureArm(
  armSession,
  session,
  options,
  stage,
  deviceScaleFactor,
  profileSeconds,
  attempt,
) {
  const { page, observations } = armSession;
  const errorStart = {
    console: observations.consoleErrors.length,
    page: observations.pageErrors.length,
  };
  const navigation = await reloadStage(page, session, options, stage.id);

  await callHarness(page, 'setSettings', [{
    quality: 'high',
    renderScale: 1,
    showFps: false,
    filmGrain: false,
    cameraMode: 'chase',
  }]);
  const initialSettings = await callHarness(page, 'settings');
  verify(initialSettings?.quality === 'high'
    && initialSettings?.renderScale === 1
    && initialSettings?.showFps === false,
  'High quality/renderScale 1 did not apply before prewarming.', { stage, deviceScaleFactor, initialSettings });

  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [false]);
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  const phase = await callHarness(page, 'phase');
  verify(phase === 'flying', 'Performance arm did not enter live flight.', { stage, deviceScaleFactor, phase });

  const vantages = await callHarness(page, 'vantages');
  verify(Array.isArray(vantages)
    && vantages.length > 0
    && vantages.includes(stage.heaviestVantage),
  'Stage does not expose its declared heaviest authored vantage.', { stage, vantages });
  const presentedVantages = [];
  for (const vantage of vantages) {
    await callHarness(page, 'vantage', [vantage]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'present', [], options.timeoutMs);
    presentedVantages.push(vantage);
  }
  await callHarness(page, 'vantage', [stage.heaviestVantage]);
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  await callHarness(page, 'present', [], options.timeoutMs);
  // Vantages are authored stills, not playable camera states: they pin the ship/camera to an
  // intentionally extreme composition every visual update. Present all of them to make shader
  // and resource residency part of the contract, then profile the live chase camera the player
  // actually flies. The focused chapter-visual suite owns the static-composition evidence.
  await callHarness(page, 'clearVantage');
  // `vantage('terminus')` intentionally stages every gate as cleared and parks the ship on the
  // arrival line. Clearing only the camera would let the warm-up finish the run and profile the
  // results overlay. Begin a fresh production run after material presentation so the measured
  // window is ordinary live flight from the authored spawn.
  await callHarness(page, 'setAutopilot', [false]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  const measurementPhase = await callHarness(page, 'phase');
  verify(measurementPhase === 'flying',
    'Chapter performance did not reset to live flight after vantage presentation.', {
      stageId: stage.id,
      deviceScaleFactor,
      measurementPhase,
    });

  const instrumentation = await installLateShaderProbe(page);
  let lateShaders = null;
  let sample = null;
  try {
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    await callHarness(page, 'setDriven', [false]);
    const warmup = await warmLiveRaf(page, WARMUP_FRAMES, options.timeoutMs);
    const profileTimeoutMs = Math.max(options.timeoutMs, (profileSeconds + 10) * 1_000);
    sample = await callHarness(page, 'profile', [profileSeconds], profileTimeoutMs);
    lateShaders = await stopLateShaderProbe(page);

    const course = await callHarness(page, 'course');
    const gameErrors = await callHarness(page, 'errors');
    const actualDpr = await page.evaluate(() => devicePixelRatio);
    const errors = {
      console: observations.consoleErrors.slice(errorStart.console),
      page: observations.pageErrors.slice(errorStart.page),
      game: gameErrors,
    };
    return {
      attempt,
      stageId: stage.id,
      deviceScaleFactor,
      actualDpr,
      navigation,
      course,
      viewport: VIEWPORT,
      quality: 'high',
      initialSettings,
      materialPresentation: {
        availableVantages: vantages,
        presentedVantages,
        complete: presentedVantages.length === vantages.length
          && vantages.every((vantage) => presentedVantages.includes(vantage)),
      },
      heaviestVantage: stage.heaviestVantage,
      measuredCamera: 'live-chase',
      measurementPhase,
      warmup,
      requestedProfileSeconds: profileSeconds,
      framePacing: 'live requestAnimationFrame',
      sample,
      lateShaders,
      instrumentation,
      errors,
      host: {
        loadAverage: loadavg().map((value) => Math.round(value * 100) / 100),
        cpus: cpus().length,
      },
      budgets: BUDGETS,
    };
  } finally {
    if (lateShaders === null) await stopLateShaderProbe(page).catch(() => {});
    await bestEffort(page, 'setAutopilot', [false]);
    await bestEffort(page, 'setDriven', [true]);
  }
}

function assertArm(evidence) {
  const { sample, errors, lateShaders } = evidence;
  verify(evidence.course?.courseId === evidence.stageId
    && evidence.course?.resolution?.source === 'url'
    && new URL(evidence.navigation.url).searchParams.get('course') === evidence.stageId,
  'Profile route identity does not match its URL reload.', evidence);
  verify(evidence.viewport.width === 1920
    && evidence.viewport.height === 1080
    && evidence.actualDpr === evidence.deviceScaleFactor,
  'Profile viewport or device scale factor is wrong.', evidence);
  verify(evidence.initialSettings?.quality === 'high'
    && evidence.initialSettings?.renderScale === 1,
  'Profile did not begin at High quality and renderScale 1.', evidence);
  verify(evidence.materialPresentation.complete === true,
    'Not every authored stage vantage was presented before the warm-up.', evidence);
  verify(evidence.measuredCamera === 'live-chase',
    'Chapter performance sampled an authored still instead of live chase flight.', evidence);
  verify(evidence.measurementPhase === 'flying',
    'Chapter performance did not begin from a reset flying phase.', evidence);
  verify(evidence.warmup.requestedFrames === WARMUP_FRAMES
    && evidence.warmup.presentedFrames === WARMUP_FRAMES,
  'Live rAF warm-up did not contain exactly 120 frames.', evidence);

  const timingKeys = ['seconds', 'meanFrameMs', 'p95FrameMs', 'maxFrameMs', 'renderScale'];
  const resourceKeys = ['drawCalls', 'triangles', 'geometries', 'textures', 'programs'];
  verify(timingKeys.every((key) => finiteNumber(sample?.[key]))
    && resourceKeys.every((key) => Number.isInteger(sample?.[key]) && sample[key] >= 0),
  'Profile returned invalid timing or resource values.', evidence);
  verify(sample.seconds >= evidence.requestedProfileSeconds * 0.9,
    'Live profile ended materially before its requested duration.', evidence);
  verify(sample.meanFrameMs <= BUDGETS.meanFrameMs,
    `Mean ${sample.meanFrameMs.toFixed(2)} ms exceeds ${BUDGETS.meanFrameMs} ms.`, evidence);
  verify(sample.p95FrameMs <= BUDGETS.p95FrameMs,
    `p95 ${sample.p95FrameMs.toFixed(2)} ms exceeds ${BUDGETS.p95FrameMs} ms.`, evidence);
  verify(sample.maxFrameMs <= BUDGETS.maxFrameMs,
    `Max ${sample.maxFrameMs.toFixed(2)} ms exceeds ${BUDGETS.maxFrameMs} ms.`, evidence);
  verify(sample.renderScale >= BUDGETS.renderScale,
    `Effective render scale ${sample.renderScale.toFixed(2)} is below ${BUDGETS.renderScale}.`, evidence);
  verify(sample.drawCalls <= BUDGETS.drawCalls
    && sample.triangles <= BUDGETS.triangles
    && sample.geometries <= BUDGETS.geometries
    && sample.textures <= BUDGETS.textures
    && sample.programs <= BUDGETS.programs,
  'Renderer resources exceed 160/620k/155/16/55.', evidence);
  verify(lateShaders?.installed === true
    && lateShaders.restored === true
    && lateShaders.compileShaderCalls + lateShaders.linkProgramCalls === BUDGETS.lateShaders,
  'Shader compile/link work occurred after material presentation.', evidence);
  verify(errors.console.length + errors.page.length + errors.game.length === BUDGETS.errors,
    'Console, page, or game error channels are non-empty.', evidence);
}

async function reloadStage(page, session, options, stageId) {
  const url = new URL(session.target.url);
  // Measure the shipped authored world for each stage. A shared debug seed would replace the
  // per-stage defaults and turn this into a synthetic seed matrix arm.
  url.searchParams.delete('seed');
  url.searchParams.set('course', stageId);
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: options.timeoutMs });
  verify(response?.ok(), 'Stage URL reload returned a non-success document.', {
    stageId,
    status: response?.status() ?? null,
    url: url.href,
  });
  verify(await waitForHarness(page, options.timeoutMs), 'Harness did not return after stage reload.', {
    stageId,
    url: url.href,
  });
  await callHarness(page, 'ready', [], options.timeoutMs);
  return { stageId, status: response.status(), url: page.url() };
}

async function warmLiveRaf(page, frameCount, timeoutMs) {
  return page.evaluate(async ({ requestedFrames, callTimeoutMs }) => {
    const beganAt = performance.now();
    let presentedFrames = 0;
    let previous = null;
    const intervals = [];
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error(`Live rAF warm-up timed out after ${callTimeoutMs} ms.`)),
        callTimeoutMs,
      );
      const tick = (timestamp) => {
        if (previous !== null) intervals.push(timestamp - previous);
        previous = timestamp;
        presentedFrames += 1;
        if (presentedFrames >= requestedFrames) {
          window.clearTimeout(timer);
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
    return {
      requestedFrames,
      presentedFrames,
      elapsedMs: Math.round((performance.now() - beganAt) * 1_000) / 1_000,
      measuredIntervals: intervals.length,
    };
  }, { requestedFrames: frameCount, callTimeoutMs: timeoutMs });
}

async function installLateShaderProbe(page) {
  return page.evaluate(() => {
    const state = {
      compileShaderCalls: 0,
      linkProgramCalls: 0,
      events: [],
      restored: [],
      installed: false,
    };
    for (const constructorName of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const prototype = window[constructorName]?.prototype;
      if (!prototype) continue;
      let methodsPatched = 0;
      for (const method of ['compileShader', 'linkProgram']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        const original = descriptor.value;
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function instrumentedChapterShaderCall(...args) {
            const result = Reflect.apply(original, this, args);
            if (method === 'compileShader') state.compileShaderCalls += 1;
            else state.linkProgramCalls += 1;
            state.events.push({
              kind: method,
              context: constructorName,
              atMs: Math.round(performance.now() * 1_000) / 1_000,
            });
            return result;
          },
        });
        state.restored.push({ prototype, method, descriptor });
        methodsPatched += 1;
      }
      if (methodsPatched === 2) state.installed = true;
    }
    window.__LV_CHAPTER_LATE_SHADER__ = state;
    return { installed: state.installed, patchedMethods: state.restored.length };
  });
}

async function stopLateShaderProbe(page) {
  return page.evaluate(() => {
    const state = window.__LV_CHAPTER_LATE_SHADER__;
    if (!state) {
      return {
        installed: false,
        compileShaderCalls: 0,
        linkProgramCalls: 0,
        events: [],
        restored: false,
      };
    }
    let restored = state.restored.length > 0;
    for (let index = state.restored.length - 1; index >= 0; index -= 1) {
      const entry = state.restored[index];
      try {
        Object.defineProperty(entry.prototype, entry.method, entry.descriptor);
      } catch {
        restored = false;
      }
    }
    const result = {
      installed: state.installed,
      compileShaderCalls: state.compileShaderCalls,
      linkProgramCalls: state.linkProgramCalls,
      events: state.events,
      restored,
    };
    delete window.__LV_CHAPTER_LATE_SHADER__;
    return result;
  });
}

async function bestEffort(page, method, args) {
  try {
    await callHarness(page, method, args);
  } catch {
    // The owning arm records the actionable failure.
  }
}

function completedProgress() {
  const cleared = {
    cleared: true,
    clearedAt: 1,
    highestRank: 'S',
    cleanClear: true,
    precisionClear: true,
  };
  return {
    version: 1,
    selectedCourse: 'cairn-drift',
    courses: {
      'cairn-drift': { ...cleared },
      wreckline: { ...cleared },
      ringfall: { ...cleared },
    },
  };
}

function normaliseError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    evidence: error?.evidence ?? null,
  };
}
