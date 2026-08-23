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
  'cockpitDebug',
  'cockpitMfd',
  'setAutopilot',
  'step',
  'present',
  'setDriven',
  'profile',
  'settings',
  'setSettings',
  'setFixedTimestep',
  'errors',
];

// Headless compositors occasionally coalesce one 60 Hz presentation into a 33-35 ms rAF delta
// without any shader work. Keep that host-noise allowance while rejecting the measured cold-
// compile regression, which consumed three refresh intervals (50 ms).
const COLD_COCKPIT_MAX_FRAME_MS = 40;

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
    assertion: `setSettings applies quality=${options.quality}, renderScale=1, showFps=false, and a chase-camera baseline before the measured cockpit transition.`,
  }, async () => {
    await callHarness(page, 'setSettings', [{
      quality: options.quality,
      renderScale: 1,
      showFps: false,
      cameraMode: 'chase',
    }]);
    const settings = await callHarness(page, 'settings');
    const evidence = {
      requested: { quality: options.quality, renderScale: 1, showFps: false, cameraMode: 'chase' },
      actual: settings,
    };
    verify(settings?.quality === options.quality, 'Quality setting did not apply.', evidence);
    verify(settings?.renderScale === 1, 'Render scale setting did not apply.', evidence);
    verify(settings?.showFps === false, 'FPS overlay setting did not apply.', evidence);
    verify(settings?.cameraMode === 'chase', 'Chase-camera baseline did not apply.', evidence);
    return evidence;
  });

  // Quality changes may legitimately compile their own title-screen variants. Install after that
  // baseline is applied, then reset once one chase frame has presented inside collectColdWindow.
  // The measured contract starts at the cockpit transition, not at an unrelated settings change.
  const coldInstrumentationOutcome = await capture(() => installColdInstrumentation(page));

  const mfdUploadOutcome = await capture(() => collectMfdUploadCadence(page, options.timeoutMs));

  await report.check({
    id: 'PERF.mfd-upload-cadence',
    name: 'The MFD redraw deadline produces one real canvas upload at exactly 20 Hz',
    criteria: [],
    assertion:
      'After one warm presented cockpit frame, exactly 20 MFD redraws occur over 60 fixed '
      + '60 Hz frames; WebGL observes exactly one successful texImage2D/texSubImage2D call per '
      + 'redraw from one 1024x256 HTMLCanvasElement, with unchanged cockpit budgets and no late shaders.',
  }, async () => {
    const evidence = unwrap(mfdUploadOutcome);
    verify(evidence.cameraMode === 'cockpit' && evidence.before.visible === true,
      'The fixed upload window did not begin in a visible cockpit.', evidence);
    verify(evidence.mfdUpdatesDelta === 20,
      `Expected exactly 20 MFD redraws in 60 fixed frames, observed ${evidence.mfdUpdatesDelta}.`, evidence);
    verify(evidence.uploads.total === 20
      && evidence.uploads.texImage2D + evidence.uploads.texSubImage2D === 20
      && evidence.uploads.total === evidence.mfdUpdatesDelta,
    'Actual 1024x256 canvas uploads did not match the exact redraw delta one-for-one.', evidence);
    verify(evidence.uploads.sources.length === 1
      && evidence.uploads.sources[0].constructor === 'HTMLCanvasElement'
      && evidence.uploads.sources[0].width === 1024
      && evidence.uploads.sources[0].height === 256,
    'The upload trace did not identify exactly one 1024x256 HTMLCanvasElement source.', evidence);
    verify(evidence.uploads.calls.length > 0
      && evidence.uploads.calls.every(({ constructor, width, height, kind }) =>
        constructor === 'HTMLCanvasElement' && width === 1024 && height === 256
        && (kind === 'texImage2D' || kind === 'texSubImage2D')),
    'The WebGL upload trace is empty or contains a non-canvas/non-MFD call.', evidence);
    verify(evidence.before.drawCalls === 20 && evidence.after.drawCalls === 20
      && evidence.before.triangles === 3540 && evidence.after.triangles === 3540
      && JSON.stringify(evidence.before.perspectiveScale) === JSON.stringify([1, 1, 1])
      && JSON.stringify(evidence.after.perspectiveScale) === JSON.stringify([1, 1, 1]),
    'Cockpit draw, triangle, or unit-scale budgets changed during the upload window.', evidence);
    verify(evidence.compileShaderCalls === 0 && evidence.linkProgramCalls === 0,
      'A shader compiled or linked during the fixed MFD upload window.', evidence);
    verify(evidence.instrumentation.restored === true,
      'A patched WebGL descriptor was not restored before the live profile.', evidence);
    return evidence;
  });

  const profileOutcome = await capture(async () => collectProfile(page, options));

  await report.check({
    id: 'PERF.cold-cockpit',
    name: 'The first cockpit flight is prewarmed before control begins',
    criteria: [],
    assertion:
      'From the measured chase-to-cockpit transition through the first 120 flying rAF frames, '
      + `WebGL performs zero new compileShader/linkProgram calls and no presented-frame interval exceeds ${COLD_COCKPIT_MAX_FRAME_MS} ms.`,
  }, async () => {
    unwrap(coldInstrumentationOutcome);
    const evidence = unwrap(profileOutcome);
    const cold = evidence.coldWindow;
    verify(cold?.instrumentation?.installed === true,
      'Cold-start WebGL instrumentation was not installed.', evidence);
    verify(Array.isArray(cold?.timeline) && cold.timeline.length >= 120,
      'Cold-start timeline did not contain the first 120 flying frames.', evidence);
    verify(Number.isInteger(cold?.compileShaderCalls) && cold.compileShaderCalls >= 0,
      'Cold-start compileShader count is invalid.', evidence);
    verify(Number.isInteger(cold?.linkProgramCalls) && cold.linkProgramCalls >= 0,
      'Cold-start linkProgram count is invalid.', evidence);
    verify(finiteNumber(cold?.maxFrameMs) && cold.maxFrameMs >= 0,
      'Cold-start maximum frame time is invalid.', evidence);
    verify(cold.compileShaderCalls === 0,
      `${cold.compileShaderCalls} shader compile(s) occurred during the first cockpit flight.`, evidence);
    verify(cold.linkProgramCalls === 0,
      `${cold.linkProgramCalls} program link(s) occurred during the first cockpit flight.`, evidence);
    verify(cold.maxFrameMs <= COLD_COCKPIT_MAX_FRAME_MS,
      `Cold cockpit frame ${cold.maxFrameIndex} took ${cold.maxFrameMs.toFixed(2)} ms, exceeding ${COLD_COCKPIT_MAX_FRAME_MS} ms.`, evidence);
    return evidence;
  });

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

  try {
    const coldWindow = await collectColdWindow(page, options.timeoutMs);
    const cameraMode = await callHarness(page, 'cameraMode');
    const profileTimeoutMs = Math.max(options.timeoutMs, (options.profileSeconds + 5) * 1_000);
    const sample = await callHarness(page, 'profile', [options.profileSeconds], profileTimeoutMs);
    return {
      seed: options.seed,
      warmupFrames: 120,
      fixedTimestep: 1 / 60,
      framePacing: 'requestAnimationFrame',
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
      coldWindow,
      sample,
    };
  } finally {
    await bestEffort(page, 'setAutopilot', [false]);
    await bestEffort(page, 'setDriven', [false]);
  }
}

/**
 * Count source-backed WebGL texture calls during an exact driven window. This is intentionally
 * separate from the live-rAF profile: wrapping is fully restored before the existing cold/live
 * measurements begin, and no screenshot or canvas readback occurs inside this window.
 */
async function collectMfdUploadCadence(page, timeoutMs) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate(async ({ callTimeoutMs }) => {
    const api = window.__LV;
    if (!api) throw new Error('Harness unavailable for MFD upload cadence.');

    api.setDriven(true);
    api.setSettings({
      cameraMode: 'cockpit',
      quality: 'high',
      renderScale: 1,
      showFps: false,
      cameraShake: 0,
      motionBlur: false,
      filmGrain: false,
      chromaticAberration: false,
    });
    api.startRun({ skipIntro: true });
    await api.step(1, 1 / 60);
    let warmTimer = null;
    try {
      await Promise.race([
        api.present(),
        new Promise((_, reject) => {
          warmTimer = window.setTimeout(
            () => reject(new Error(`Warm MFD presentation timed out after ${callTimeoutMs} ms.`)),
            callTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (warmTimer !== null) window.clearTimeout(warmTimer);
    }

    const before = api.cockpitDebug();
    const cameraMode = api.cameraMode();
    const calls = [];
    const sourceIds = new WeakMap();
    const sources = new Map();
    const restored = [];
    let nextSourceId = 1;
    let compileShaderCalls = 0;
    let linkProgramCalls = 0;

    const sourceIdentity = (source) => {
      let id = sourceIds.get(source);
      if (id === undefined) {
        id = nextSourceId++;
        sourceIds.set(source, id);
        sources.set(id, {
          id,
          identity: `${source.constructor?.name ?? 'Object'}#${id}`,
          constructor: source.constructor?.name ?? null,
          width: source.width,
          height: source.height,
        });
      }
      return id;
    };

    const patch = (constructorName, method) => {
      const prototype = window[constructorName]?.prototype;
      if (!prototype) return;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      if (!descriptor || typeof descriptor.value !== 'function') return;
      const original = descriptor.value;
      Object.defineProperty(prototype, method, {
        ...descriptor,
        value: function instrumentedMfdWebGLCall(...args) {
          const result = Reflect.apply(original, this, args);
          if (method === 'compileShader') {
            compileShaderCalls += 1;
          } else if (method === 'linkProgram') {
            linkProgramCalls += 1;
          } else {
            const source = args.find((argument) => argument instanceof HTMLCanvasElement
              && argument.width === 1024 && argument.height === 256);
            if (source) {
              const id = sourceIdentity(source);
              calls.push({
                kind: method,
                context: constructorName,
                argumentCount: args.length,
                sourceId: id,
                sourceIdentity: sources.get(id).identity,
                constructor: source.constructor?.name ?? null,
                width: source.width,
                height: source.height,
              });
            }
          }
          return result;
        },
      });
      restored.push({ prototype, method, descriptor, constructorName });
    };

    for (const constructorName of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      for (const method of ['texImage2D', 'texSubImage2D', 'compileShader', 'linkProgram']) {
        patch(constructorName, method);
      }
    }

    let after;
    let restorationComplete = false;
    try {
      await api.step(60, 1 / 60);
      after = api.cockpitDebug();
    } finally {
      for (let index = restored.length - 1; index >= 0; index -= 1) {
        const entry = restored[index];
        Object.defineProperty(entry.prototype, entry.method, entry.descriptor);
      }
      restorationComplete = restored.every((entry) =>
        Object.getOwnPropertyDescriptor(entry.prototype, entry.method)?.value === entry.descriptor.value);
      api.setSettings({ cameraMode: 'chase' });
      await api.step(1, 1 / 60);
      await api.present();
      api.setDriven(false);
      await new Promise((resolve) => {
        let frames = 30;
        const settle = () => {
          frames -= 1;
          if (frames <= 0) resolve();
          else requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
      });
    }

    if (!after) throw new Error('MFD upload cadence did not produce a final cockpit snapshot.');
    const texImage2D = calls.filter(({ kind }) => kind === 'texImage2D').length;
    const texSubImage2D = calls.filter(({ kind }) => kind === 'texSubImage2D').length;
    return {
      contract: { warmFrames: 1, frames: 60, dt: 1 / 60, expectedRedraws: 20 },
      cameraMode,
      before,
      after,
      mfdUpdatesDelta: after.mfdUpdates - before.mfdUpdates,
      uploads: {
        total: calls.length,
        texImage2D,
        texSubImage2D,
        sources: Array.from(sources.values()),
        calls,
      },
      compileShaderCalls,
      linkProgramCalls,
      instrumentation: {
        patched: restored.map(({ constructorName, method }) => `${constructorName}.${method}`),
        restored: restorationComplete,
      },
    };
  }, { callTimeoutMs: timeoutMs });
}

/**
 * Patch the WebGL entry points after the loader has completed.  The probe lives in page space so
 * it sees calls made by Three.js itself; renderer.info.programs is only a resident-program count
 * and cannot distinguish loader prewarm from a late first-use compile.
 */
async function installColdInstrumentation(page) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate(() => {
    const key = '__LV_PERF_COLD__';
    if (window[key]) return window[key].summary();

    const state = {
      active: false,
      currentFrame: -1,
      currentPhase: window.__LV?.phase?.() ?? null,
      events: [],
      installedAt: performance.now(),
      patchedContexts: [],
    };

    const record = (kind, contextName, detail = null) => {
      if (!state.active) return;
      state.events.push({
        kind,
        context: contextName,
        atMs: Math.round((performance.now() - state.installedAt) * 1_000) / 1_000,
        frame: state.currentFrame,
        phase: window.__LV?.phase?.() ?? state.currentPhase,
        detail,
      });
    };

    const describeShader = (context, shader) => {
      try {
        const source = context.getShaderSource(shader) ?? '';
        const type = context.getShaderParameter(shader, context.SHADER_TYPE);
        let hash = 0x811c9dc5;
        for (let index = 0; index < source.length; index += 1) {
          hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
        }
        return {
          stage: type === context.VERTEX_SHADER ? 'vertex'
            : type === context.FRAGMENT_SHADER ? 'fragment' : String(type),
          shaderType: source.match(/^#define SHADER_TYPE[ \t]+([^\r\n]+)$/m)?.[1]?.trim() ?? null,
          shaderName: source.match(/^#define SHADER_NAME[ \t]+([^\r\n]+)$/m)?.[1]?.trim() ?? null,
          uniforms: [...source.matchAll(/\buniform\s+\w+\s+(\w+)/g)]
            .map((match) => match[1]).filter((name, index, names) => names.indexOf(name) === index)
            .slice(0, 24),
          sourceLength: source.length,
          sourceHash: (hash >>> 0).toString(16).padStart(8, '0'),
        };
      } catch {
        return { stage: 'unknown', shaderType: null, shaderName: null, uniforms: [], sourceLength: null, sourceHash: null };
      }
    };

    const patch = (constructorName) => {
      const Constructor = window[constructorName];
      const prototype = Constructor?.prototype;
      if (!prototype) return;
      let patchedMethods = 0;
      for (const method of ['compileShader', 'linkProgram']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        const original = descriptor.value;
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function instrumentedWebGLCall(...args) {
            const result = Reflect.apply(original, this, args);
            let detail = null;
            if (method === 'compileShader') {
              detail = describeShader(this, args[0]);
            } else {
              try {
                detail = {
                  shaders: (this.getAttachedShaders(args[0]) ?? [])
                    .map((shader) => describeShader(this, shader)),
                };
              } catch {
                detail = { shaders: [] };
              }
            }
            record(method, constructorName, detail);
            return result;
          },
        });
        patchedMethods += 1;
      }
      if (patchedMethods === 2) state.patchedContexts.push(constructorName);
    };

    patch('WebGLRenderingContext');
    patch('WebGL2RenderingContext');
    state.reset = () => {
      state.events.length = 0;
      state.installedAt = performance.now();
      state.currentFrame = 0;
      state.currentPhase = window.__LV?.phase?.() ?? null;
      state.active = true;
    };
    state.summary = () => ({
      installed: state.patchedContexts.length > 0,
      patchedContexts: [...state.patchedContexts],
      installedAt: Math.round(state.installedAt * 1_000) / 1_000,
    });
    window[key] = state;
    return state.summary();
  });
}

/**
 * Measure presented-frame intervals from a chase frame immediately before the cockpit transition.
 * rAF timestamps include missed refresh intervals caused by a main-thread shader stall; timing a
 * tight `step(1)` loop instead measures GPU queue backpressure and produced unrelated 50-60 ms
 * spikes on otherwise smooth runs. The existing ten-second live-rAF profile still follows this.
 */
async function collectColdWindow(page, timeoutMs) {
  verify(page, 'Browser page is unavailable.');
  return page.evaluate(async ({ callTimeoutMs, coldMaxFrameMs }) => {
    const api = window.__LV;
    const state = window.__LV_PERF_COLD__;
    if (!api || !state) throw new Error('Cold-start instrumentation is unavailable.');

    // Present one already-configured chase frame, then make that exact rAF timestamp the baseline
    // for the first cockpit interval. Resetting here excludes title variants compiled while the
    // quality baseline settled but includes every call caused by the camera/run transition.
    const baselineTimestamp = await new Promise((resolve) => requestAnimationFrame(resolve));
    state.reset();
    api.setDriven(false);
    api.setFixedTimestep(1 / 60);
    api.setSettings({ cameraMode: 'cockpit' });
    api.startRun({ skipIntro: true });
    api.setAutopilot(true, { skill: 1 });

    const timeline = [];
    let flyingFrames = 0;
    let previousTimestamp = baselineTimestamp;
    let compileSeen = 0;
    let linkSeen = 0;

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          settled = true;
          reject(new Error(`Cold cockpit window timed out after ${callTimeoutMs} ms.`));
        }, callTimeoutMs);

        const sample = (timestamp) => {
          if (settled) return;
          try {
            const phase = api.phase();
            if (phase === 'finished') {
              throw new Error('Run finished before the cold cockpit window collected 120 flying frames.');
            }
            if (timeline.length >= 720) {
              throw new Error('Run did not provide 120 flying frames within 720 presented frames.');
            }

            const index = timeline.length;
            const compileTotal = state.events.filter((event) => event.kind === 'compileShader').length;
            const linkTotal = state.events.filter((event) => event.kind === 'linkProgram').length;
            const frameMs = timestamp - previousTimestamp;
            timeline.push({
              frame: index,
              phase,
              frameMs: Math.round(frameMs * 1_000) / 1_000,
              compileShaderCalls: compileTotal - compileSeen,
              linkProgramCalls: linkTotal - linkSeen,
            });
            previousTimestamp = timestamp;
            compileSeen = compileTotal;
            linkSeen = linkTotal;
            state.currentFrame = index + 1;
            state.currentPhase = phase;
            if (phase === 'flying') flyingFrames += 1;

            if (flyingFrames >= 120) {
              settled = true;
              window.clearTimeout(timer);
              resolve();
            } else {
              requestAnimationFrame(sample);
            }
          } catch (error) {
            settled = true;
            window.clearTimeout(timer);
            reject(error);
          }
        };
        requestAnimationFrame(sample);
      });
    } finally {
      state.active = false;
      state.currentFrame = -1;
      state.currentPhase = api.phase();
    }
    const compileShaderCalls = state.events.filter((event) => event.kind === 'compileShader').length;
    const linkProgramCalls = state.events.filter((event) => event.kind === 'linkProgram').length;
    const maxFrame = timeline.reduce(
      (maximum, frame) => frame.frameMs > maximum.frameMs ? frame : maximum,
      { frame: -1, frameMs: 0 },
    );

    return {
      contract: {
        begins: 'chase-to-cockpit transition after the quality baseline presented',
        ends: '120th flying frame',
        maxCompileShaderCalls: 0,
        maxLinkProgramCalls: 0,
        maxFrameMs: coldMaxFrameMs,
      },
      instrumentation: state.summary(),
      presentedFrames: timeline.length,
      flyingFrames,
      compileShaderCalls,
      linkProgramCalls,
      maxFrameMs: maxFrame.frameMs,
      maxFrameIndex: maxFrame.frame,
      events: state.events.map((event) => ({ ...event })),
      timeline,
    };
  }, { callTimeoutMs: timeoutMs, coldMaxFrameMs: COLD_COCKPIT_MAX_FRAME_MS });
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
