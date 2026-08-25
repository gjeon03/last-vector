import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  REPO_ROOT,
  callHarness,
  finiteNumber,
  installNetworkBoundary,
  installPageObservers,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';
import { decodePng, imageStats } from './pngstats.mjs';

const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
const PROFILE_SECONDS = 3;
const CAPTURES = Object.freeze([
  ['title', 'last-ascent-title.png'],
  ['launch', 'last-ascent-launch.png'],
  ['near-front', 'last-ascent-near-front.png'],
]);
const RESOURCE_BUDGETS = Object.freeze({
  drawCalls: 160,
  triangles: 620_000,
  geometries: 155,
  textures: 16,
  programs: 55,
});
const REQUIRED_METHODS = [
  'ready',
  'course',
  'catalog',
  'progress',
  'installProgress',
  'routeUrl',
  'landmarks',
  'startRun',
  'telemetry',
  'phase',
  'result',
  'vantage',
  'vantages',
  'clearVantage',
  'setAutopilot',
  'setDriven',
  'setFixedTimestep',
  'step',
  'stepSimulation',
  'present',
  'profile',
  'setSettings',
  'errors',
];

await runManagedSuite({
  suite: 'last-ascent-browser',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runLastAscentBrowser,
});

async function runLastAscentBrowser({ report, session, options }) {
  const page = session.page;
  verify(page && session.browser && session.target, 'Managed browser session is unavailable.');
  verify(options.viewport.width === VIEWPORT.width
    && options.viewport.height === VIEWPORT.height
    && options.deviceScaleFactor === 1,
  'Focused journey must start at 1920x1080 DPR1.', options);

  const imageDirectory = resolve(options.out, 'screenshots');
  await rm(imageDirectory, { recursive: true, force: true });
  await mkdir(imageDirectory, { recursive: true });

  const routeOutcome = await report.check({
    id: 'ASCENT_BROWSER.unlock-route',
    name: 'CAIRN clear-only unlocks one canonical LAST ASCENT page',
    assertion: 'A fresh rail locks Chapter 02; session progress then loads ?mission=last-ascent with one canvas and the selected Chapter 02 world.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    const freshRail = await readRail(page);
    verify(freshRail.nodes.length === 2
      && freshRail.nodes[0]?.id === 'cairn-drift'
      && freshRail.nodes[0]?.state === 'available'
      && freshRail.nodes[1]?.id === 'last-ascent'
      && freshRail.nodes[1]?.state === 'locked',
    'Fresh title did not present a clear-only two-chapter rail.', freshRail);

    const persistence = await callHarness(page, 'installProgress', [unlockedProgress()]);
    verify(persistence?.reloadSafe === true && persistence?.localWritten === false,
      'Harness unlock was not reload-safe session progress.', persistence);
    const routeUrl = new URL(await callHarness(page, 'routeUrl', ['last-ascent']));
    verify(routeUrl.searchParams.get('mission') === 'last-ascent'
      && !routeUrl.searchParams.has('course'),
    'LAST ASCENT route URL is not canonical.', routeUrl.href);
    const response = await page.goto(routeUrl.href, { waitUntil: 'load', timeout: options.timeoutMs });
    verify(response?.ok() && await waitForHarness(page, options.timeoutMs),
      'Canonical LAST ASCENT page did not reload.', { status: response?.status(), url: page.url() });
    await callHarness(page, 'ready', [], options.timeoutMs);
    await applySettings(page);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'present', [], options.timeoutMs);

    const course = await callHarness(page, 'course');
    const catalog = await callHarness(page, 'catalog');
    const landmarks = await callHarness(page, 'landmarks');
    const rail = await readRail(page);
    const canvasCount = await page.locator('canvas.lv-canvas').count();
    const evidence = { course, catalog, landmarks, rail, canvasCount, url: page.url() };
    verify(new URL(page.url()).searchParams.get('mission') === 'last-ascent'
      && course?.recordId === `last-ascent-r1-${course.seed}`
      && course?.resolution?.missionId === 'last-ascent'
      && course?.resolution?.source === 'mission-url'
      && catalog?.order?.join(',') === 'cairn-drift,last-ascent'
      && landmarks?.kind === 'last-ascent'
      && canvasCount === 1
      && rail.nodes.find((node) => node.id === 'last-ascent')?.selected === '1',
    'Canonical page did not construct exactly the selected LAST ASCENT presentation.', evidence);
    return evidence;
  });

  await report.check({
    id: 'ASCENT_BROWSER.focused-captures',
    name: 'Three settled DPR1 captures cover impact identity and shockfront pressure',
    assertion: 'Title/launch show the authored guided impact; the near-front frame exposes a staged escape warning.',
  }, async () => {
    verify(routeOutcome.ok, 'LAST ASCENT route setup failed.', routeOutcome.error);
    const captures = [];
    captures.push(await capture(page, report, imageDirectory, CAPTURES[0]));

    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'vantage', ['launch-reveal']);
    // Headless Chromium rejects pointer lock without a real desktop surface. Let that optional
    // recovery callout/log and the opening radio settle before committing human-review evidence.
    await callHarness(page, 'step', [720, 1 / 60], options.timeoutMs);
    await callHarness(page, 'present', [], options.timeoutMs);
    captures.push(await capture(page, report, imageDirectory, CAPTURES[1]));

    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'clearVantage');
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 0.79 }]);
    let pressure = 'nominal';
    let phase = await callHarness(page, 'phase');
    let steppedFrames = 0;
    while (phase === 'flying' && pressure !== 'critical' && steppedFrames < 6_600) {
      await callHarness(page, 'stepSimulation', [30, 1 / 60], 120_000);
      steppedFrames += 30;
      phase = await callHarness(page, 'phase');
      pressure = await page.locator('.lv-escape-hud').getAttribute('data-pressure') ?? 'nominal';
    }
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'present', [], options.timeoutMs);
    const telemetry = await callHarness(page, 'telemetry');
    const hud = await page.evaluate(() => ({
      visible: !document.querySelector('.lv-escape-hud')?.hasAttribute('hidden'),
      pressure: document.querySelector('.lv-escape-hud')?.getAttribute('data-pressure') ?? null,
      callout: document.querySelector('.lv-escape-pressure')?.textContent ?? null,
      calloutVisible: !document.querySelector('.lv-escape-pressure')?.hasAttribute('hidden'),
      status: document.querySelector('.lv-escape-hud')?.getAttribute('aria-label') ?? null,
    }));
    const separation = telemetry?.objective?.kind === 'escape'
      ? telemetry.objective.pathProgress - telemetry.objective.shockwaveProgress
      : null;
    verify(phase === 'flying'
      && hud.visible
      && hud.pressure === 'critical'
      && hud.calloutVisible
      && hud.callout?.includes('SHOCKFRONT')
      && Number.isFinite(separation)
      && separation > 0,
    'Near-front state did not expose the bounded critical pressure warning before catch.', {
      phase,
      steppedFrames,
      separation,
      hud,
      telemetry,
    });
    captures.push(await capture(page, report, imageDirectory, CAPTURES[2]));
    return { captures, nearFront: { phase, steppedFrames, separation, hud, telemetry } };
  });

  const perfOutcome = await report.check({
    id: 'ASCENT_BROWSER.hardest-scene-dpr1-dpr2',
    name: 'The hardest debris scene stays inside DPR1/DPR2 resource ceilings',
    assertion: 'After every authored vantage is material-resident, debris-beta profiles at High quality with no late shader compilation and <=160/620k/155/16/55 resources.',
  }, async () => {
    verify(routeOutcome.ok, 'LAST ASCENT route setup failed.', routeOutcome.error);
    const dpr1 = await profileHardestScene(page, options, 1);
    assertProfile(dpr1);
    const dpr2Session = await openDpr2Session(session, options);
    try {
      const dpr2 = await profileHardestScene(dpr2Session.page, options, 2);
      assertProfile(dpr2);
      return { dpr1, dpr2, budgets: RESOURCE_BUDGETS };
    } finally {
      await dpr2Session.context.close().catch(() => {});
    }
  });

  await report.check({
    id: 'ASCENT_BROWSER.production-journey',
    name: 'A real production autopilot extracts before the scripted shockfront',
    assertion: 'The canonical page completes all three safe corridors in 100-120 s, preserves hull, applies objective results, and emits no runtime errors.',
  }, async () => {
    verify(routeOutcome.ok && perfOutcome.ok,
      'Route/performance setup failed before the production journey.', { routeOutcome, perfOutcome });
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'clearVantage');
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    let phase = await callHarness(page, 'phase');
    let steppedFrames = 0;
    while (phase !== 'finished' && phase !== 'failed' && steppedFrames < 7_200) {
      await callHarness(page, 'stepSimulation', [300, 1 / 60], 120_000);
      steppedFrames += 300;
      phase = await callHarness(page, 'phase');
    }
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'present', [], options.timeoutMs);
    const result = await callHarness(page, 'result');
    const telemetry = await callHarness(page, 'telemetry');
    const progress = await callHarness(page, 'progress');
    const errors = await callHarness(page, 'errors');
    const evidence = { phase, steppedFrames, result, telemetry, progress, errors };
    verify(phase === 'finished'
      && result?.kind === 'escape'
      && result?.missionId === 'last-ascent'
      && result?.totalTime >= 100
      && result?.totalTime <= 120
      && result?.hullRemaining > 0
      && result?.checkpointsCleared === 3
      && result?.checkpointsTotal === 3
      && result?.secondsAhead >= 3
      && result?.secondsAhead <= 8
      && telemetry?.objective?.kind === 'escape'
      && progress?.missions?.['last-ascent']?.cleared === true
      && errors.length === 0,
    'Focused production journey did not produce the authored escape outcome.', evidence);
    return evidence;
  });
}

function unlockedProgress() {
  return {
    version: 2,
    selectedMission: 'last-ascent',
    missions: {
      'cairn-drift': {
        cleared: true,
        clearedAt: 1,
        highestRank: 'A',
        cleanClear: true,
        mastery: { precision: true },
      },
    },
    dormantCourses: {},
  };
}

async function applySettings(page) {
  await callHarness(page, 'setSettings', [{
    quality: 'high',
    renderScale: 1,
    showFps: false,
    filmGrain: false,
    motionBlur: false,
    chromaticAberration: false,
    cameraMode: 'chase',
  }]);
}

async function readRail(page) {
  return page.evaluate(() => ({
    chapter: document.querySelector('.lv-stage-chapter')?.textContent ?? null,
    nodes: [...document.querySelectorAll('.lv-stage-node')].map((node) => ({
      id: node.getAttribute('data-stage-id'),
      state: node.getAttribute('data-stage-state'),
      selected: node.getAttribute('data-stage-selected'),
      text: node.textContent?.trim() ?? '',
    })),
  }));
}

async function capture(page, report, imageDirectory, [, filename]) {
  const path = resolve(imageDirectory, filename);
  const buffer = await page.screenshot({ path, animations: 'disabled' });
  const stats = imageStats(decodePng(buffer), { step: 4 });
  verify(stats.width === VIEWPORT.width
    && stats.height === VIEWPORT.height
    && stats.stdDev > 0.01
    && stats.distinctLevels >= 12,
  `Capture ${filename} is flat, corrupt, or the wrong size.`, stats);
  report.addArtifact('screenshot', path, {
    missionId: 'last-ascent',
    subject: filename.replace(/^last-ascent-|\.png$/gu, ''),
    reviewStatus: 'REVIEW REQUIRED',
    width: stats.width,
    height: stats.height,
    deviceScaleFactor: 1,
  });
  return { filename, bytes: buffer.length, stats };
}

async function openDpr2Session(session, options) {
  const context = await session.browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  await installNetworkBoundary(context, session.observations);
  await context.addInitScript(({ key, value }) => {
    sessionStorage.setItem(key, value);
  }, {
    key: 'last-vector.progress.v2',
    value: JSON.stringify(unlockedProgress()),
  });
  const page = await context.newPage();
  installPageObservers(page, session.observations);
  const url = new URL(session.target.url);
  url.searchParams.set('mission', 'last-ascent');
  url.searchParams.set('seed', String(options.seed));
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: options.timeoutMs });
  verify(response?.ok() && await waitForHarness(page, options.timeoutMs),
    'DPR2 LAST ASCENT page failed to load.', { status: response?.status(), url: url.href });
  await callHarness(page, 'ready', [], options.timeoutMs);
  await applySettings(page);
  return { context, page };
}

async function profileHardestScene(page, options, deviceScaleFactor) {
  await applySettings(page);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [false]);
  const vantages = await callHarness(page, 'vantages');
  verify(vantages.includes('debris-beta'), 'Hardest authored debris vantage is missing.', vantages);
  for (const vantage of vantages) {
    await callHarness(page, 'vantage', [vantage]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'present', [], options.timeoutMs);
  }
  const shaderProbe = await installLateShaderProbe(page);
  await callHarness(page, 'vantage', ['debris-beta']);
  await callHarness(page, 'step', [2, 1 / 60], options.timeoutMs);
  await callHarness(page, 'present', [], options.timeoutMs);
  const sample = await callHarness(page, 'profile', [PROFILE_SECONDS], 60_000);
  const lateShaders = await stopLateShaderProbe(page);
  await callHarness(page, 'setDriven', [true]);
  const errors = await callHarness(page, 'errors');
  const actualDpr = await page.evaluate(() => devicePixelRatio);
  return {
    deviceScaleFactor,
    actualDpr,
    scene: 'debris-beta',
    quality: 'high',
    presentedVantages: vantages,
    shaderProbe,
    lateShaders,
    sample,
    errors,
  };
}

function assertProfile(evidence) {
  const { sample } = evidence;
  const numeric = ['seconds', 'meanFrameMs', 'p95FrameMs', 'maxFrameMs', 'renderScale'];
  const resources = Object.keys(RESOURCE_BUDGETS);
  verify(evidence.actualDpr === evidence.deviceScaleFactor
    && numeric.every((key) => finiteNumber(sample?.[key]))
    && resources.every((key) => Number.isInteger(sample?.[key]) && sample[key] >= 0)
    && sample.seconds >= PROFILE_SECONDS * 0.9
    && sample.renderScale >= 0.58
    && evidence.lateShaders?.compileShaderCalls === 0
    && evidence.lateShaders?.linkProgramCalls === 0
    && evidence.errors.length === 0,
  'Hardest-scene profile is incomplete, unstable, or compiled a late shader.', evidence);
  verify(resources.every((key) => sample[key] <= RESOURCE_BUDGETS[key]),
    'Renderer resources exceed 160/620k/155/16/55.', evidence);
}

async function installLateShaderProbe(page) {
  return page.evaluate(() => {
    const state = { compileShaderCalls: 0, linkProgramCalls: 0, restored: [], installed: false };
    for (const constructorName of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const prototype = window[constructorName]?.prototype;
      if (!prototype) continue;
      for (const method of ['compileShader', 'linkProgram']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function measuredShaderCall(...args) {
            const result = Reflect.apply(descriptor.value, this, args);
            if (method === 'compileShader') state.compileShaderCalls += 1;
            else state.linkProgramCalls += 1;
            return result;
          },
        });
        state.restored.push({ prototype, method, descriptor });
      }
    }
    state.installed = state.restored.length >= 2;
    window.__LV_LAST_ASCENT_SHADER__ = state;
    return { installed: state.installed, patchedMethods: state.restored.length };
  });
}

async function stopLateShaderProbe(page) {
  return page.evaluate(() => {
    const state = window.__LV_LAST_ASCENT_SHADER__;
    if (!state) return { installed: false, compileShaderCalls: 0, linkProgramCalls: 0, restored: false };
    let restored = true;
    for (let index = state.restored.length - 1; index >= 0; index--) {
      const entry = state.restored[index];
      try {
        Object.defineProperty(entry.prototype, entry.method, entry.descriptor);
      } catch {
        restored = false;
      }
    }
    return {
      installed: state.installed,
      compileShaderCalls: state.compileShaderCalls,
      linkProgramCalls: state.linkProgramCalls,
      restored,
    };
  });
}
