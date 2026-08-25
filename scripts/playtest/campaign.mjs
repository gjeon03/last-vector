import {
  callHarness,
  reloadHarness,
  runManagedSuite,
  verify,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'course',
  'catalog',
  'progress',
  'routeUrl',
  'telemetry',
  'startRun',
  'setDriven',
  'setAutopilot',
  'setSettings',
  'stepSimulation',
  'phase',
  'result',
  'errors',
];

const FAST_SETTINGS = {
  quality: 'low',
  renderScale: 0.6,
  filmGrain: false,
  chromaticAberration: false,
  motionBlur: false,
};

await runManagedSuite({
  suite: 'campaign',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runMissionProof,
});

async function runMissionProof({ report, session, options }) {
  const page = session.page;
  const cairnResultActions = [];

  await report.check({
    id: 'MISSION.three-chapter-title',
    name: 'A fresh title exposes the three-node sequential campaign rail',
    assertion: 'Catalog/progress/URL use mission v2 while later chapters begin locked.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await callHarness(page, 'setSettings', [FAST_SETTINGS]);
    await callHarness(page, 'setDriven', [true]);
    const course = await callHarness(page, 'course');
    const catalog = await callHarness(page, 'catalog');
    const progress = await callHarness(page, 'progress');
    const routeUrl = new URL(await callHarness(page, 'routeUrl', ['cairn-drift']));
    const title = await page.evaluate(() => ({
      chapter: document.querySelector('.lv-stage-chapter')?.textContent ?? null,
      stageNodes: document.querySelectorAll('.lv-stage-node').length,
      begin: document.querySelector('[data-view="title"] [data-action="begin"]')?.textContent ?? null,
    }));
    const evidence = { course, catalog, progress, routeUrl: routeUrl.href, title };
    verify(course.courseId === 'cairn-drift'
      && course.gateCount === 9
      && course.recordId === `cairn-drift-r2-${course.seed}`,
    'Boot did not build the ruleset-partitioned CAIRN mission.', evidence);
    verify(JSON.stringify(catalog.order)
      === JSON.stringify(['cairn-drift', 'last-ascent', 'dead-signal'])
      && JSON.stringify(catalog.recognizedOrder)
        === JSON.stringify(['cairn-drift', 'needle-grave', 'wreckline', 'ringfall'])
      && catalog.courses.filter((entry) => entry.active).length === 1,
    'Active and dormant catalogs are not partitioned.', evidence);
    verify(progress.version === 2
      && progress.selectedMission === 'cairn-drift'
      && title.stageNodes === 3
      && title.chapter === 'THE FALL OF ACHRA'
      && title.begin?.includes('START FLIGHT'),
    'The title lost its three-node rail or Chapter 01 start action.', evidence);
    verify(routeUrl.searchParams.get('mission') === 'cairn-drift'
      && !routeUrl.searchParams.has('course'),
    'Harness navigation did not mint a canonical mission URL.', evidence);
    return evidence;
  });

  await report.check({
    id: 'MISSION.cairn-production-60-120',
    name: 'CAIRN completes cleanly through the production path at 60 and 120 Hz',
    assertion: 'Both fixed-step runs clear nine gates and extraction with hull intact and no errors.',
  }, async () => {
    const runs = [];
    for (const fps of [60, 120]) {
      if (runs.length > 0) await reloadHarness(page, options.timeoutMs);
      await callHarness(page, 'setSettings', [FAST_SETTINGS]);
      await callHarness(page, 'setDriven', [true]);
      await callHarness(page, 'startRun', [{ skipIntro: true }]);
      await callHarness(page, 'setAutopilot', [true, { skill: 0.75 }]);
      const maximumFrames = Math.ceil(Math.min(options.maxSimSeconds, 140) * fps);
      const chunkFrames = fps * 5;
      let steppedFrames = 0;
      let phase = await callHarness(page, 'phase');
      while (steppedFrames < maximumFrames && phase !== 'finished' && phase !== 'failed') {
        await callHarness(page, 'stepSimulation', [chunkFrames, 1 / fps], 120_000);
        steppedFrames += chunkFrames;
        phase = await callHarness(page, 'phase');
      }
      const run = {
        fps,
        steppedFrames,
        phase,
        result: await callHarness(page, 'result'),
        telemetry: await callHarness(page, 'telemetry'),
        errors: await callHarness(page, 'errors'),
        actions: await page.locator(
          '[data-view="results"][data-open="1"] [data-action]',
        ).evaluateAll((nodes) => nodes.map((node) => ({
          action: node.getAttribute('data-action'),
          text: node.textContent?.trim() ?? '',
        }))),
      };
      verify(run.phase === 'finished'
        && run.result?.kind === 'gate-race'
        && run.result?.missionId === 'cairn-drift'
        && run.result?.rulesetVersion === 2
        && run.result?.gatesCleared === 9
        && run.result?.gatesTotal === 9
        && run.result?.cleanRun === true
        && run.result?.hullRemaining === 1
        && run.telemetry.objective?.kind === 'gate-race'
        && run.telemetry.objective?.complete === true
        && run.errors.length === 0,
      `CAIRN production proof failed at ${fps} Hz.`, run);
      runs.push(run);
      cairnResultActions.push(run.actions);
    }
    return runs;
  });

  await report.check({
    id: 'MISSION.result-actions',
    name: 'A first CAIRN clear offers the newly unlocked LAST ASCENT',
    assertion: 'NEXT CHAPTER, RUN AGAIN, and CHAPTER SELECT render without a terminal RETURN.',
  }, async () => {
    const [firstClear, repeatClear] = cairnResultActions;
    verify(JSON.stringify(firstClear?.map((entry) => entry.action))
      === JSON.stringify(['next-stage', 'run-again', 'stage-select'])
      && JSON.stringify(repeatClear?.map((entry) => entry.action))
        === JSON.stringify(['run-again', 'stage-select', 'next-stage']),
    'First-clear and repeat-clear results did not expose one ordered action set each.', {
      firstClear,
      repeatClear,
    });
    return { firstClear, repeatClear };
  });
}
