import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  callHarness,
  runManagedSuite,
  verify,
} from './runtime.mjs';
import { decodePng, imageStats } from './pngstats.mjs';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'telemetry',
  'phase',
  'setAutopilot',
  'setInput',
  'activeInput',
  'seekCourse',
  'vantage',
  'clearVantage',
  'vantages',
  'vantageSubjects',
  'pose',
  'cameraMode',
  'step',
  'present',
  'setDriven',
  'settings',
  'setSettings',
  'setPaused',
  'setFixedTimestep',
  'errors',
];

await runManagedSuite({
  suite: 'screenshot-matrix',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runScreenshotMatrix,
});

async function runScreenshotMatrix({ report, session, options }) {
  const page = session.page;
  const imageDirectory = resolve(options.out, 'screenshots');
  // Emptied first. This suite used to capture 5 positions x 10 vantages; after that axis was
  // removed the old 50 files stayed on disk alongside the new 10, indistinguishable from current
  // output and captured from a build several commits old.
  await rm(imageDirectory, { recursive: true, force: true });
  await mkdir(imageDirectory, { recursive: true });

  const setupOutcome = await report.check({
    id: 'SCREENSHOT.setup',
    name: 'Deterministic screenshot camera is ready',
    criteria: [],
    assertion: 'The API becomes ready, accepts the requested quality, enters flying at fixed 1/60 s, exposes at least one named vantage, and accepts every requested vantage name.',
  }, async () => prepareMatrix(page, options));

  const cellOutcomes = [];
  if (setupOutcome.ok) {
    const selectedVantages = setupOutcome.evidence.selectedVantages;
    let cellIndex = 0;
    // ONE position per vantage. Every vantage derives its pose from an anchored gate, from the
    // terminus, or from its own fixed course `t` — `seekCourse` does not move any of them. So
    // iterating positions produced the same frame N times while reporting N distinct cells, and
    // a suite that claims fifty shots and takes ten is worse than one that claims ten.
    for (const position of options.positions.slice(0, 1)) {
      for (const vantage of selectedVantages) {
        cellIndex += 1;
        const filename = `${String(cellIndex).padStart(3, '0')}-course-${formatPosition(position)}-${slug(vantage)}.png`;
        const path = resolve(imageDirectory, filename);
        const subject = setupOutcome.evidence.vantageSubjects[vantage] ?? 'ship';
        const outcome = await report.check({
          id: `SCREENSHOT.cell-${String(cellIndex).padStart(3, '0')}`,
          name: `Capture ${vantage} at course ${position}`,
          criteria: [],
          assertion:
      'vantage succeeds through __LV, one fixed simulation frame is presented, simulation is frozen, '
      + 'the vantage subject projects on screen, and the decoded PNG has the requested dimensions, at '
      + 'least 12 distinct luminance levels, a midtone shelf of at least 12% in 0.18-0.45, under 86% '
      + 'shadow, and measurable chroma. The HUD fade is settled before capture. Subject BOUNDS are reported but not asserted: a luminance '
      + 'threshold cannot isolate a hull against a nebula brighter than it is.',
        }, async () => captureCell(page, options, { position, vantage, path, subject }));
        cellOutcomes.push(outcome);
        if (outcome.ok) {
          report.addArtifact('screenshot', path, {
            position,
            vantage,
            width: options.viewport.width,
            height: options.viewport.height,
            bytes: outcome.evidence.bytes,
          });
        }
      }
    }
  }

  await report.check({
    id: 'SCREENSHOT.matrix-complete',
    name: 'Screenshot matrix is complete',
    criteria: [],
    assertion: 'Every named vantage produces one PNG that passes the image assertions; a setup failure is reported instead of silently producing an empty matrix.',
  }, async () => {
    verify(setupOutcome.ok, 'Screenshot setup failed, so no matrix could be captured.', setupOutcome.error);
    const expectedCells = setupOutcome.evidence.selectedVantages.length;
    const failedCells = cellOutcomes.filter((outcome) => !outcome.ok).length;
    const evidence = {
      positions: options.positions.slice(0, 1),
      positionAxisInert: 'Vantage poses are anchored to gates, the terminus, or a fixed course t; seekCourse does not move them.',
      vantages: setupOutcome.evidence.selectedVantages,
      expectedCells,
      capturedCells: cellOutcomes.length - failedCells,
      failedCells,
    };
    verify(cellOutcomes.length === expectedCells, 'Matrix cell count is incomplete.', evidence);
    verify(failedCells === 0, 'One or more screenshot cells failed.', evidence);
    return evidence;
  });

  if (setupOutcome.ok) {
    const cockpitShots = [
      { id: 'forward', name: 'Cockpit forward flight', input: { throttle: 0.72 }, frames: 12 },
      { id: 'banked', name: 'Cockpit banked turn', input: { throttle: 0.72, roll: 0.9 }, frames: 42 },
      { id: 'boost', name: 'Cockpit overdrive', input: { throttle: 1, boost: true }, frames: 90 },
    ];
    for (const shot of cockpitShots) {
      const path = resolve(imageDirectory, `cockpit-${shot.id}.png`);
      const outcome = await report.check({
        id: `SCREENSHOT.cockpit-${shot.id}`,
        name: shot.name,
        criteria: [],
        assertion:
          'The authored-vantage override is cleared, cockpit is the applied camera mode with a '
          + 'sub-0.25 m near plane and a pose within six metres of the ship, the requested flight '
          + 'state is present, and the deterministic PNG passes the same image-quality bars as the authored matrix.',
      }, async () => captureCell(page, options, {
        position: 0.18,
        path,
        cockpit: shot,
        chaseNear: setupOutcome.evidence.chaseNear,
      }));
      if (outcome.ok) {
        report.addArtifact('screenshot', path, {
          cameraMode: 'cockpit',
          flightState: shot.id,
          width: options.viewport.width,
          height: options.viewport.height,
          bytes: outcome.evidence.bytes,
        });
      }
    }
  }

  await bestEffort(page, 'setPaused', [false]);
  await bestEffort(page, 'setAutopilot', [false]);
  await bestEffort(page, 'setInput', [null]);
  await bestEffort(page, 'setSettings', [{ cameraMode: 'chase' }]);
  await bestEffort(page, 'setDriven', [false]);
}

async function prepareMatrix(page, options) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  // Film grain is uncorrelated between processes at +/-4/255, so with it on these PNGs differ
  // byte-wise between runs and the suite cannot serve as a pixel baseline for anyone.
  await callHarness(page, 'setSettings', [{
    quality: options.quality,
    renderScale: 1,
    showFps: false,
    filmGrain: false,
    cameraMode: 'chase',
  }]);
  const settings = await callHarness(page, 'settings');
  verify(settings?.quality === options.quality
    && settings?.renderScale === 1
    && settings?.cameraMode === 'chase', 'Screenshot quality and chase-camera settings did not apply.', {
    requested: { quality: options.quality, renderScale: 1, cameraMode: 'chase' },
    actual: settings,
  });

  const availableVantages = await callHarness(page, 'vantages');
  verify(Array.isArray(availableVantages) && availableVantages.length > 0, 'window.__LV.vantages() returned no names.', { availableVantages });
  verify(availableVantages.every((name) => typeof name === 'string' && name.trim().length > 0), 'Vantage names must be non-empty strings.', { availableVantages });

  const subjects = await callHarness(page, 'vantageSubjects');
  verify(Array.isArray(subjects) && subjects.length > 0, 'vantageSubjects() returned nothing.', { subjects });
  const vantageSubjects = Object.fromEntries(subjects.map((v) => [v.name, v.subject]));

  const selectedVantages = options.vantages ?? availableVantages;
  const unknownVantages = selectedVantages.filter((name) => !availableVantages.includes(name));
  verify(unknownVantages.length === 0, `Unknown requested vantages: ${unknownVantages.join(', ')}`, {
    availableVantages,
    selectedVantages,
  });

  // Take the frame loop. Without this the live rAF loop keeps running between CDP round trips
  // and overrides the vantage pose the moment it is set — which is why two of ten committed
  // stills contained no subject at all, including the authored still of the destination. The
  // cleanup at the end of this file already calls setDriven(false), so the original author
  // intended this and it was simply never added.
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
  await stepUntilFlying(page, options.timeoutMs);
  await callHarness(page, 'setAutopilot', [false]);
  await callHarness(page, 'clearVantage');
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  const chasePose = await callHarness(page, 'pose');
  verify(chasePose?.camera?.near > 0, 'Chase camera did not report a valid near plane.', { chasePose });
  await callHarness(page, 'setPaused', [true]);

  return {
    vantageSubjects,
    seed: options.seed,
    quality: options.quality,
    renderScale: 1,
    fixedTimestep: 1 / 60,
    availableVantages,
    selectedVantages,
    positions: options.positions,
    viewport: options.viewport,
    chaseNear: chasePose.camera.near,
  };
}

async function captureCell(page, options, cell) {
  // Callouts, the log feed and the comms line are transient game state, and in a headless driver
  // one of them is guaranteed: pointer lock is always refused, so every still carried a
  // MOUSE CAPTURE UNAVAILABLE banner across its middle. A still is an image of the game, not of
  // the harness's environment.
  await page.evaluate(() => { document.documentElement.dataset.lvCapture = '1'; });
  await callHarness(page, 'setPaused', [false]);
  await callHarness(page, 'seekCourse', [cell.position]);
  if (cell.cockpit) {
    await callHarness(page, 'clearVantage');
    await callHarness(page, 'setSettings', [{ cameraMode: 'cockpit' }]);
    await callHarness(page, 'setInput', [cell.cockpit.input]);
    await callHarness(page, 'step', [cell.cockpit.frames, 1 / 60], options.timeoutMs);
  } else {
    await callHarness(page, 'vantage', [cell.vantage]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  }
  // Let the HUD finish fading in before photographing it.
  //
  // `.lv-hud` drives its own opacity from a `--a` custom property that starts at 0 and ramps.
  // One simulation frame is nowhere near enough: the committed stills were captured at roughly a
  // sixth of settled opacity, with the speed readout and the entire right cluster barely visible.
  // Art reviewers scoring composition were scoring a HUD state no player ever sees — the same
  // class of defect as the 30%-opacity results frame that was once published as evidence.
  const hudAlpha = await settleHud(page, options);
  await callHarness(page, 'present', [], options.timeoutMs);
  await callHarness(page, 'setPaused', [true]);
  const telemetry = await callHarness(page, 'telemetry');
  const activeInput = await callHarness(page, 'activeInput');
  const pose = await callHarness(page, 'pose');
  const cameraMode = await callHarness(page, 'cameraMode');
  const bytes = await page.screenshot({
    path: cell.path,
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  });

  // Assert something about the IMAGE, not about the file size. `bytes.length > 1024` passes for
  // an all-black frame, for a magenta shader-failure frame, and for the loading card — which is
  // how eight of ten authored stills came to have no midtone shelf without the suite noticing.
  const stats = imageStats(decodePng(bytes), { step: 2 });
  const evidence = {
    file: cell.path,
    bytes: bytes.length,
    position: cell.position,
    vantage: cell.vantage ?? null,
    cockpitState: cell.cockpit?.id ?? null,
    cameraMode,
    camera: pose?.camera ?? null,
    cameraDistanceFromShip: pose ? vectorDistance(pose.position, pose.camera.position) : null,
    viewport: options.viewport,
    telemetry: compactTelemetry(telemetry),
    activeInput,
    hudAlpha,
    image: stats,
  };

  verify(bytes.length > 1_024, 'Screenshot PNG is unexpectedly small.', evidence);
  verify(
    hudAlpha === null || hudAlpha >= 0.98,
    `HUD captured mid-fade at alpha ${hudAlpha} — this frame shows a state no player sees.`,
    evidence,
  );
  verify(
    stats.width === options.viewport.width && stats.height === options.viewport.height,
    'Screenshot dimensions do not match the requested viewport.',
    evidence,
  );
  // A frame that is one value everywhere is a failure however bright it is: black, white, or a
  // shader-error flat.
  verify(stats.distinctLevels >= 12, 'Frame is effectively flat — fewer than 12 distinct luminance levels.', evidence);
  verify(stats.stdDev >= 0.03, 'Frame has almost no luminance variation.', evidence);
  verify(stats.blackFraction <= 0.90, 'Frame is almost entirely black.', evidence);
  verify(stats.whiteFraction <= 0.35, 'Frame is blown out.', evidence);
  // The composition bar the art review set: a dark anchor, a broad midtone shelf, a small hot
  // accent. Frames measured at 89.2% below 0.18 have the anchor and the accent and nothing
  // between, which is what makes them read as unfinished rather than as authored.
  verify(stats.midtoneFraction >= 0.12, `Frame has no midtone shelf (${(stats.midtoneFraction * 100).toFixed(1)}% in 0.18-0.45).`, evidence);
  // 0.86, calibrated to the defect rather than guessed. The first cut of this used 0.80, which
  // failed the chase and hull vantages at 80.8% and 82.7% — and space legitimately IS mostly
  // void, so a limit that rejects a good frame of it is measuring the wrong thing. The frame the
  // art review actually condemned sat at 89.2%, and the midtone assertion above is the one
  // carrying the real bar.
  verify(stats.shadowFraction <= 0.86, `Frame is ${(stats.shadowFraction * 100).toFixed(1)}% shadow.`, evidence);
  // Every other statistic here reduces the pixel to Rec.709 luminance first, so a channel-swapped,
  // hue-rotated or fully desaturated build passes all ten cells unchanged.
  verify(stats.chromaMean >= 0.02, `Frame is effectively greyscale (mean chroma ${stats.chromaMean}).`, evidence);
  if (cell.cockpit) {
    verify(cameraMode === 'cockpit', 'Cockpit capture fell back to a different applied camera mode.', evidence);
    verify(finitePositive(pose?.camera?.near) && pose.camera.near < 0.25,
      `Cockpit near plane is ${pose?.camera?.near}; close geometry will clip.`, evidence);
    verify(pose.camera.near < cell.chaseNear / 4,
      'Cockpit near plane is not materially closer than the measured chase near plane.', evidence);
    verify(evidence.cameraDistanceFromShip < 6,
      `Cockpit camera is ${evidence.cameraDistanceFromShip} m from the ship.`, evidence);
    if (cell.cockpit.id === 'forward') {
      verify(telemetry.boosting === false
        && activeInput.boost === false
        && Math.abs(activeInput.pitch) < 1e-9
        && Math.abs(activeInput.yaw) < 1e-9
        && Math.abs(activeInput.roll) < 1e-9,
      'Forward cockpit evidence was not captured under a straight, non-boosted command.', evidence);
    } else if (cell.cockpit.id === 'banked') {
      verify(Math.abs(telemetry.roll) > 0.12,
        `Banked cockpit evidence has only ${telemetry.roll} rad of roll.`, evidence);
    } else if (cell.cockpit.id === 'boost') {
      verify(telemetry.boosting === true,
        'Overdrive cockpit evidence was captured without boost engaged.', evidence);
    }
    await callHarness(page, 'setInput', [null]);
  }
  // The frame has to contain the thing it is a picture of. Every other assertion here is a
  // global luminance statistic, and nebula plus starfield satisfies the whole battery — which is
  // how two stills with no subject in them passed, one of them the destination.
  //
  // Asserted from the game's own projection rather than from pixels, because a luminance
  // threshold cannot isolate a hull against a nebula brighter than it is.
  // A gate- or terminus-anchored vantage is a picture of that object and must contain it. A
  // ship-anchored one frames the ship by construction and its gate may legitimately be behind
  // the camera, so asserting the gate there would fail good frames.
  if (cell.subject === 'gate' || cell.subject === 'terminus') {
    verify(
      telemetry?.gate?.anchor?.onScreen === true,
      `The ${cell.subject} this vantage is a picture of does not project on screen — this frame is empty sky.`,
      { ...evidence, subject: cell.subject, anchor: telemetry?.gate?.anchor },
    );
  }

  // Subject bounds are REPORTED but not asserted. A hero object running off the frame edge is a
  // real staging error — three shipped stills had one — but a luminance threshold cannot isolate
  // the hero here: the nebula is brighter than the hull across much of the frame, so the subject
  // box is the whole viewport at every threshold that still includes the ship. Asserting on it
  // would fail good frames, and a wrong assertion is worse than no assertion. The numbers are in
  // the evidence for a human to read.
  return evidence;
}

/** Steps until the HUD's own fade has settled, and reports the alpha it reached. */
async function settleHud(page, options) {
  const read = () => page.evaluate(() => {
    const hud = document.querySelector('.lv-hud');
    if (!hud) return null;
    const raw = getComputedStyle(hud).getPropertyValue('--a').trim();
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  });
  let alpha = await read();
  for (let i = 0; i < 40 && alpha !== null && alpha < 0.98; i++) {
    await callHarness(page, 'step', [6, 1 / 60], options.timeoutMs);
    alpha = await read();
  }
  return alpha;
}

async function stepUntilFlying(page, timeoutMs) {
  let simulatedFrames = 0;
  while (simulatedFrames <= 600) {
    const phase = await callHarness(page, 'phase');
    if (phase === 'flying') return;
    if (phase === 'finished') throw new Error('Run finished before screenshot setup reached flying.');
    await callHarness(page, 'step', [30], timeoutMs);
    simulatedFrames += 30;
  }
  throw new Error('Run did not reach flying within 10 simulated seconds.');
}

function compactTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return telemetry;
  return {
    phase: telemetry.phase,
    elapsed: telemetry.elapsed,
    speed: telemetry.speed,
    gate: telemetry.gate,
    courseRemaining: telemetry.courseRemaining,
    sectorName: telemetry.sectorName,
    destinationName: telemetry.destinationName,
  };
}

async function bestEffort(page, method, args) {
  try {
    await callHarness(page, method, args);
  } catch {
    // The originating check records the actionable failure.
  }
}

function formatPosition(position) {
  return position.toFixed(2).replace('.', '_');
}

function slug(value) {
  const safe = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return safe || 'vantage';
}

function vectorDistance(a, b) {
  return Math.hypot(...a.map((value, index) => value - b[index]));
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
