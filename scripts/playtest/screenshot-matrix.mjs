import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  callHarness,
  runManagedSuite,
  verify,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'telemetry',
  'phase',
  'setAutopilot',
  'seekCourse',
  'vantage',
  'vantages',
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
    for (const position of options.positions) {
      for (const vantage of selectedVantages) {
        cellIndex += 1;
        const filename = `${String(cellIndex).padStart(3, '0')}-course-${formatPosition(position)}-${slug(vantage)}.png`;
        const path = resolve(imageDirectory, filename);
        const outcome = await report.check({
          id: `SCREENSHOT.cell-${String(cellIndex).padStart(3, '0')}`,
          name: `Capture ${vantage} at course ${position}`,
          criteria: [],
          assertion: 'seekCourse and vantage succeed through __LV, one fixed simulation frame is presented, simulation is frozen, and Playwright writes a non-trivial 1920x1080 PNG.',
        }, async () => captureCell(page, options, { position, vantage, path }));
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
    assertion: 'Every requested course-position × named-vantage cell produces a PNG; a setup failure is reported instead of silently producing an empty matrix.',
  }, async () => {
    verify(setupOutcome.ok, 'Screenshot setup failed, so no matrix could be captured.', setupOutcome.error);
    const expectedCells = options.positions.length * setupOutcome.evidence.selectedVantages.length;
    const failedCells = cellOutcomes.filter((outcome) => !outcome.ok).length;
    const evidence = {
      positions: options.positions,
      vantages: setupOutcome.evidence.selectedVantages,
      expectedCells,
      capturedCells: cellOutcomes.length - failedCells,
      failedCells,
    };
    verify(cellOutcomes.length === expectedCells, 'Matrix cell count is incomplete.', evidence);
    verify(failedCells === 0, 'One or more screenshot cells failed.', evidence);
    return evidence;
  });

  await bestEffort(page, 'setPaused', [false]);
  await bestEffort(page, 'setAutopilot', [false]);
  await bestEffort(page, 'setDriven', [false]);
}

async function prepareMatrix(page, options) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setSettings', [{ quality: options.quality, renderScale: 1, showFps: false }]);
  const settings = await callHarness(page, 'settings');
  verify(settings?.quality === options.quality && settings?.renderScale === 1, 'Screenshot quality settings did not apply.', {
    requested: { quality: options.quality, renderScale: 1 },
    actual: settings,
  });

  const availableVantages = await callHarness(page, 'vantages');
  verify(Array.isArray(availableVantages) && availableVantages.length > 0, 'window.__LV.vantages() returned no names.', { availableVantages });
  verify(availableVantages.every((name) => typeof name === 'string' && name.trim().length > 0), 'Vantage names must be non-empty strings.', { availableVantages });

  const selectedVantages = options.vantages ?? availableVantages;
  const unknownVantages = selectedVantages.filter((name) => !availableVantages.includes(name));
  verify(unknownVantages.length === 0, `Unknown requested vantages: ${unknownVantages.join(', ')}`, {
    availableVantages,
    selectedVantages,
  });

  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
  await stepUntilFlying(page, options.timeoutMs);
  await callHarness(page, 'setAutopilot', [false]);
  await callHarness(page, 'setPaused', [true]);

  return {
    seed: options.seed,
    quality: options.quality,
    renderScale: 1,
    fixedTimestep: 1 / 60,
    availableVantages,
    selectedVantages,
    positions: options.positions,
    viewport: options.viewport,
  };
}

async function captureCell(page, options, cell) {
  await callHarness(page, 'setPaused', [false]);
  await callHarness(page, 'seekCourse', [cell.position]);
  await callHarness(page, 'vantage', [cell.vantage]);
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  await callHarness(page, 'present', [], options.timeoutMs);
  await callHarness(page, 'setPaused', [true]);
  const telemetry = await callHarness(page, 'telemetry');
  const bytes = await page.screenshot({
    path: cell.path,
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  });

  const evidence = {
    file: cell.path,
    bytes: bytes.length,
    position: cell.position,
    vantage: cell.vantage,
    viewport: options.viewport,
    telemetry: compactTelemetry(telemetry),
  };
  verify(bytes.length > 1_024, 'Screenshot PNG is unexpectedly small.', evidence);
  return evidence;
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
