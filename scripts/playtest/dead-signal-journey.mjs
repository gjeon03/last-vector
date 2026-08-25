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

  const capture = async (name) => {
    if (!captureJourney) return null;
    await callHarness(page, 'setPaused', [true]);
    // Callouts use real UI time while the production journey advances deterministically. Let
    // transient pointer-lock/contact cards settle before preserving an authored scene.
    await page.waitForTimeout(5_000);
    await callHarness(page, 'present');
    const path = join(options.out, `${name}-dpr${options.deviceScaleFactor}.png`);
    await page.screenshot({ path, type: 'png', scale: 'device' });
    await callHarness(page, 'setPaused', [false]);
    report.addArtifact('screenshot', path, { name, dpr: options.deviceScaleFactor });
    captures.push(path);
    return path;
  };

  await report.check({
    id: 'DEAD-SIGNAL.canonical-boot',
    name: 'A CAIRN clear authorises the canonical DEAD SIGNAL route',
    assertion:
      'Session progress unlocks Chapter 03, ?mission=dead-signal boots one strike world, and the '
      + 'two-node chapter rail/weapon primer are visible.',
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
      && ui.stageNodes.length === 2
      && ui.stageNodes[0]?.id === 'cairn-drift'
      && ui.stageNodes[1]?.id === 'dead-signal'
      && ui.fireRows >= 1,
    'The canonical boot lost its catalog-driven rail or capability-aware FIRE primer.', ui);
    return ui;
  });

  await report.check({
    id: 'DEAD-SIGNAL.production-journey',
    name: 'One focused production journey clears the fixed-target attack run',
    assertion:
      'Real flight/autopilot steering with the production fire/boost command destroys at least '
      + 'three nodes and the core, completes both extraction turns, preserves hull, and persists clear.',
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
      const coreHeldForAuthoredWindow = label !== 'ARRAY CORE' || elapsed >= 85;
      const fire = targetInRange && coreHeldForAuthoredWindow && objective?.coreDestroyed !== true;
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
        && strike.targetsDestroyed >= 1 && after.guidance?.distance < 2_500) {
        await capture('01-shield-run');
        shieldCaptured = true;
      }
      if (!coreCaptured && strike?.kind === 'strike' && strike.act === 'core'
        && strike.coreExposed && !strike.coreDestroyed) {
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
      && result.targetsDestroyed >= 3
      && result.coreDestroyed === true
      && result.hullRemaining > 0
      && telemetry.objective?.kind === 'strike'
      && telemetry.objective.coreDestroyed === true
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
    await capture('04-result');
    const resultUi = await page.evaluate(() => ({
      stats: [...document.querySelectorAll('.lv-res-stat')].map((node) => node.textContent?.trim()),
      actions: [...document.querySelectorAll('[data-view="results"][data-open="1"] [data-action]')]
        .map((node) => node.getAttribute('data-action')),
      objectiveHud: document.querySelector('.lv-strikestatus')?.textContent ?? '',
    }));
    verify(resultUi.stats.some((text) => text?.includes('SHIELD NODES'))
      && resultUi.stats.some((text) => text?.includes('ACCURACY'))
      && resultUi.stats.some((text) => text?.includes('CORE'))
      && resultUi.actions.includes('run-again')
      && resultUi.actions.includes('stage-select'),
    'The strike result omitted objective stats or campaign actions.', resultUi);
    return {
      phase,
      result,
      telemetry: telemetry.objective,
      mastery: progress.missions?.['dead-signal']?.mastery,
      resultUi,
      iterations,
      captures,
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
    verify(second.drawingBufferWidth === options.viewport.width * options.deviceScaleFactor
      && second.drawingBufferHeight === options.viewport.height * options.deviceScaleFactor,
    'The profile did not measure the requested DPR backing store.', {
      requested: options,
      profile: second,
    });
    verify(second.fps >= 30 && second.p95FrameMs <= 40,
      'The focused core profile fell below its proportional interactive threshold.', profiles);
    return profiles;
  });
}
