#!/usr/bin/env node

import { mkdir, rm } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import {
  callHarness,
  finiteNumber,
  runManagedSuite,
  verify,
} from './runtime.mjs';
import { decodePng } from './pngstats.mjs';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'phase',
  'setInput',
  'seekCourse',
  'vantage',
  'vantages',
  'pose',
  'shipDebug',
  'step',
  'present',
  'setDriven',
  'profile',
  'settings',
  'setSettings',
  'setPaused',
  'pauseMenu',
  'setFixedTimestep',
  'errors',
];

const FIXED_DT = 1 / 60;
// Frozen before this assertion existed: the current 2026-08-21 candidate measured a normalized
// shell chroma gap of 0.0906. Claude recommended retaining 60–70% of the frozen readable target;
// 0.059 is 65.1%. The radial target is independently authored from the ~0.47 inner/outer radius
// ratio, with enough room for post-FX bloom: expect about 0.48 and accept only 0.35–0.65.
const FROZEN_CHROMA_GAP = 0.0906;
const MIN_CHROMA_GAP = 0.059;
const RADIAL_BLUE_THRESHOLD = 0.10;
const RADIAL_CROSSING_BOUNDS = [0.35, 0.65];
const RADIAL_BIN_WIDTH = 0.05;
const PLUME_SCALAR_KEYS = [
  'power', 'boost', 'length', 'width', 'coreStretch', 'coreGain',
  'ignite', 'release', 'cells', 'cellFreq', 'glowPower',
];
// `length` includes authored absolute-time flutter, so resetting the deterministic clock changes
// only that phase. Every state/envelope scalar must continue exactly from the unrewound control.
const REWIND_CONTINUATION_KEYS = PLUME_SCALAR_KEYS.filter((key) => key !== 'length');
const EXPECTED = {
  drawCalls: 4,
  materials: 4,
  triangles: 25_396,
  plumeTriangles: 112,
  anchors: [
    { position: [-2.55, -0.14, 7.5], radius: 0.58 },
    { position: [2.55, -0.14, 7.5], radius: 0.58 },
  ],
};

await runManagedSuite({
  suite: 'boost-vfx-probe',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runBoostVfxProbe,
});

async function runBoostVfxProbe({ report, session, options }) {
  const page = session.page;
  const imageDirectory = resolve(options.out, 'screenshots');
  await rm(imageDirectory, { recursive: true, force: true });
  await mkdir(imageDirectory, { recursive: true });

  const sequenceOutcome = await report.check({
    id: 'BOOST.sequence',
    name: 'Exterior boost states are captured deterministically',
    assertion:
      'At the authored drive-side camera, a fixed 1/60 s simulation captures throttle-only, '
      + 'ignition, intermediate, sustained and release frames in that order, with a zero-time '
      + 'chase twin of every state and the ship visible.',
  }, async () => captureSequence(page, options, imageDirectory));

  if (sequenceOutcome.ok) {
    for (const capture of sequenceOutcome.evidence.captures) {
      report.addArtifact('screenshot', capture.path, {
        state: capture.name,
        width: capture.image.width,
        height: capture.image.height,
        bytes: capture.bytes,
      });
    }
  }

  await report.check({
    id: 'BOOST.drive-side-pose',
    name: 'Drive-side is a true lateral exterior view',
    assertion:
      'drive-side exists, uses a 48 degree lens, places the camera predominantly along the '
      + "ship's local right axis, and keeps the detected plume away from every frame edge.",
  }, async () => {
    const evidence = unwrap(sequenceOutcome);
    const pose = evidence.pose;
    const cameraOffset = subtract(pose.camera.position, pose.position);
    const shipRight = rotateVector([1, 0, 0], pose.quaternion);
    const lateralDot = Math.abs(dot(normalise(cameraOffset), normalise(shipRight)));
    const plume = evidence.pixels.sideRoi;
    const pixelViewport = evidence.pixels.viewport;
    const marginX = Math.min(plume.minX, pixelViewport.width - 1 - plume.maxX);
    const marginY = Math.min(plume.minY, pixelViewport.height - 1 - plume.maxY);
    const result = {
      vantageNames: evidence.vantageNames,
      camera: pose.camera,
      cameraDistance: length(cameraOffset),
      pixelViewport,
      lateralDot,
      plumeBounds: plume,
      edgeMargins: { x: marginX, y: marginY },
    };
    verify(evidence.vantageNames.includes('drive-side'), 'drive-side is not registered.', result);
    verify(Math.abs(pose.camera.fov - 48) <= 0.1, `drive-side FOV is ${pose.camera.fov}, expected 48.`, result);
    verify(lateralDot >= 0.80, `Camera is not lateral enough (right-axis dot ${lateralDot.toFixed(3)}).`, result);
    verify(length(cameraOffset) >= 20, 'Drive-side camera is too close to frame the exhaust.', result);
    verify(marginX >= pixelViewport.width * 0.025 && marginY >= pixelViewport.height * 0.025,
      'Detected boost plume is clipped by the drive-side frame.', result);
    return result;
  });

  await report.check({
    id: 'BOOST.topology',
    name: 'Boost detail stays inside the exterior render budget',
    assertion:
      'The ship remains exactly four draws and four materials, totals 25,396 triangles, assigns '
      + '112 triangles to the merged paired plume, and preserves both nozzle anchors and radii.',
  }, async () => {
    const evidence = unwrap(sequenceOutcome);
    const states = evidence.captures.map((capture) => capture.debug);
    const topology = states.map(compactTopology);
    for (const state of states) {
      verify(state.visible === true, 'Exterior ship was hidden during a drive-side capture.', topology);
      verify(state.drawCalls === EXPECTED.drawCalls, `Ship uses ${state.drawCalls} draws, expected 4.`, topology);
      verify(state.materials === EXPECTED.materials, `Ship uses ${state.materials} materials, expected 4.`, topology);
      verify(state.triangles === EXPECTED.triangles, `Ship has ${state.triangles} triangles, expected 25,396.`, topology);
      verify(state.plumeTriangles === EXPECTED.plumeTriangles,
        `Paired plume has ${state.plumeTriangles} triangles, expected 112.`, topology);
      verifyAnchors(state.nozzleAnchors, topology);
    }
    return { expected: EXPECTED, observed: topology };
  });

  await report.check({
    id: 'BOOST.state-response',
    name: 'Boost plume has authored ignition, release and restart response',
    assertion:
      'Debug scalars prove rising boost, a boost-only shock-cell contribution, a distinct '
      + 'ignition impulse, a distinct release impulse, finite positive plume dimensions, exact '
      + 'driven-clock rewind and pause isolation, and clean countdown and skip-intro restarts '
      + 'after sustained boost.',
  }, async () => {
    const evidence = unwrap(sequenceOutcome);
    const states = Object.fromEntries(evidence.captures.map((capture) => [capture.name, capture.debug.plume]));
    const throttle = states['throttle-only'];
    const ignition = states.ignition;
    const intermediate = states.intermediate;
    const sustained = states.sustained;
    const release = states.release;
    verify(Object.values(states).every((state) => PLUME_SCALAR_KEYS.every((key) => finiteNumber(state[key]))),
      'A plume debug scalar is missing or non-finite.', states);
    verify(Object.values(states).every((state) => state.length > 0 && state.width > 0 && state.coreStretch > 0),
      'A plume dimension is not positive.', states);
    verify(throttle.boost <= 0.01 && throttle.cells <= 0.01,
      'Throttle-only state contains boost-only energy.', states);
    verify(ignition.boost > throttle.boost && intermediate.boost > ignition.boost
      && sustained.boost > intermediate.boost && sustained.boost >= 0.95,
    'Boost blend does not rise monotonically to a sustained state.', states);
    verify(ignition.ignite >= 0.08 && ignition.ignite > intermediate.ignite
      && ignition.ignite > sustained.ignite,
    'Ignition state has no distinct leading-edge impulse.', states);
    verify(release.release >= 0.08 && release.release > ignition.release
      && release.release > sustained.release,
    'Release state has no distinct shutdown impulse.', states);
    verify(sustained.cells >= 0.2 && sustained.cells > throttle.cells,
      'Shock-cell contribution does not activate under sustained boost.', states);
    verify(release.boost < sustained.boost, 'Boost blend did not begin releasing.', states);
    const sameTimeTwins = {};
    for (const name of ['throttle-only', 'ignition', 'intermediate', 'sustained', 'release']) {
      const side = states[name];
      const chase = states[`${name}-chase`];
      sameTimeTwins[name] = Object.fromEntries(PLUME_SCALAR_KEYS.map((key) => [key, {
        driveSide: side[key],
        chase: chase[key],
        delta: Math.abs(side[key] - chase[key]),
      }]));
      verify(PLUME_SCALAR_KEYS.every((key) => Math.abs(side[key] - chase[key]) <= 1e-9),
        `Zero-time chase render changed the ${name} plume scalar state.`, { states, sameTimeTwins });
    }
    const drivenRewindIsolation = await verifyDrivenRewindIsolation(page, options);
    const pauseIsolation = await verifyPauseIsolation(page, options);
    const restartIsolation = await verifyRestartIsolation(page, options);
    return { states, sameTimeTwins, drivenRewindIsolation, pauseIsolation, restartIsolation };
  });

  await report.check({
    id: 'BOOST.pixel-hierarchy',
    name: 'Plume pixels read as a hot cyan core inside a restrained sheath',
    assertion:
      'Projected, non-overlapping mid-plume shell annuli preserve a normalized blue-minus-red '
      + 'chroma gap of at least 0.059, cross into blue between 0.35R and 0.65R, avoid clipped '
      + 'throttle pixels, and keep the authored ignition-to-release brightness order.',
  }, async () => {
    const evidence = unwrap(sequenceOutcome);
    const pixels = evidence.pixels;
    verify(pixels.candidatePixels >= 120,
      `Only ${pixels.candidatePixels} plume-change pixels were detected.`, pixels);
    verify(pixels.corePixels >= 20 && pixels.sheathPixels >= 20,
      'Detected plume does not contain enough core and sheath samples.', pixels);
    verify(pixels.chromaGap >= MIN_CHROMA_GAP,
      `Sheath/core normalized chroma gap is ${pixels.chromaGap.toFixed(3)}, expected at least ${MIN_CHROMA_GAP}.`, pixels);
    verify(finiteNumber(pixels.radialCrossing),
      `No outward normalized B-R=${RADIAL_BLUE_THRESHOLD.toFixed(2)} crossing was detected.`, pixels);
    verify(pixels.radialCrossing >= RADIAL_CROSSING_BOUNDS[0]
      && pixels.radialCrossing <= RADIAL_CROSSING_BOUNDS[1],
    `Blue boundary is ${pixels.radialCrossing.toFixed(3)}R, expected ${RADIAL_CROSSING_BOUNDS[0]}–${RADIAL_CROSSING_BOUNDS[1]}R.`, pixels);
    verify(pixels.meanNormalizedBlueMinusRed >= 0,
      `Boost plume trends red (mean normalized B-R ${pixels.meanNormalizedBlueMinusRed.toFixed(3)}).`, pixels);
    verify(pixels.throttleClippedPixels === 0,
      `${pixels.throttleClippedPixels} throttle-only plume pixels clip at 8-bit white.`, pixels);
    verify(pixels.clipping.sustained.sheath <= 0.01,
      `Sustained sheath clips ${(pixels.clipping.sustained.sheath * 100).toFixed(2)}% of samples.`, pixels);
    verify(pixels.clipping.sustained.core <= 0.05,
      `Sustained core clips ${(pixels.clipping.sustained.core * 100).toFixed(2)}% of samples.`, pixels);
    verify(pixels.brightness.sustained > pixels.brightness['throttle-only'] + 0.004,
      'Sustained boost is not visibly brighter than throttle-only in the plume core.', pixels);
    verify(pixels.brightness.ignition > pixels.brightness.intermediate
      && pixels.brightness.intermediate > pixels.brightness.sustained
      && pixels.brightness.sustained > pixels.brightness.release
      && pixels.brightness.release > pixels.brightness['throttle-only'],
    'Masked core p90 does not follow ignition > intermediate > sustained > release > throttle.', pixels);
    return pixels;
  });

  await report.check({
    id: 'BOOST.no-late-shaders',
    name: 'First boost and release perform no late shader work',
    assertion:
      'After the throttle-only exterior frame is presented, the first ignition through release '
      + 'performs zero WebGL compileShader and zero linkProgram calls.',
  }, async () => {
    const evidence = unwrap(sequenceOutcome).shaderInstrumentation;
    verify(evidence.installed === true, 'WebGL shader instrumentation was not installed.', evidence);
    verify(evidence.compileShaderCalls === 0,
      `${evidence.compileShaderCalls} shader compile calls occurred after throttle-only presentation.`, evidence);
    verify(evidence.linkProgramCalls === 0,
      `${evidence.linkProgramCalls} program link calls occurred after throttle-only presentation.`, evidence);
    return evidence;
  });

  const performanceOutcome = await capture(() => collectPerformance(page, options));
  await report.check({
    id: 'BOOST.performance',
    name: 'Visible sustained boost preserves exterior frame pacing',
    assertion:
      `At deviceScaleFactor ${options.deviceScaleFactor}, short live-rAF drive-side samples keep `
      + 'mean <= 16.9 ms, p95 <= 20 ms, max <= 40 ms and renderScale >= 0.58. When host load and '
      + 'render scales are comparable, sustained boost loses less than 1.5 fps versus throttle-only.',
  }, async () => {
    const evidence = unwrap(performanceOutcome);
    for (const [name, sample] of Object.entries({ baseline: evidence.baseline, boost: evidence.boost })) {
      verify(sample.meanFrameMs <= 16.9,
        `${name} mean ${sample.meanFrameMs.toFixed(2)} ms exceeds 16.9 ms.`, evidence);
      verify(sample.p95FrameMs <= 20,
        `${name} p95 ${sample.p95FrameMs.toFixed(2)} ms exceeds 20 ms.`, evidence);
      verify(sample.maxFrameMs <= 40,
        `${name} max ${sample.maxFrameMs.toFixed(2)} ms exceeds 40 ms.`, evidence);
      verify(sample.renderScale >= 0.58,
        `${name} renderScale fell to ${sample.renderScale.toFixed(3)}.`, evidence);
    }
    if (evidence.hostComparable) {
      verify(evidence.fpsLoss < 1.5,
        `Sustained boost lost ${evidence.fpsLoss.toFixed(2)} fps on a comparable host window.`, evidence);
    }
    return evidence;
  });
}

async function captureSequence(page, options, imageDirectory) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setSettings', [{
    quality: options.quality,
    renderScale: 1,
    showFps: false,
    cameraMode: 'chase',
  }]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setPaused', [false]);
  await callHarness(page, 'seekCourse', [0.34]);
  await callHarness(page, 'vantage', ['drive-side']);
  await page.evaluate(() => { document.documentElement.dataset.lvCapture = '1'; });

  const captures = [];
  await callHarness(page, 'setInput', [{ throttle: 1, boost: false }]);
  await callHarness(page, 'step', [119, FIXED_DT], options.timeoutMs);
  await resetDriveSideAndStep(page, options, 1);
  captures.push(await captureFrame(page, options, imageDirectory, 'throttle-only'));
  captures.push(await captureChaseTwin(page, options, imageDirectory, 'throttle-only'));

  const install = await installShaderInstrumentation(page);

  await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
  await resetDriveSideAndStep(page, options, 1);
  captures.push(await captureFrame(page, options, imageDirectory, 'ignition'));
  captures.push(await captureChaseTwin(page, options, imageDirectory, 'ignition'));
  await callHarness(page, 'step', [7, FIXED_DT], options.timeoutMs);
  await resetDriveSideAndStep(page, options, 1);
  captures.push(await captureFrame(page, options, imageDirectory, 'intermediate'));
  captures.push(await captureChaseTwin(page, options, imageDirectory, 'intermediate'));
  await callHarness(page, 'step', [89, FIXED_DT], options.timeoutMs);
  await resetDriveSideAndStep(page, options, 1);
  captures.push(await captureFrame(page, options, imageDirectory, 'sustained'));
  captures.push(await captureChaseTwin(page, options, imageDirectory, 'sustained'));

  await callHarness(page, 'setInput', [{ throttle: 1, boost: false }]);
  await resetDriveSideAndStep(page, options, 2);
  captures.push(await captureFrame(page, options, imageDirectory, 'release'));
  captures.push(await captureChaseTwin(page, options, imageDirectory, 'release'));

  const shaderInstrumentation = await shaderInstrumentationSummary(page, install);
  const vantageNames = await callHarness(page, 'vantages');
  const pose = captures.find((capture) => capture.name === 'release').pose;
  const pixels = analyseSequence(captures);
  return {
    fixedTimestep: FIXED_DT,
    viewport: options.viewport,
    deviceScaleFactor: options.deviceScaleFactor,
    vantageNames,
    pose,
    captures: captures.map(({ decoded: _decoded, ...capture }) => capture),
    pixels,
    shaderInstrumentation,
  };
}

async function verifyDrivenRewindIsolation(page, options) {
  const evidence = {
    transition: 'setDriven(false) then setDriven(true) in one browser task',
    continuationTolerance: 1e-9,
    comparedContinuationScalars: REWIND_CONTINUATION_KEYS,
    excludedTimePhaseScalar: 'length',
    states: {},
  };

  for (const stateName of ['sustained', 'ignition', 'release']) {
    const state = {
      controlBefore: await prepareDrivenRewindState(page, options, stateName),
      controlNext: null,
      replayBefore: null,
      immediate: null,
      stepped: null,
      comparisons: { replay: null, immediate: null, steppedPose: null, steppedPlume: null },
    };
    evidence.states[stateName] = state;
    verifyDrivenRewindSetup(stateName, state.controlBefore, evidence);
    await callHarness(page, 'step', [1, FIXED_DT], options.timeoutMs);
    state.controlNext = await pauseSnapshot(page);

    state.replayBefore = await prepareDrivenRewindState(page, options, stateName);
    state.comparisons.replay = verifyExactPauseSnapshot(
      state.controlBefore,
      state.replayBefore,
      `${stateName} driven-rewind replay diverged before the clock transition.`,
      evidence,
    );

    // Both methods are synchronous. Invoke them in one browser task so a live rAF cannot advance
    // physics between ownership release and reacquisition; only the harness clocks are rewound.
    await page.evaluate(() => {
      window.__LV.setDriven(false);
      window.__LV.setDriven(true);
    });
    state.immediate = await pauseSnapshot(page);
    state.comparisons.immediate = verifyExactPauseSnapshot(
      state.replayBefore,
      state.immediate,
      `${stateName} driven clock rewind changed the immediate transient baseline.`,
      evidence,
    );

    await callHarness(page, 'step', [1, FIXED_DT], options.timeoutMs);
    state.stepped = await pauseSnapshot(page);
    state.comparisons.steppedPose = comparePhysicalSnapshots(state.controlNext, state.stepped);
    verify(state.comparisons.steppedPose.exact,
      `${stateName} driven clock rewind changed the next physical frame.`, evidence);
    state.comparisons.steppedPlume = compareRewindContinuation(
      state.controlNext.plume,
      state.stepped.plume,
      evidence.continuationTolerance,
    );
    verify(state.comparisons.steppedPlume.withinTolerance,
      `${stateName} driven clock rewind changed the next plume envelope.`, evidence);
  }
  return evidence;
}

async function prepareDrivenRewindState(page, options, stateName) {
  await callHarness(page, 'setDriven', [false]);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setInput', [null]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setPaused', [false]);

  if (stateName === 'ignition') {
    await callHarness(page, 'setInput', [{ throttle: 1, boost: false }]);
    await callHarness(page, 'step', [60, FIXED_DT], options.timeoutMs);
    await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
    await callHarness(page, 'step', [1, FIXED_DT], options.timeoutMs);
  } else {
    await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
    await callHarness(page, 'step', [100, FIXED_DT], options.timeoutMs);
    if (stateName === 'release') {
      await callHarness(page, 'setInput', [{ throttle: 1, boost: false }]);
      await callHarness(page, 'step', [6, FIXED_DT], options.timeoutMs);
    }
  }
  return pauseSnapshot(page);
}

function verifyDrivenRewindSetup(stateName, snapshot, evidence) {
  verify(snapshot.phase === 'flying',
    `${stateName} driven-rewind setup entered ${snapshot.phase}.`, evidence);
  if (stateName === 'sustained') {
    verify(snapshot.plume.boost >= 0.95 && snapshot.plume.cells >= 0.2,
      'Sustained driven-rewind setup did not reach full boost.', evidence);
  } else if (stateName === 'ignition') {
    verify(snapshot.plume.ignite >= 0.5 && snapshot.plume.release <= 1e-9,
      'Ignition driven-rewind setup has no leading-edge envelope.', evidence);
  } else {
    verify(snapshot.plume.release >= 0.2 && snapshot.plume.ignite <= 1e-9,
      'Release driven-rewind setup has no decaying shutdown envelope.', evidence);
  }
}

function compareRewindContinuation(expected, actual, tolerance) {
  const scalarDeltas = Object.fromEntries(REWIND_CONTINUATION_KEYS.map((key) => [
    key,
    Math.abs(expected[key] - actual[key]),
  ]));
  return {
    tolerance,
    scalarDeltas,
    lengthPhaseDelta: Math.abs(expected.length - actual.length),
    withinTolerance: Object.values(scalarDeltas).every((delta) => delta <= tolerance),
  };
}

async function verifyPauseIsolation(page, options) {
  const evidence = {
    pausedFrames: 60,
    fixedTimestep: FIXED_DT,
    phaseModel: 'pause is orthogonal to the flying phase',
    controlBefore: null,
    controlNext: null,
    replayBefore: null,
    paused: null,
    resumed: null,
    comparisons: { replay: null, paused: null, resumed: null },
  };

  // First record the one-frame continuation from a clean, deterministic boosted state.
  evidence.controlBefore = await prepareBoostReplay(page, options);
  verify(evidence.controlBefore.phase === 'flying' && evidence.controlBefore.plume.boost >= 0.95,
    'Pause-isolation control did not reach sustained boost.', evidence);
  await callHarness(page, 'step', [1, FIXED_DT], options.timeoutMs);
  evidence.controlNext = await pauseSnapshot(page);

  // Recreate that exact state, then advance renderer frames through the actual player pause path.
  evidence.replayBefore = await prepareBoostReplay(page, options);
  evidence.comparisons.replay = verifyExactPauseSnapshot(evidence.controlBefore, evidence.replayBefore,
    'Boost replay diverged before pause.', evidence);
  await callHarness(page, 'pauseMenu', [true]);
  await callHarness(page, 'step', [evidence.pausedFrames, FIXED_DT], options.timeoutMs);
  evidence.paused = await pauseSnapshot(page);
  verify(evidence.paused.phase === 'flying',
    `Pause changed the orthogonal run phase to ${evidence.paused.phase}.`, evidence);
  evidence.comparisons.paused = verifyExactPauseSnapshot(evidence.replayBefore, evidence.paused,
    'Player pause advanced physical or plume state.', evidence);

  // One frame after resume must equal the no-pause control's one-frame continuation. This proves
  // the pause duration did not leak through a visual clock or a smoothing accumulator.
  await callHarness(page, 'pauseMenu', [false]);
  await callHarness(page, 'step', [1, FIXED_DT], options.timeoutMs);
  evidence.resumed = await pauseSnapshot(page);
  evidence.comparisons.resumed = verifyExactPauseSnapshot(evidence.controlNext, evidence.resumed,
    'Resume did not continue from the exact pre-pause state.', evidence);
  return evidence;
}

async function prepareBoostReplay(page, options) {
  // Taking driven ownership from false resets both deterministic clocks. Do this before beginRun
  // so each arm starts from the same visual and physical origin despite prior probe activity.
  await callHarness(page, 'setDriven', [false]);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setInput', [null]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setPaused', [false]);
  await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
  await callHarness(page, 'step', [100, FIXED_DT], options.timeoutMs);
  return pauseSnapshot(page);
}

async function pauseSnapshot(page) {
  const [phase, debug, pose] = await Promise.all([
    callHarness(page, 'phase'),
    callHarness(page, 'shipDebug'),
    callHarness(page, 'pose'),
  ]);
  return {
    phase,
    plume: debug.plume,
    pose: {
      position: pose.position,
      quaternion: pose.quaternion,
      velocity: pose.velocity,
      angularVelocity: pose.angularVelocity,
      forward: pose.forward,
    },
  };
}

function verifyExactPauseSnapshot(expected, actual, message, evidence) {
  const comparison = {
    phaseExact: expected.phase === actual.phase,
    plumeDeltas: Object.fromEntries(PLUME_SCALAR_KEYS.map((key) => [
      key, Math.abs(expected.plume[key] - actual.plume[key]),
    ])),
    poseDeltas: Object.fromEntries(Object.keys(expected.pose).map((key) => [
      key,
      expected.pose[key].map((value, index) => Math.abs(value - actual.pose[key][index])),
    ])),
  };
  comparison.plumeExact = Object.values(comparison.plumeDeltas).every((delta) => delta === 0);
  comparison.poseExact = Object.values(comparison.poseDeltas)
    .every((deltas) => deltas.every((delta) => delta === 0));
  comparison.exact = comparison.phaseExact && comparison.plumeExact && comparison.poseExact;
  verify(comparison.exact, message, {
    ...evidence,
    comparison,
  });
  return comparison;
}

function comparePhysicalSnapshots(expected, actual) {
  const comparison = {
    phaseExact: expected.phase === actual.phase,
    poseDeltas: Object.fromEntries(Object.keys(expected.pose).map((key) => [
      key,
      expected.pose[key].map((value, index) => Math.abs(value - actual.pose[key][index])),
    ])),
  };
  comparison.poseExact = Object.values(comparison.poseDeltas)
    .every((deltas) => deltas.every((delta) => delta === 0));
  comparison.exact = comparison.phaseExact && comparison.poseExact;
  return comparison;
}

async function verifyRestartIsolation(page, options) {
  const evidence = { sustained: null, countdown: null, skipIntro: null };

  // Replay a dedicated boost arm rather than relying on the earlier release capture. The bug
  // only appears when beginRun interrupts a still-sustained visual blend.
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setPaused', [false]);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
  await callHarness(page, 'step', [100, FIXED_DT], options.timeoutMs);
  evidence.sustained = await restartSnapshot(page);
  verify(evidence.sustained.phase === 'flying'
    && evidence.sustained.plume.boost >= 0.95
    && evidence.sustained.plume.cells >= 0.2,
  'Restart-isolation setup did not reach sustained boost.', evidence);

  // A real restart clears physical key state. Clear the harness override before invoking the same
  // beginRun path so this measures inherited renderer state, not a deliberately held boost input.
  await callHarness(page, 'setInput', [null]);
  await callHarness(page, 'startRun', [{ skipIntro: false }]);
  await callHarness(page, 'step', [1, FIXED_DT], options.timeoutMs);
  evidence.countdown = await restartSnapshot(page);
  verify(evidence.countdown.phase === 'countdown',
    `Normal restart entered ${evidence.countdown.phase}, expected countdown.`, evidence);
  verifyCleanRestartPlume(evidence.countdown.plume, 'countdown', evidence);

  // The automation-only skip path must share the same reset contract and begin clean in flight.
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'step', [1, FIXED_DT], options.timeoutMs);
  evidence.skipIntro = await restartSnapshot(page);
  verify(evidence.skipIntro.phase === 'flying',
    `Skip-intro restart entered ${evidence.skipIntro.phase}, expected flying.`, evidence);
  verifyCleanRestartPlume(evidence.skipIntro.plume, 'skip-intro', evidence);

  return evidence;
}

async function restartSnapshot(page) {
  const [phase, debug] = await Promise.all([
    callHarness(page, 'phase'),
    callHarness(page, 'shipDebug'),
  ]);
  return { phase, plume: debug.plume };
}

function verifyCleanRestartPlume(plume, label, evidence) {
  for (const key of ['boost', 'ignite', 'release', 'cells']) {
    verify(Math.abs(plume[key]) <= 1e-9,
      `${label} restart inherited plume ${key}=${plume[key]}.`, evidence);
  }
}

async function resetDriveSideAndStep(page, options, frames) {
  // Moving hazards can enter the camera-clearance bubble during a long deterministic state
  // settle and push an authored pose away from its anchor. Reset their authored motion before
  // every evidence frame so pixel deltas compare VFX state, not a different composition.
  await callHarness(page, 'vantage', ['drive-side']);
  await callHarness(page, 'step', [frames, FIXED_DT], options.timeoutMs);
}

async function captureChaseTwin(page, options, imageDirectory, stateName) {
  await callHarness(page, 'vantage', ['chase']);
  // Render the alternate camera at the exact same world clock and VFX scalar state. Explicit zero
  // is accepted by the harness and exercises the ShipModel's same-time update path as well.
  await callHarness(page, 'step', [1, 0], options.timeoutMs);
  return captureFrame(page, options, imageDirectory, `${stateName}-chase`);
}

async function captureFrame(page, options, imageDirectory, name) {
  await callHarness(page, 'present', [], options.timeoutMs);
  const [debug, pose] = await Promise.all([
    callHarness(page, 'shipDebug'),
    callHarness(page, 'pose'),
  ]);
  const path = resolve(imageDirectory, `${name}.png`);
  const buffer = await page.screenshot({
    path,
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  });
  const decoded = decodePng(buffer);
  const expectedWidth = Math.round(options.viewport.width * options.deviceScaleFactor);
  const expectedHeight = Math.round(options.viewport.height * options.deviceScaleFactor);
  verify(decoded.width === expectedWidth && decoded.height === expectedHeight,
    `Capture ${name} has ${decoded.width}x${decoded.height}, expected ${expectedWidth}x${expectedHeight} at DPR ${options.deviceScaleFactor}.`);
  return { name, path, bytes: buffer.length, image: { width: decoded.width, height: decoded.height }, debug, pose, decoded };
}

/**
 * Projects the debug nozzle anchors into the authored camera, then measures the core and sheath
 * only along those two segments. A global boost changes exposure, bloom and moving debris across
 * the whole frame; a largest-difference blob therefore measures the nebula, not the exhaust.
 */
function analyseSequence(captures) {
  const chaseCaptures = captures.filter((capture) => capture.name.endsWith('-chase'));
  const samples = Object.fromEntries(chaseCaptures.map((capture) => [
    capture.name.slice(0, -'-chase'.length),
    sampleRearEngineRoi(capture),
  ]));
  const throttle = samples['throttle-only'];
  const sustained = samples.sustained;
  const coreP90 = percentile(sustained.coreMasked.map(luminance).sort((a, b) => a - b), 0.90);
  const sheathP90 = percentile(sustained.sheathMasked.map(luminance).sort((a, b) => a - b), 0.90);
  const coreChroma = percentile(
    sustained.coreMasked.map(normalizedBlueMinusRed).sort((a, b) => a - b), 0.50,
  );
  const sheathChroma = percentile(
    sustained.sheathMasked.map(normalizedBlueMinusRed).sort((a, b) => a - b), 0.50,
  );
  // Framing is a camera/geometry contract. Use the unwarped throttle-only side frame; sustained
  // boost intentionally warps post-process pixels away from their pre-post NDC coordinates.
  const sideCapture = captures.find((capture) => capture.name === 'throttle-only');
  const sideRoi = projectionBounds(sideCapture.debug.engineProjection, sideCapture.decoded);
  return {
    sampleStep: 1,
    viewport: { width: sideCapture.decoded.width, height: sideCapture.decoded.height },
    candidatePixels: sustained.coreMasked.length + sustained.sheathMasked.length,
    corePixels: sustained.coreMasked.length,
    sheathPixels: sustained.sheathMasked.length,
    coreP90: round(coreP90),
    sheathP90: round(sheathP90),
    // Retain the old luminance ratio as diagnostic evidence only. Bloom deliberately mixes core
    // energy into the outer annulus, so it is not a defensible pass/fail axis after post FX.
    coreSheathRatio: round(coreP90 / Math.max(sheathP90, 1 / 255)),
    meanBlueMinusRed: round(average([...sustained.coreMasked, ...sustained.sheathMasked]
      .map(([r, , b]) => b - r))),
    meanNormalizedBlueMinusRed: round(average(
      [...sustained.coreMasked, ...sustained.sheathMasked].map(normalizedBlueMinusRed),
    )),
    coreMedianNormalizedBlueMinusRed: round(coreChroma),
    sheathMedianNormalizedBlueMinusRed: round(sheathChroma),
    chromaGap: round(sheathChroma - coreChroma),
    radialCrossing: sustained.radialCrossing === null ? null : round(sustained.radialCrossing),
    radialProfile: sustained.radialProfile,
    chromaContract: {
      frozenBaselineGap: FROZEN_CHROMA_GAP,
      retainedFraction: round(MIN_CHROMA_GAP / FROZEN_CHROMA_GAP),
      minimumGap: MIN_CHROMA_GAP,
      radialBlueThreshold: RADIAL_BLUE_THRESHOLD,
      radialCrossingBounds: RADIAL_CROSSING_BOUNDS,
      expectedRadialCrossing: 0.48,
      radialBinWidth: RADIAL_BIN_WIDTH,
    },
    throttleClippedPixels: throttle.clippedPixels,
    clipping: {
      throttle: { core: throttle.coreClippedFraction, sheath: throttle.sheathClippedFraction },
      sustained: { core: sustained.coreClippedFraction, sheath: sustained.sheathClippedFraction },
    },
    brightness: Object.fromEntries(Object.entries(samples).map(([name, sample]) => [
      name,
      round(percentile(sample.coreMasked.map(luminance).sort((a, b) => a - b), 0.90)),
    ])),
    roiMethod: 'rear projected mid-plume non-overlapping shell annuli; p90 sRGB luminance diagnostics plus normalized B-R median gap and pooled radial crossing',
    perStateRoi: Object.fromEntries(Object.entries(samples).map(([name, sample]) => [name, sample.bounds])),
    roi: samples.sustained.bounds,
    sideRoi,
  };
}

function sampleRearEngineRoi(capture) {
  const image = capture.decoded;
  const core = [];
  const sheath = [];
  const points = [];
  const radialBins = Array.from(
    { length: Math.ceil(1.05 / RADIAL_BIN_WIDTH) },
    () => [],
  );
  for (const projection of capture.debug.engineProjection) {
    const mid = ndcPixel(projection.sheathMidScreenNdc, image);
    const midRim = ndcPixel(projection.sheathMidRimScreenNdc, image);
    const outerRadius = Math.max(4, distance2(mid, midRim));
    // Both plumes are open CylinderGeometry shells, so the projected centre is empty. At this
    // authored cross-section the inner/outer radius ratio is about 0.45; sample across that shell
    // and leave a clean gap before the outer shell so bloom cannot make one pixel count twice.
    points.push(...[
      [mid[0] - outerRadius, mid[1]],
      [mid[0] + outerRadius, mid[1]],
      [mid[0], mid[1] - outerRadius],
      [mid[0], mid[1] + outerRadius],
    ]);
    core.push(...sampleAnnulus(image, mid, outerRadius, 0.32, 0.56));
    sheath.push(...sampleAnnulus(image, mid, outerRadius, 0.72, 1.05));
    sampleRadialChroma(image, mid, outerRadius, radialBins);
  }
  const signal = ([r, g, b]) => b >= r && g >= r * 0.90 && Math.max(r, g, b) >= 40;
  const coreMasked = core.filter(signal);
  const sheathMasked = sheath.filter(signal);
  const clippedPixels = [...core, ...sheath]
    .filter(([r, g, b]) => Math.max(r, g, b) >= 254).length;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const radialProfile = radialBins.map((values, index) => ({
    radius: round((index + 0.5) * RADIAL_BIN_WIDTH),
    samples: values.length,
    medianNormalizedBlueMinusRed: round(percentile(values.sort((a, b) => a - b), 0.50)),
  }));
  return {
    core,
    sheath,
    coreMasked,
    sheathMasked,
    clippedPixels,
    coreClippedFraction: core.length
      ? core.filter(([r, g, b]) => Math.max(r, g, b) >= 254).length / core.length : 0,
    sheathClippedFraction: sheath.length
      ? sheath.filter(([r, g, b]) => Math.max(r, g, b) >= 254).length / sheath.length : 0,
    radialCrossing: findRadialCrossing(radialProfile),
    radialProfile,
    bounds: {
      minX: Math.floor(Math.min(...xs)),
      minY: Math.floor(Math.min(...ys)),
      maxX: Math.ceil(Math.max(...xs)),
      maxY: Math.ceil(Math.max(...ys)),
    },
  };
}

function sampleRadialChroma(image, centre, outerRadius, bins) {
  const maxRadius = outerRadius * 1.05;
  const minX = Math.max(0, Math.floor(centre[0] - maxRadius));
  const maxX = Math.min(image.width - 1, Math.ceil(centre[0] + maxRadius));
  const minY = Math.max(0, Math.floor(centre[1] - maxRadius));
  const maxY = Math.min(image.height - 1, Math.ceil(centre[1] + maxRadius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const radius = distance2([x + 0.5, y + 0.5], centre) / outerRadius;
      if (radius > 1.05) continue;
      const colour = rgbAt(image, x, y);
      if (Math.max(...colour) < 40) continue;
      const index = Math.min(bins.length - 1, Math.floor(radius / RADIAL_BIN_WIDTH));
      bins[index].push(normalizedBlueMinusRed(colour));
    }
  }
}

function findRadialCrossing(profile) {
  // The cylinders are open, so centre pixels can show blue background. Find the whitest trough
  // inside the plausible core zone, then only accept an outward rise through the blue threshold.
  const coreZone = profile.filter((bin) => bin.radius >= 0.20 && bin.radius <= 0.65 && bin.samples >= 16);
  if (coreZone.length === 0) return null;
  const trough = coreZone.reduce((best, bin) => (
    bin.medianNormalizedBlueMinusRed < best.medianNormalizedBlueMinusRed ? bin : best
  ));
  if (trough.medianNormalizedBlueMinusRed >= RADIAL_BLUE_THRESHOLD) return null;
  let previous = trough;
  for (const bin of profile) {
    if (bin.radius <= trough.radius || bin.samples < 16) continue;
    if (bin.medianNormalizedBlueMinusRed >= RADIAL_BLUE_THRESHOLD) {
      const delta = bin.medianNormalizedBlueMinusRed - previous.medianNormalizedBlueMinusRed;
      if (delta <= 0) return bin.radius;
      const fraction = (RADIAL_BLUE_THRESHOLD - previous.medianNormalizedBlueMinusRed) / delta;
      return previous.radius + (bin.radius - previous.radius) * fraction;
    }
    previous = bin;
  }
  return null;
}

function sampleAnnulus(image, centre, outerRadius, innerScale, outerScale) {
  const result = [];
  const maxRadius = outerRadius * outerScale;
  const minX = Math.max(0, Math.floor(centre[0] - maxRadius));
  const maxX = Math.min(image.width - 1, Math.ceil(centre[0] + maxRadius));
  const minY = Math.max(0, Math.floor(centre[1] - maxRadius));
  const maxY = Math.min(image.height - 1, Math.ceil(centre[1] + maxRadius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = distance2([x + 0.5, y + 0.5], centre);
      if (distance < outerRadius * innerScale || distance > maxRadius) continue;
      result.push(rgbAt(image, x, y));
    }
  }
  return result;
}

function projectionBounds(projections, viewport) {
  const pixels = projections.flatMap((projection) => [
    projection.mouthScreenNdc,
    projection.mouthRimScreenNdc,
    projection.coreScreenNdc,
    projection.coreRimScreenNdc,
    projection.sheathMidScreenNdc,
    projection.sheathMidRimScreenNdc,
    projection.tailScreenNdc,
  ].map((point) => ndcPixel(point, viewport)));
  return {
    minX: Math.floor(Math.min(...pixels.map((point) => point[0]))),
    minY: Math.floor(Math.min(...pixels.map((point) => point[1]))),
    maxX: Math.ceil(Math.max(...pixels.map((point) => point[0]))),
    maxY: Math.ceil(Math.max(...pixels.map((point) => point[1]))),
  };
}

function ndcPixel(ndc, image) {
  return [(ndc[0] + 1) * 0.5 * image.width, (1 - ndc[1]) * 0.5 * image.height];
}

function distance2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

async function installShaderInstrumentation(page) {
  return page.evaluate(() => {
    const key = '__LV_BOOST_SHADER_PROBE__';
    if (window[key]) return window[key].summary();
    const state = { compileShaderCalls: 0, linkProgramCalls: 0, patchedContexts: [] };
    const patch = (constructorName) => {
      const prototype = window[constructorName]?.prototype;
      if (!prototype) return;
      let patched = 0;
      for (const method of ['compileShader', 'linkProgram']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        const original = descriptor.value;
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function instrumentedBoostShaderCall(...args) {
            state[`${method}Calls`] += 1;
            return Reflect.apply(original, this, args);
          },
        });
        patched += 1;
      }
      if (patched === 2) state.patchedContexts.push(constructorName);
    };
    patch('WebGLRenderingContext');
    patch('WebGL2RenderingContext');
    state.summary = () => ({
      installed: state.patchedContexts.length > 0,
      patchedContexts: [...state.patchedContexts],
      compileShaderCalls: state.compileShaderCalls,
      linkProgramCalls: state.linkProgramCalls,
    });
    window[key] = state;
    return state.summary();
  });
}

async function shaderInstrumentationSummary(page, installed) {
  return page.evaluate((fallback) => window.__LV_BOOST_SHADER_PROBE__?.summary?.() ?? fallback, installed);
}

async function collectPerformance(page, options) {
  verify(page, 'Browser page is unavailable.');
  // A full tank sustains about 3.45 s. Each Harness.profile includes a 30-frame warm-up before
  // its timed window, so a longer boost arm would silently spend the tank and measure release.
  // Start each arm from the same fresh deterministic course/camera state so scene position does
  // not masquerade as plume cost.
  const seconds = 1.5;
  await preparePerformanceArm(page, false);
  const loadBefore = loadavg();
  const baseline = await callHarness(page, 'profile', [seconds], Math.max(options.timeoutMs, 10_000));
  const loadMiddle = loadavg();
  await preparePerformanceArm(page, true);
  const boost = await callHarness(page, 'profile', [seconds], Math.max(options.timeoutMs, 10_000));
  const loadAfter = loadavg();
  const processorCount = cpus().length;
  const loadSpread = Math.max(loadBefore[0], loadMiddle[0], loadAfter[0])
    - Math.min(loadBefore[0], loadMiddle[0], loadAfter[0]);
  const scaleDelta = Math.abs(baseline.renderScale - boost.renderScale);
  const sameBuffer = baseline.drawingBufferWidth === boost.drawingBufferWidth
    && baseline.drawingBufferHeight === boost.drawingBufferHeight;
  const hostComparable = loadSpread <= Math.max(1, processorCount * 0.10)
    && scaleDelta <= 0.02 && sameBuffer;
  return {
    framePacing: 'requestAnimationFrame',
    vantage: 'drive-side',
    deviceScaleFactor: options.deviceScaleFactor,
    profileSeconds: seconds,
    processorCount,
    hostLoad: { before: loadBefore, middle: loadMiddle, after: loadAfter, spread: round(loadSpread) },
    scaleDelta: round(scaleDelta),
    sameBuffer,
    hostComparable,
    comparisonAssertionApplied: hostComparable,
    fpsLoss: round(baseline.fps - boost.fps),
    baseline,
    boost,
  };
}

async function preparePerformanceArm(page, boost) {
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setPaused', [false]);
  await callHarness(page, 'setDriven', [false]);
  await callHarness(page, 'setFixedTimestep', [null]);
  await callHarness(page, 'vantage', ['drive-side']);
  await callHarness(page, 'setInput', [{ throttle: 1, boost }]);
}

function verifyAnchors(actual, evidence) {
  verify(Array.isArray(actual) && actual.length === EXPECTED.anchors.length,
    'Nozzle anchor count changed.', evidence);
  const sorted = [...actual].sort((a, b) => a.position[0] - b.position[0]);
  for (let i = 0; i < EXPECTED.anchors.length; i += 1) {
    const want = EXPECTED.anchors[i];
    const got = sorted[i];
    verify(got.position.length === 3 && got.position.every((value, axis) => Math.abs(value - want.position[axis]) <= 1e-6),
      `Nozzle ${i} moved from ${want.position.join(', ')}.`, evidence);
    verify(Math.abs(got.radius - want.radius) <= 1e-6,
      `Nozzle ${i} radius changed from ${want.radius}.`, evidence);
  }
}

function compactTopology(state) {
  return {
    visible: state.visible,
    drawCalls: state.drawCalls,
    materials: state.materials,
    triangles: state.triangles,
    plumeTriangles: state.plumeTriangles,
    nozzleAnchors: state.nozzleAnchors,
  };
}

function unwrap(outcome) {
  if (outcome.ok) return outcome.evidence;
  const error = new Error('Prerequisite boost VFX operation failed; see its check for evidence.');
  error.cause = outcome.error;
  error.evidence = outcome.evidence;
  throw error;
}

async function capture(operation) {
  try {
    return { ok: true, evidence: await operation(), error: null };
  } catch (error) {
    return { ok: false, evidence: error?.evidence ?? null, error };
  }
}

function rgbAt(image, x, y) {
  const px = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const offset = (py * image.width + px) * image.channels;
  return [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]];
}

function luminance([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function normalizedBlueMinusRed([r, , b]) {
  return (b - r) / Math.max(b, 1);
}

function percentile(values, fraction) {
  return values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * fraction)))] ?? 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function subtract(a, b) {
  return a.map((value, index) => value - b[index]);
}

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function length(vector) {
  return Math.hypot(...vector);
}

function normalise(vector) {
  const magnitude = length(vector) || 1;
  return vector.map((value) => value / magnitude);
}

function rotateVector([x, y, z], [qx, qy, qz, qw]) {
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
