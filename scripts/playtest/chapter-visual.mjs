import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  REPO_ROOT,
  callHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';
import { decodePng, imageStats } from './pngstats.mjs';

const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
const STAGES = Object.freeze({
  wreckline: {
    id: 'wreckline',
    landmarkKind: 'wreckline',
    destination: 'NADIR RELAY',
  },
  ringfall: {
    id: 'ringfall',
    landmarkKind: 'ringfall',
    destination: 'ORISON ARRAY',
  },
});
const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'telemetry',
  'phase',
  'result',
  'course',
  'progress',
  'landmarks',
  'installProgress',
  'vantage',
  'vantages',
  'vantageSubjects',
  'setAutopilot',
  'setDriven',
  'setFixedTimestep',
  'step',
  'present',
  'settings',
  'setSettings',
  'errors',
];

const data = await runManagedSuite({
  suite: 'chapter-visual',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runChapterVisual,
});

// These stills have no approved baseline. A technically valid run must therefore never be
// mistaken for an automated composition verdict.
const technicalStatus = data.status;
data.technicalStatus = technicalStatus;
data.visualReview = {
  status: technicalStatus === 'PASS' ? 'REVIEW REQUIRED' : 'BLOCKED',
  automatedScope: ['route identity', 'intended-subject bounds', 'PNG dimensions', 'finite pixels', 'runtime errors'],
  excludedScope: ['composition', 'readability', 'differentiation', 'art direction'],
};
data.status = technicalStatus === 'PASS' ? 'REVIEW REQUIRED' : 'FAIL';
const reportArtifact = data.artifacts.find((artifact) => artifact.kind === 'report');
const reportPath = resolve(REPO_ROOT, reportArtifact?.path ?? 'playtest-out/chapter-visual/report.json');
await writeFile(reportPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
process.stdout.write(`${data.status}: ${reportPath}\n`);
process.exitCode = data.status === 'FAIL' ? 1 : 0;

async function runChapterVisual({ report, session, options }) {
  const page = session.page;
  verify(page, 'Browser page is unavailable.');
  verify(
    options.viewport.width === VIEWPORT.width
      && options.viewport.height === VIEWPORT.height
      && options.deviceScaleFactor === 1,
    'Chapter visual evidence must run at 1920x1080 DPR1.',
    { viewport: options.viewport, deviceScaleFactor: options.deviceScaleFactor },
  );

  report.data.configuration.captureContract = {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    filmGrain: false,
    imageCount: 6,
    verdict: 'REVIEW REQUIRED',
  };

  const imageDirectory = resolve(options.out, 'screenshots');
  await rm(imageDirectory, { recursive: true, force: true });
  await mkdir(imageDirectory, { recursive: true });
  const captured = [];

  const progressOutcome = await report.check({
    id: 'CHAPTER_VISUAL.progress',
    name: 'Chapter routes are reload-accessible in one isolated browser session',
    assertion: 'Harness-only session progress unlocks all three stages without writing durable player progress.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    const persistence = await callHarness(page, 'installProgress', [completedProgress('ringfall')]);
    verify(persistence?.reloadSafe === true && persistence?.localWritten === false,
      'Harness progress was not reload-safe and session-only.', persistence);
    return { persistence };
  });

  for (const stage of [STAGES.wreckline, STAGES.ringfall]) {
    const routeOutcome = await report.check({
      id: `CHAPTER_VISUAL.${stage.id}-route`,
      name: `${stage.id} reloads into its authored capture route`,
      assertion: 'A full URL navigation loads the requested stage, correct landmark identity, and both focused vantages.',
    }, async () => {
      verify(progressOutcome.ok, 'Chapter progress setup failed.', progressOutcome.error);
      return prepareStage(page, session, options, stage);
    });

    for (const capture of [
      { label: 'signature', vantage: 'signature' },
      { label: 'destination', vantage: 'terminus' },
    ]) {
      const path = resolve(imageDirectory, `${stage.id}-${capture.label}.png`);
      const outcome = await report.check({
        id: `CHAPTER_VISUAL.${stage.id}-${capture.label}`,
        name: `${stage.id} ${capture.label} evidence is technically valid`,
        assertion:
          'The boot-built route identity matches the URL, the intended gate/destination anchor is finite and inside the frustum, and the 1920x1080 PNG contains finite non-flat pixels.',
      }, async () => {
        verify(routeOutcome.ok, `${stage.id} route setup failed.`, routeOutcome.error);
        return captureVantage(page, options, stage, capture, path);
      });
      if (outcome.ok) {
        captured.push(path);
        report.addArtifact('screenshot', path, {
          stageId: stage.id,
          subject: capture.label,
          vantage: capture.vantage,
          reviewStatus: 'REVIEW REQUIRED',
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          deviceScaleFactor: 1,
        });
      }
    }
  }

  const titlePath = resolve(imageDirectory, 'chapter-title-stage-rail.png');
  const titleOutcome = await report.check({
    id: 'CHAPTER_VISUAL.title-stage-rail',
    name: 'Chapter title stage rail is bounded at 1920x1080',
    assertion:
      'A full RINGFALL URL reload opens the title with exactly three stage nodes, the selected route identity, and every rail/node bound inside the viewport.',
  }, async () => {
    verify(progressOutcome.ok, 'Chapter progress setup failed.', progressOutcome.error);
    await reloadStage(page, session, options, STAGES.ringfall);
    await applyCaptureSettings(page, options);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'present', [], options.timeoutMs);

    const course = await callHarness(page, 'course');
    const phase = await callHarness(page, 'phase');
    const bounds = await elementBounds(page, '[data-view="title"][data-open="1"] .lv-stage-rail', true);
    const nodes = await page.evaluate(() => {
      const readRect = (node) => {
        if (!(node instanceof HTMLElement)) return null;
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      return [...document.querySelectorAll(
        '[data-view="title"][data-open="1"] .lv-stage-rail [data-stage-id]',
      )].map((node) => ({
        id: node.getAttribute('data-stage-id'),
        selected: node.getAttribute('data-stage-selected'),
        state: node.getAttribute('data-stage-state'),
        rect: readRect(node),
      }));
    });
    const image = await capturePng(page, titlePath);
    const evidence = { course, phase, bounds, nodes, image };
    verify(phase === 'title' && course?.courseId === 'ringfall',
      'Title capture lost RINGFALL route identity.', evidence);
    verify(nodes.length === 3
      && nodes.map(({ id }) => id).join(',') === 'cairn-drift,wreckline,ringfall'
      && nodes.find(({ id }) => id === 'ringfall')?.selected === '1',
    'Title capture does not contain the intended three-stage rail selection.', evidence);
    verify(nodes.every(({ rect }) => rectInsideViewport(rect, VIEWPORT)),
      'A title-stage node leaves the 1920x1080 viewport.', evidence);
    verifyTechnicalPng(image, evidence);
    return evidence;
  });
  if (titleOutcome.ok) {
    captured.push(titlePath);
    report.addArtifact('screenshot', titlePath, {
      subject: 'title-stage-rail',
      stageId: 'ringfall',
      reviewStatus: 'REVIEW REQUIRED',
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
    });
  }

  const resultsPath = resolve(imageDirectory, 'chapter-results.png');
  const resultsOutcome = await report.check({
    id: 'CHAPTER_VISUAL.results',
    name: 'Chapter result screen is bounded and tied to RINGFALL',
    assertion:
      'The deterministic pilot completes the URL-loaded final stage, and the visible result panel plus its 1920x1080 PNG stay technically bounded and non-flat.',
  }, async () => {
    verify(titleOutcome.ok, 'Title-route setup failed, so final-stage results cannot be captured.', titleOutcome.error);
    await applyCaptureSettings(page, options);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);

    let phase = await callHarness(page, 'phase');
    let steppedFrames = 0;
    while (phase !== 'finished' && phase !== 'failed' && steppedFrames < 7_200) {
      await callHarness(page, 'step', [60, 1 / 60], 120_000);
      steppedFrames += 60;
      phase = await callHarness(page, 'phase');
    }
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'present', [], options.timeoutMs);

    const course = await callHarness(page, 'course');
    const result = await callHarness(page, 'result');
    const bounds = await elementBounds(page, '[data-view="results"][data-open="1"] .lv-results', true);
    const image = await capturePng(page, resultsPath);
    const errors = await callHarness(page, 'errors');
    const evidence = { course, phase, steppedFrames, result, bounds, image, errors };
    verify(phase === 'finished'
      && course?.courseId === 'ringfall'
      && result?.courseId === 'ringfall'
      && result?.gatesCleared === result?.gatesTotal,
    'Final result capture is not a successful RINGFALL finish.', evidence);
    verify(errors.length === 0, 'Game errors occurred before the result capture.', evidence);
    verifyTechnicalPng(image, evidence);
    return evidence;
  });
  if (resultsOutcome.ok) {
    captured.push(resultsPath);
    report.addArtifact('screenshot', resultsPath, {
      subject: 'results',
      stageId: 'ringfall',
      reviewStatus: 'REVIEW REQUIRED',
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
    });
  }

  await report.check({
    id: 'CHAPTER_VISUAL.exact-set',
    name: 'Focused Chapter 01 evidence contains exactly six images',
    assertion:
      'The output contains WRECKLINE signature/destination, RINGFALL signature/destination, title rail, and results—no CAIRN image or extra matrix cell.',
  }, async () => {
    const expected = [
      'wreckline-signature.png',
      'wreckline-destination.png',
      'ringfall-signature.png',
      'ringfall-destination.png',
      'chapter-title-stage-rail.png',
      'chapter-results.png',
    ];
    const actual = captured.map((path) => path.split('/').at(-1));
    verify(actual.length === expected.length
      && expected.every((name) => actual.includes(name)),
    'Focused visual evidence is incomplete or contains an unintended cell.', { expected, actual });
    return { expected, actual, reviewStatus: 'REVIEW REQUIRED' };
  });
}

async function prepareStage(page, session, options, stage) {
  const navigation = await reloadStage(page, session, options, stage);
  await applyCaptureSettings(page, options);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [false]);
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);

  const course = await callHarness(page, 'course');
  const landmarks = await callHarness(page, 'landmarks');
  const vantages = await callHarness(page, 'vantages');
  const subjects = await callHarness(page, 'vantageSubjects');
  const evidence = { navigation, course, landmarks, vantages, subjects };
  verify(course?.courseId === stage.id
    && course?.resolution?.source === 'url'
    && new URL(page.url()).searchParams.get('course') === stage.id,
  `${stage.id} did not resolve from its URL.`, evidence);
  verify(landmarks?.kind === stage.landmarkKind
    && typeof landmarks?.signature === 'string'
    && landmarks.signature.length > 0,
  `${stage.id} loaded the wrong landmark world.`, evidence);
  verify(vantages.includes('signature') && vantages.includes('terminus'),
    `${stage.id} does not expose both focused vantages.`, evidence);
  return evidence;
}

async function captureVantage(page, options, stage, capture, path) {
  await page.evaluate(() => { document.documentElement.dataset.lvCapture = '1'; });
  await callHarness(page, 'vantage', [capture.vantage]);
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  await callHarness(page, 'present', [], options.timeoutMs);

  const course = await callHarness(page, 'course');
  const telemetry = await callHarness(page, 'telemetry');
  const subjects = await callHarness(page, 'vantageSubjects');
  const declaredSubject = subjects.find(({ name }) => name === capture.vantage)?.subject ?? null;
  const intendedSubject = capture.label === 'signature' ? 'gate' : 'terminus';
  const anchor = telemetry?.gate?.anchor;
  const image = await capturePng(page, path);
  const errors = await callHarness(page, 'errors');
  const evidence = {
    stageId: stage.id,
    url: page.url(),
    course,
    vantage: capture.vantage,
    declaredSubject,
    intendedSubject,
    destinationName: telemetry?.destinationName,
    anchor,
    image,
    errors,
  };
  verify(course?.courseId === stage.id
    && new URL(page.url()).searchParams.get('course') === stage.id,
  'Capture route identity differs from its URL.', evidence);
  verify(telemetry?.destinationName === stage.destination,
    'Capture destination identity does not match stage authoring.', evidence);
  verify(declaredSubject === intendedSubject,
    'The authored vantage does not declare the intended focused subject.', evidence);
  verify(anchor?.onScreen === true
    && finite(anchor.x) && finite(anchor.y)
    && Math.abs(anchor.x) <= 1 && Math.abs(anchor.y) <= 1,
  'The intended subject anchor is outside the visible normalised-device bounds.', evidence);
  verify(errors.length === 0, 'Game errors occurred before capture.', evidence);
  verifyTechnicalPng(image, evidence);
  return evidence;
}

async function reloadStage(page, session, options, stage) {
  const url = new URL(session.target.url);
  // Canonical art evidence uses each authored stage's default seed, not the harness-wide debug
  // seed. The course URL remains deterministic through its stable stage definition.
  url.searchParams.delete('seed');
  url.searchParams.set('course', stage.id);
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: options.timeoutMs });
  verify(response?.ok(), 'Stage URL reload returned a non-success document.', {
    stageId: stage.id,
    status: response?.status() ?? null,
    url: url.href,
  });
  verify(await waitForHarness(page, options.timeoutMs), 'Harness did not return after stage reload.', {
    stageId: stage.id,
    url: url.href,
  });
  await callHarness(page, 'ready', [], options.timeoutMs);
  return { stageId: stage.id, status: response.status(), url: page.url() };
}

async function applyCaptureSettings(page, options) {
  await callHarness(page, 'setSettings', [{
    quality: 'high',
    renderScale: 1,
    showFps: false,
    filmGrain: false,
    motionBlur: false,
    chromaticAberration: false,
    cameraMode: 'chase',
  }]);
  const settings = await callHarness(page, 'settings');
  verify(settings?.quality === 'high'
    && settings?.renderScale === 1
    && settings?.showFps === false
    && settings?.filmGrain === false
    && settings?.motionBlur === false
    && settings?.chromaticAberration === false,
  'Focused capture settings did not apply.', { settings, expected: { quality: 'high', renderScale: 1, filmGrain: false } });
  verify(options.deviceScaleFactor === 1, 'Visual captures must use DPR1.', { deviceScaleFactor: options.deviceScaleFactor });
}

async function capturePng(page, path) {
  const bytes = await page.screenshot({
    path,
    type: 'png',
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  });
  const stats = imageStats(decodePng(bytes), { step: 4 });
  return { path, bytes: bytes.length, stats };
}

function verifyTechnicalPng(image, evidence) {
  const stats = image?.stats;
  verify(image?.bytes > 1_024, 'PNG is unexpectedly small.', evidence);
  verify(stats?.width === VIEWPORT.width && stats?.height === VIEWPORT.height,
    'PNG dimensions differ from 1920x1080.', evidence);
  verify(stats?.sampled > 0
    && stats?.distinctLevels > 1
    && [stats.mean, stats.stdDev, stats.blackFraction, stats.whiteFraction]
      .every((value) => finite(value)),
  'PNG pixel statistics are empty, flat, or non-finite.', evidence);
}

async function elementBounds(page, selector, mustBeVisible) {
  const evidence = await page.evaluate((requestedSelector) => {
    const element = document.querySelector(requestedSelector);
    const readRect = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      selector: requestedSelector,
      rect: readRect(element),
      visible: element instanceof HTMLElement
        && getComputedStyle(element).display !== 'none'
        && getComputedStyle(element).visibility !== 'hidden'
        && element.getClientRects().length > 0,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, selector);
  verify(!mustBeVisible || evidence.visible, `Required visual subject is not visible: ${selector}`, evidence);
  verify(rectInsideViewport(evidence.rect, evidence.viewport), `Visual subject leaves the viewport: ${selector}`, evidence);
  return evidence;
}

function rectInsideViewport(rect, viewport) {
  return rect !== null
    && [rect.left, rect.right, rect.top, rect.bottom, rect.width, rect.height].every(finite)
    && rect.width > 0
    && rect.height > 0
    && rect.left >= -1
    && rect.top >= -1
    && rect.right <= viewport.width + 1
    && rect.bottom <= viewport.height + 1;
}

function completedProgress(selectedCourse) {
  const cleared = {
    cleared: true,
    clearedAt: 1,
    highestRank: 'S',
    cleanClear: true,
    precisionClear: true,
  };
  return {
    version: 1,
    selectedCourse,
    courses: {
      'cairn-drift': { ...cleared },
      wreckline: { ...cleared },
      ringfall: { ...cleared },
    },
  };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
