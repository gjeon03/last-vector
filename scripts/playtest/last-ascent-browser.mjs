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
const evidenceTime = (seconds) => {
  const total = Math.floor(seconds * 100);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 6000))}:${pad(Math.floor(total / 100) % 60)}.${pad(total % 100)}`;
};
const evidenceDelta = (seconds) => {
  const rounded = Math.round(seconds * 100) / 100;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded).toFixed(2)}`;
};
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
    verify(freshRail.nodes.length === 3
      && freshRail.nodes[0]?.id === 'cairn-drift'
      && freshRail.nodes[0]?.state === 'available'
      && freshRail.nodes[1]?.id === 'last-ascent'
      && freshRail.nodes[1]?.state === 'locked'
      && freshRail.nodes[2]?.id === 'dead-signal'
      && freshRail.nodes[2]?.state === 'locked',
    'Fresh title did not present the sequential three-chapter rail.', freshRail);

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
      && catalog?.order?.join(',') === 'cairn-drift,last-ascent,dead-signal'
      && landmarks?.kind === 'last-ascent'
      && canvasCount === 1
      && rail.nodes.find((node) => node.id === 'last-ascent')?.selected === '1'
      && rail.nodes.find((node) => node.id === 'dead-signal')?.state === 'locked',
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
    const hud = await page.evaluate(() => {
      const root = document.querySelector('.lv-escape-hud');
      return {
        visible: !root?.hasAttribute('hidden'),
        pressure: root?.getAttribute('data-pressure') ?? null,
        callout: document.querySelector('.lv-escape-pressure')?.textContent ?? null,
        calloutVisible: !document.querySelector('.lv-escape-pressure')?.hasAttribute('hidden'),
        status: root?.getAttribute('aria-label') ?? null,
        documentLocale: document.documentElement.lang,
        statusLocale: root?.getAttribute('lang') ?? null,
        technicalLocales: [...document.querySelectorAll(
          '.lv-escape-act, .lv-escape-k, .lv-escape-v, .lv-escape-pressure',
        )].map((node) => node.getAttribute('lang')),
      };
    });
    const separation = telemetry?.objective?.kind === 'escape'
      ? telemetry.objective.pathProgress - telemetry.objective.shockwaveProgress
      : null;
    verify(phase === 'flying'
      && hud.visible
      && hud.pressure === 'critical'
      && hud.calloutVisible
      && hud.callout?.includes('SHOCKFRONT')
      && hud.statusLocale === hud.documentLocale
      && (hud.statusLocale === 'ko' ? /[가-힣]/u.test(hud.status) : !/[가-힣]/u.test(hud.status))
      && hud.technicalLocales.length === 6
      && hud.technicalLocales.every((locale) => locale === 'en')
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
    name: 'Production escape results preserve unlock ordering and exact PB comparison',
    assertion: 'A first clear shows NEW BEST before DEAD SIGNAL, while a seeded slower repeat shows its exact delta with one reordered action set.',
  }, async () => {
    verify(routeOutcome.ok && perfOutcome.ok,
      'Route/performance setup failed before the production journey.', { routeOutcome, perfOutcome });
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'clearVantage');
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    const flyEscape = async () => {
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
      return { phase, steppedFrames };
    };
    const readResultUi = () => page.evaluate(() => ({
      newBest: document.querySelector('.lv-newbest')?.textContent?.trim() ?? '',
      comparison: document.querySelector('.lv-res-delta')?.textContent?.trim() ?? '',
      unlockStageId: document.querySelector('.lv-stage-unlock')?.getAttribute('data-stage-id') ?? null,
      actions: [...document.querySelectorAll('[data-view="results"][data-open="1"] [data-action]')]
        .map((node) => node.getAttribute('data-action')),
    }));

    const firstFlight = await flyEscape();
    const firstResult = await callHarness(page, 'result');
    const firstTelemetry = await callHarness(page, 'telemetry');
    const firstProgress = await callHarness(page, 'progress');
    const firstErrors = await callHarness(page, 'errors');
    const firstUi = await readResultUi();
    verify(firstFlight.phase === 'finished'
      && firstResult?.kind === 'escape'
      && firstResult?.missionId === 'last-ascent'
      && firstResult?.totalTime >= 100
      && firstResult?.totalTime <= 120
      && firstResult?.hullRemaining > 0
      && firstResult?.checkpointsCleared === 3
      && firstResult?.checkpointsTotal === 3
      && firstResult?.secondsAhead >= 3
      && firstResult?.secondsAhead <= 8
      && firstResult?.bestTime === null
      && firstResult?.isNewBest === true
      && firstResult?.newlyUnlockedMissionId === 'dead-signal'
      && firstTelemetry?.objective?.kind === 'escape'
      && firstProgress?.missions?.['last-ascent']?.cleared === true
      && firstUi.newBest === 'NEW BEST'
      && firstUi.comparison === ''
      && firstUi.unlockStageId === 'dead-signal'
      && firstUi.actions.join(',') === 'next-stage,run-again,stage-select'
      && firstErrors.length === 0,
    'First production escape did not expose NEW BEST and the ordered DEAD SIGNAL unlock.', {
      firstFlight,
      firstResult,
      firstTelemetry,
      firstProgress,
      firstUi,
      firstErrors,
    });

    const bestRecordId = (await callHarness(page, 'course')).recordId;
    const seededBest = 100;
    await page.evaluate(({ recordId, seconds }) => {
      const key = 'last-vector.best.v1';
      const all = JSON.parse(localStorage.getItem(key) ?? '{}');
      all[recordId] = { time: seconds, splits: [] };
      localStorage.setItem(key, JSON.stringify(all));
    }, { recordId: bestRecordId, seconds: seededBest });

    const repeatFlight = await flyEscape();
    const repeatResult = await callHarness(page, 'result');
    const repeatTelemetry = await callHarness(page, 'telemetry');
    const repeatErrors = await callHarness(page, 'errors');
    const repeatUi = await readResultUi();
    const expectedComparison = repeatResult?.kind === 'escape'
      ? `${evidenceDelta(repeatResult.totalTime - seededBest)} vs BEST ${evidenceTime(seededBest)}`
      : '';
    verify(repeatFlight.phase === 'finished'
      && repeatResult?.kind === 'escape'
      && repeatResult.totalTime > seededBest
      && repeatResult.bestTime === seededBest
      && repeatResult.isNewBest === false
      && repeatResult.newlyUnlockedMissionId === null
      && repeatTelemetry?.objective?.kind === 'escape'
      && repeatUi.newBest === ''
      && repeatUi.comparison === expectedComparison
      && repeatUi.unlockStageId === null
      && repeatUi.actions.join(',') === 'run-again,stage-select,next-stage'
      && repeatErrors.length === 0,
    'Seeded slower escape did not expose the exact PB delta and repeat-clear action order.', {
      bestRecordId,
      seededBest,
      repeatFlight,
      repeatResult,
      repeatTelemetry,
      repeatUi,
      expectedComparison,
      repeatErrors,
    });
    return {
      first: {
        flight: firstFlight,
        result: firstResult,
        ui: firstUi,
      },
      personalBest: {
        recordId: bestRecordId,
        seededBest,
        flight: repeatFlight,
        result: repeatResult,
        ui: repeatUi,
        expectedComparison,
      },
    };
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
