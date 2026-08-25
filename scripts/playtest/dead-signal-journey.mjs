import { join } from 'node:path';

import {
  callHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'installProgress',
  'routeUrl',
  'setSettings',
  'setDriven',
  'setFixedTimestep',
  'startRun',
  'setAutopilot',
  'setInput',
  'stepSimulation',
  'present',
  'setPaused',
  'profile',
  'telemetry',
  'phase',
  'result',
  'progress',
  'errors',
];

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

await runManagedSuite({
  suite: 'dead-signal-journey',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runJourney,
});

async function runJourney({ report, session, options }) {
  const page = session.page;
  const hz = 60;
  const captureJourney = options.deviceScaleFactor === 1;
  const captures = [];
  let profiles = null;

  const capture = async (name, captureOptions = {}) => {
    if (!captureJourney) return null;
    const pauseSimulation = captureOptions.pauseSimulation !== false;
    if (pauseSimulation) await callHarness(page, 'setPaused', [true]);
    // Callouts use real UI time while the production journey advances deterministically. Let
    // transient pointer-lock/contact cards settle before preserving an authored scene.
    await page.waitForTimeout(5_000);
    await callHarness(page, 'present');
    if (captureOptions.visibleSelector) {
      await page.waitForSelector(captureOptions.visibleSelector, {
        state: 'visible',
        timeout: 10_000,
      });
    }
    const path = join(options.out, `${name}-dpr${options.deviceScaleFactor}.png`);
    await page.screenshot({ path, type: 'png', scale: 'device' });
    if (pauseSimulation) await callHarness(page, 'setPaused', [false]);
    report.addArtifact('screenshot', path, { name, dpr: options.deviceScaleFactor });
    captures.push(path);
    return path;
  };

  await report.check({
    id: 'DEAD-SIGNAL.canonical-boot',
    name: 'CAIRN and LAST ASCENT clears authorise the canonical DEAD SIGNAL route',
    assertion:
      'Session progress unlocks Chapter 03, ?mission=dead-signal boots one strike world, and the '
      + 'three-node chapter rail/weapon primer are visible.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    await callHarness(page, 'installProgress', [{
      version: 2,
      selectedMission: 'dead-signal',
      missions: {
        'cairn-drift': {
          cleared: true,
          clearedAt: 1,
          highestRank: 'A',
          cleanClear: true,
          mastery: {},
        },
        'last-ascent': {
          cleared: true,
          clearedAt: 2,
          highestRank: 'A',
          cleanClear: true,
          mastery: {},
        },
      },
      dormantCourses: {},
    }]);
    const route = new URL(await callHarness(page, 'routeUrl', ['dead-signal']));
    route.searchParams.set('seed', String(options.seed));
    const response = await page.goto(route.href, { waitUntil: 'load', timeout: options.timeoutMs });
    verify(response?.ok(), 'The canonical DEAD SIGNAL route failed to load.', {
      route: route.href,
      status: response?.status(),
    });
    await waitForHarness(page, options.timeoutMs);
    await callHarness(page, 'ready', [], options.timeoutMs);
    await callHarness(page, 'setSettings', [{
      quality: 'high',
      renderScale: 1,
      filmGrain: true,
      chromaticAberration: true,
      motionBlur: true,
    }]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'setFixedTimestep', [1 / hz]);
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing game canvas');
      Object.defineProperty(document, 'pointerLockElement', {
        get: () => canvas,
        configurable: true,
      });
      canvas.requestPointerLock = () => {
        document.dispatchEvent(new Event('pointerlockchange'));
        return Promise.resolve();
      };
      document.exitPointerLock = () => undefined;
    });
    const ui = await page.evaluate(() => ({
      href: location.href,
      stageNodes: [...document.querySelectorAll('.lv-stage-node')].map((node) => ({
        id: node.getAttribute('data-stage-id'),
        text: node.textContent?.trim() ?? '',
      })),
      fireRows: document.querySelectorAll('[data-control="fire"]:not([hidden])').length,
      title: document.querySelector('.lv-title-sector')?.textContent ?? '',
    }));
    verify(new URL(ui.href).searchParams.get('mission') === 'dead-signal'
      && ui.stageNodes.length === 3
      && ui.stageNodes[0]?.id === 'cairn-drift'
      && ui.stageNodes[1]?.id === 'last-ascent'
      && ui.stageNodes[2]?.id === 'dead-signal'
      && ui.fireRows >= 1,
    'The canonical boot lost its catalog-driven rail or capability-aware FIRE primer.', ui);
    return ui;
  });

  await report.check({
    id: 'DEAD-SIGNAL.production-failure-reason',
    name: 'The production objective exposes its authored failure reason',
    assertion:
      'A real pass that breaks three nodes but withholds core fire fails at the end of the core '
      + 'window and the results surface presents its dedicated technical copy.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    let failurePhase = await callHarness(page, 'phase');
    let failureIterations = 0;
    while (failurePhase === 'flying' && failureIterations < 420) {
      const failureTelemetry = await callHarness(page, 'telemetry');
      const boost = Math.floor(failureTelemetry.elapsed) % 5 === 0;
      const strike = failureTelemetry.objective;
      const targetInRange = failureTelemetry.guidance?.distance <= 3_050;
      const label = failureTelemetry.guidance?.label ?? '';
      const fire = targetInRange && (
        label === 'CALIBRATION TARGET'
        || (label.startsWith('SHIELD-') && (strike?.targetsDestroyed ?? 0) < 3)
      );
      await callHarness(page, 'setInput', [{ throttle: 1, fire, boost, brake: false }]);
      await callHarness(page, 'stepSimulation', [30, 1 / hz], 120_000);
      failureIterations++;
      failurePhase = await callHarness(page, 'phase');
    }
    const failureUi = await page.evaluate(() => {
      const body = document.querySelector('.lv-res-body');
      const view = document.querySelector('[data-view="results"]');
      return {
        viewOpen: view?.getAttribute('data-open'),
        reason: body?.getAttribute('data-failure-reason'),
        title: body?.querySelector('.lv-res-title')?.textContent?.trim() ?? '',
        retry: body?.querySelector('[data-action="retry"]')?.textContent?.trim() ?? '',
      };
    });
    verify(failurePhase === 'failed'
      && failureUi.viewOpen === '1'
      && failureUi.reason === 'core-window-missed'
      && failureUi.title === 'CORE WINDOW MISSED'
      && failureUi.retry.length > 0,
    'The no-fire production pass lost its distinct objective failure presentation.', {
      failurePhase,
      failureIterations,
      failureUi,
    });
    return { failurePhase, failureIterations, failureUi };
  });

  await report.check({
    id: 'DEAD-SIGNAL.production-journey',
    name: 'One focused production journey clears the fixed-target attack run',
    assertion:
      'Real flight/autopilot steering with the production fire/boost command destroys exactly '
      + 'three of six nodes and the core, completes both extraction turns, keeps at least 35% hull, '
      + 'and persists clear.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    let shieldCaptured = false;
    let coreCaptured = false;
    let extractCaptured = false;
    let phase = await callHarness(page, 'phase');
    let iterations = 0;

    while (phase !== 'finished' && phase !== 'failed' && iterations < 520) {
      const telemetry = await callHarness(page, 'telemetry');
      const objective = telemetry.objective;
      const elapsed = telemetry.elapsed;
      const label = telemetry.guidance?.label ?? '';
      const targetInRange = telemetry.guidance?.distance <= 3_050;
      const calibration = label === 'CALIBRATION TARGET';
      const shield = label.startsWith('SHIELD-');
      const core = label === 'ARRAY CORE';
      const fire = targetInRange && objective?.coreDestroyed !== true && (
        calibration
        || (shield && (objective?.targetsDestroyed ?? 0) < 3
          && (!captureJourney || shieldCaptured))
        || (core && elapsed >= 85 && coreCaptured)
      );
      const boost = elapsed >= 25
        && (objective?.coreDestroyed === true
          ? Math.floor(elapsed) % 4 === 0
          : Math.floor(elapsed) % 6 === 0);
      await callHarness(page, 'setInput', [{ throttle: 1, fire, boost, brake: false }]);
      await callHarness(page, 'stepSimulation', [15, 1 / hz], 120_000);
      iterations++;

      const after = await callHarness(page, 'telemetry');
      const strike = after.objective;
      if (!shieldCaptured && strike?.kind === 'strike' && strike.act === 'shield-run'
        && after.guidance?.label.startsWith('SHIELD-')
        && after.guidance.distance < 2_800
        && after.guidance.anchor.onScreen) {
        await capture('01-shield-run');
        shieldCaptured = true;
      }
      if (!coreCaptured && strike?.kind === 'strike' && strike.act === 'core'
        && strike.coreExposed && !strike.coreDestroyed
        && after.guidance?.label === 'ARRAY CORE'
        && after.guidance.distance < 1_800
        && after.guidance.anchor.onScreen) {
        // The third node can fall after the world render update in the same fixed step. Advance
        // one fire-safe frame so the newly exposed red-orange core is the scene being preserved.
        await callHarness(page, 'setInput', [{ throttle: 1, fire: false, boost: false, brake: false }]);
        await callHarness(page, 'stepSimulation', [1, 1 / hz], 120_000);
        await capture('02-array-core');
        coreCaptured = true;

        await callHarness(page, 'setPaused', [true]);
        const first = await callHarness(page, 'profile', [1.5], 120_000);
        const second = await callHarness(page, 'profile', [1.5], 120_000);
        await callHarness(page, 'setDriven', [true]);
        await callHarness(page, 'setFixedTimestep', [1 / hz]);
        await callHarness(page, 'setPaused', [false]);
        profiles = { first, second };
      }
      if (!extractCaptured && strike?.kind === 'strike' && strike.coreDestroyed) {
        await capture('03-extraction-turns');
        extractCaptured = true;
      }
      phase = await callHarness(page, 'phase');
    }

    const result = await callHarness(page, 'result');
    const telemetry = await callHarness(page, 'telemetry');
    const progress = await callHarness(page, 'progress');
    const errors = await callHarness(page, 'errors');
    verify(phase === 'finished'
      && result?.kind === 'strike'
      && result?.missionId === 'dead-signal'
      && result.targetsDestroyed === 3
      && result.coreDestroyed === true
      && result.hullRemaining >= 0.35
      && result.cleanRun === true
      && result.bestTime === null
      && result.isNewBest === true
      && telemetry.objective?.kind === 'strike'
      && telemetry.objective.coreDestroyed === true
      && telemetry.objective.extractionTurnsCleared === 2
      && telemetry.objective.extractionTurnsTotal === 2
      && progress.missions?.['dead-signal']?.cleared === true
      && errors.length === 0,
    'The production attack run did not satisfy every success condition.', {
      phase,
      result,
      telemetry,
      progress,
      errors,
      iterations,
    });
    verify(coreCaptured && profiles,
      'The journey never presented the authored core scene for profiling.', {
        coreCaptured,
        profiles,
        telemetry,
      });
    await capture('04-result', {
      pauseSimulation: false,
      visibleSelector: '[data-view="results"][data-open="1"] .lv-res-stat',
    });
    const resultUi = await page.evaluate(() => ({
      stats: [...document.querySelectorAll('.lv-res-stat')].map((node) => node.textContent?.trim()),
      actions: [...document.querySelectorAll('[data-view="results"][data-open="1"] [data-action]')]
        .map((node) => node.getAttribute('data-action')),
      objectiveHud: document.querySelector('.lv-strikestatus')?.textContent ?? '',
      newBest: document.querySelector('.lv-newbest')?.textContent?.trim() ?? '',
      comparison: document.querySelector('.lv-res-delta')?.textContent?.trim() ?? '',
    }));
    verify(resultUi.stats.some((text) => text?.includes('SHIELD NODES'))
      && resultUi.stats.some((text) => text?.includes('ACCURACY'))
      && resultUi.stats.some((text) => text?.includes('CORE'))
      && resultUi.actions.includes('run-again')
      && resultUi.actions.includes('stage-select')
      && resultUi.newBest === 'NEW BEST'
      && resultUi.comparison === '',
    'The strike result omitted objective stats or campaign actions.', resultUi);

    // Preserve the actual NEW BEST presentation above, then install a faster PB under the exact
    // mission/ruleset/seed identity and fly one comparison pass through the same production path.
    const bestRecordId = `${result.missionId}-r${result.rulesetVersion}-${options.seed >>> 0}`;
    const seededBest = 100;
    await page.evaluate(({ recordId, seconds }) => {
      const key = 'last-vector.best.v1';
      const all = JSON.parse(localStorage.getItem(key) ?? '{}');
      all[recordId] = { time: seconds, splits: [] };
      localStorage.setItem(key, JSON.stringify(all));
    }, { recordId: bestRecordId, seconds: seededBest });
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    let comparisonPhase = await callHarness(page, 'phase');
    let comparisonIterations = 0;
    let comparisonShieldReady = false;
    let comparisonCoreReady = false;
    while (comparisonPhase === 'flying' && comparisonIterations < 520) {
      const sample = await callHarness(page, 'telemetry');
      const strike = sample.objective;
      const label = sample.guidance?.label ?? '';
      const targetInRange = sample.guidance?.distance <= 3_050;
      if (!comparisonShieldReady && label.startsWith('SHIELD-')
        && sample.guidance?.distance < 2_800
        && sample.guidance?.anchor.onScreen) comparisonShieldReady = true;
      if (!comparisonCoreReady && label === 'ARRAY CORE'
        && sample.guidance?.distance < 1_800
        && sample.guidance?.anchor.onScreen) comparisonCoreReady = true;
      const fire = targetInRange && strike?.coreDestroyed !== true && (
        label === 'CALIBRATION TARGET'
        || (comparisonShieldReady && label.startsWith('SHIELD-')
          && (strike?.targetsDestroyed ?? 0) < 3)
        || (comparisonCoreReady && label === 'ARRAY CORE' && sample.elapsed >= 85)
      );
      const boost = sample.elapsed >= 25 && Math.floor(sample.elapsed) % 5 === 0;
      await callHarness(page, 'setInput', [{ throttle: 1, fire, boost, brake: false }]);
      await callHarness(page, 'stepSimulation', [15, 1 / hz], 120_000);
      comparisonIterations++;
      comparisonPhase = await callHarness(page, 'phase');
    }
    const comparisonResult = await callHarness(page, 'result');
    const comparisonTelemetry = await callHarness(page, 'telemetry');
    const expectedComparison = comparisonResult?.kind === 'strike'
      ? `${evidenceDelta(comparisonResult.totalTime - seededBest)} vs BEST ${evidenceTime(seededBest)}`
      : '';
    const comparisonUi = await page.evaluate(() => ({
      newBest: document.querySelector('.lv-newbest')?.textContent?.trim() ?? '',
      comparison: document.querySelector('.lv-res-delta')?.textContent?.trim() ?? '',
      shield: [...document.querySelectorAll('.lv-res-stat')]
        .map((node) => node.textContent?.trim() ?? '')
        .find((text) => text.includes('SHIELD NODES')) ?? '',
    }));
    verify(comparisonPhase === 'finished'
      && comparisonResult?.kind === 'strike'
      && comparisonResult.bestTime === seededBest
      && comparisonResult.isNewBest === false
      && comparisonResult.targetsDestroyed === 3
      && comparisonResult.targetsTotal === 6
      && comparisonResult.cleanRun === true
      && comparisonUi.newBest === ''
      && comparisonUi.comparison === expectedComparison
      && comparisonUi.shield.includes('3 / 6'),
    'The ruleset-partitioned strike PB comparison was not exact or visible.', {
      bestRecordId,
      seededBest,
      comparisonPhase,
      comparisonResult,
      expectedComparison,
      comparisonUi,
      comparisonIterations,
      comparisonTelemetry,
    });
    return {
      phase,
      result,
      telemetry: telemetry.objective,
      mastery: progress.missions?.['dead-signal']?.mastery,
      resultUi,
      iterations,
      captures,
      personalBest: {
        first: { bestTime: result.bestTime, isNewBest: result.isNewBest, ui: resultUi.newBest },
        recordId: bestRecordId,
        comparison: comparisonResult,
        comparisonUi,
        expectedComparison,
        telemetry: comparisonTelemetry.objective,
      },
    };
  });

  await report.check({
    id: 'DEAD-SIGNAL.hardest-scene-profile',
    name: `The settled core scene stays inside global ceilings at DPR ${options.deviceScaleFactor}`,
    assertion:
      'Two consecutive paused-core profiles retain the same program count, meet global resource '
      + 'ceilings, allocate the expected backing store, and sustain an interactive frame rate.',
  }, () => {
    verify(profiles, 'No core-scene profile was collected.');
    const { first, second } = profiles;
    const within = (sample) => sample.drawCalls <= 160
      && sample.triangles <= 620_000
      && sample.geometries <= 155
      && sample.textures <= 16
      && sample.programs <= 55;
    verify(within(first) && within(second),
      'The core scene exceeded a global renderer ceiling.', profiles);
    verify(first.programs === second.programs,
      'The settled core scene compiled a late shader program.', profiles);
    const fillBudgetPixels = 2_500_000;
    const budgetedDpr = Math.min(
      options.deviceScaleFactor,
      2,
      Math.sqrt(fillBudgetPixels / (options.viewport.width * options.viewport.height)),
    );
    const expectedWidth = Math.max(320, Math.round(options.viewport.width * budgetedDpr));
    const expectedHeight = Math.max(240, Math.round(options.viewport.height * budgetedDpr));
    verify(second.drawingBufferWidth === expectedWidth
      && second.drawingBufferHeight === expectedHeight,
    'The profile did not measure the renderer fill-budget DPR policy.', {
      requested: options,
      budgetedDpr,
      expectedWidth,
      expectedHeight,
      profile: second,
    });
    verify(second.fps >= 30 && second.p95FrameMs <= 40,
      'The focused core profile fell below its proportional interactive threshold.', profiles);
    return profiles;
  });
}
