import {
  callHarness,
  reloadHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'course',
  'catalog',
  'progress',
  'installProgress',
  'landmarks',
  'telemetry',
  'startRun',
  'stageLandmarkCollision',
  'setDriven',
  'setAutopilot',
  'setSettings',
  'step',
  'stepSimulation',
  'phase',
  'result',
  'errors',
];

const STAGES = [
  {
    id: 'cairn-drift',
    gates: 9,
    next: 'wreckline',
    landmarkKind: 'cairn',
    landmarks: ['broken-span'],
  },
  {
    id: 'wreckline',
    gates: 8,
    next: 'ringfall',
    landmarkKind: 'wreckline',
    landmarks: ['twin-keels', 'the-fracture', 'engine-spine'],
  },
  {
    id: 'ringfall',
    gates: 9,
    next: null,
    landmarkKind: 'ringfall',
    landmarks: ['ring-wall', 'twin-spires', 'orison-arch'],
  },
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
  execute: runCampaign,
});

async function runCampaign({ report, session, options }) {
  const page = session.page;
  const signatures = new Map();

  const freshCheck = await report.check({
    id: 'CAMPAIGN.fresh-stage-rail',
    name: 'A fresh Chapter 01 boot exposes one compact three-stage rail',
    assertion:
      'Harness v1.9 reports the active and recognized catalogs, CAIRN is the only initially '
      + 'available stage, and keyboard confirmation on a discoverable locked node cannot change '
      + 'the run target or navigate.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await callHarness(page, 'setSettings', [FAST_SETTINGS]);
    await callHarness(page, 'setDriven', [true]);

    const beforeUrl = page.url();
    const before = await titleSnapshot(page);
    const course = await callHarness(page, 'course');
    const catalog = await callHarness(page, 'catalog');
    const progress = await callHarness(page, 'progress');
    const landmarks = await callHarness(page, 'landmarks');

    await page.locator('[data-stage-id="cairn-drift"]').focus();
    await page.keyboard.press('ArrowRight');
    const focusedAfterArrow = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-stage-id') ?? null);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);

    const after = await titleSnapshot(page);
    const evidence = {
      version: await page.evaluate(() => window.__LV?.version ?? null),
      course,
      catalog,
      progress,
      landmarks,
      before,
      after,
      focusedAfterArrow,
      beforeUrl,
      afterUrl: page.url(),
      phase: await callHarness(page, 'phase'),
    };

    verify(evidence.version === '1.9.0', 'Campaign harness version changed.', evidence);
    verify(evidence.phase === 'title'
      && course.courseId === 'cairn-drift'
      && course.gateCount === 9
      && course.recordId === `cairn-drift-${course.seed}`,
    'Fresh boot did not load the historical CAIRN stage on the title.', evidence);
    verify(JSON.stringify(catalog.order) === JSON.stringify(STAGES.map((stage) => stage.id))
      && JSON.stringify(catalog.recognizedOrder)
        === JSON.stringify(['cairn-drift', 'needle-grave', 'wreckline', 'ringfall']),
    'Harness catalog does not separate Chapter 01 order from recognized data.', evidence);
    const needle = catalog.courses.find((candidate) => candidate.id === 'needle-grave');
    const wreckline = catalog.courses.find((candidate) => candidate.id === 'wreckline');
    const ringfall = catalog.courses.find((candidate) => candidate.id === 'ringfall');
    verify(needle?.active === false && needle?.nextCourseId === null
      && wreckline?.active === true && wreckline?.nextCourseId === 'ringfall'
      && ringfall?.active === true && ringfall?.nextCourseId === null,
    'Catalog authorization or next-stage projection is wrong.', evidence);
    verify(progress.selectedCourse === 'cairn-drift'
      && Object.keys(progress.courses ?? {}).length === 0,
    'Fresh browser context inherited campaign progress.', evidence);
    verify(landmarks.kind === 'cairn'
      && JSON.stringify(landmarks.landmarks) === JSON.stringify(['broken-span'])
      && typeof landmarks.signature === 'string' && landmarks.signature.length > 0,
    'CAIRN landmark identity is missing from the boot-built world.', evidence);
    signatures.set('cairn-drift', landmarks.signature);
    verify(before.open && before.nodes.length === 3
      && JSON.stringify(before.nodes.map(({ id }) => id)) === JSON.stringify(STAGES.map((stage) => stage.id))
      && JSON.stringify(before.nodes.map(({ state }) => state))
        === JSON.stringify(['available', 'locked', 'locked'])
      && before.nodes[0]?.selected === '1'
      && before.nodes[1]?.ariaDisabled === 'true'
      && before.nodes[2]?.ariaDisabled === 'true',
    'Fresh title rail does not expose one available and two discoverable locked nodes.', evidence);
    verify(focusedAfterArrow === 'wreckline',
      'Horizontal rail navigation did not discover the next locked node.', evidence);
    verify(page.url() === beforeUrl
      && after.nodes.find(({ id }) => id === 'cairn-drift')?.selected === '1'
      && after.nodes.find(({ id }) => id === 'wreckline')?.selected === '0',
    'Confirming a locked WRECKLINE node changed selection or navigated.', evidence);
    return evidence;
  });

  const cairnCheck = await report.check({
    id: 'CAMPAIGN.cairn-first-clear',
    name: 'The real title and briefing flow clears 01-1 and offers 01-2',
    assertion:
      'START FLIGHT opens the briefing, ENGAGE runs the real countdown, deterministic autopilot '
      + 'completes CAIRN cleanly, one authored radio line is visible, and first-clear results '
      + 'lead with NEXT STAGE for WRECKLINE.',
  }, async () => {
    verify(freshCheck.ok, 'Fresh stage rail prerequisite failed; CAIRN journey was not attempted.');
    await page.locator('[data-view="title"][data-open="1"] [data-action="begin"]').click();
    await page.waitForFunction(() => window.__LV?.phase() === 'briefing');
    const briefing = await openViewSnapshot(page, 'briefing');
    const run = await engageAndComplete(page, options, STAGES[0]);
    signatures.set(STAGES[0].id, run.landmarks.signature);

    const evidence = { briefing, ...run };
    verify(briefing.open && briefing.actionIds.includes('engage'),
      'START FLIGHT did not open the real stage briefing.', evidence);
    verify(run.phaseAfterEngage === 'countdown',
      'ENGAGE bypassed the player countdown path.', evidence);
    verifySuccessfulStage(run, STAGES[0]);
    verify(run.radio !== null && run.radio.text.length > 0 && run.radio.speaker.length > 0,
      'No CAIRN radio subtitle was actually presented.', evidence);
    verify(JSON.stringify(run.actions.map(({ action }) => action))
      === JSON.stringify(['next-stage', 'run-again', 'stage-select'])
      && run.actions[0]?.stageId === 'wreckline',
    'CAIRN first-clear actions do not lead with WRECKLINE.', evidence);
    verify(run.result.newlyUnlockedCourseId === 'wreckline'
      && run.progress.courses?.['cairn-drift']?.cleared === true,
    'CAIRN clear did not persist or reveal WRECKLINE.', evidence);
    return evidence;
  });

  const wrecklineCheck = await report.check({
    id: 'CAMPAIGN.wreckline-handoff',
    name: 'NEXT STAGE performs a real reload into 01-2 and reveals 01-3',
    assertion:
      'The CAIRN result action persists selection before a full navigation, boots WRECKLINE in '
      + 'briefing without the debug seed, then a clean deterministic clear presents radio and '
      + 'NEXT STAGE for RINGFALL.',
  }, async () => {
    verify(cairnCheck.ok, 'CAIRN first-clear prerequisite failed; WRECKLINE handoff was not attempted.');
    const handoff = await clickNextStageAndReload(page, 'wreckline', options.timeoutMs);
    const course = await callHarness(page, 'course');
    const progressBefore = await callHarness(page, 'progress');
    const briefing = await openViewSnapshot(page, 'briefing');
    const run = await engageAndComplete(page, options, STAGES[1]);
    signatures.set(STAGES[1].id, run.landmarks.signature);

    const evidence = { handoff, course, progressBefore, briefing, ...run };
    verify(course.courseId === 'wreckline'
      && course.resolution?.source === 'url'
      && new URL(page.url()).searchParams.get('course') === 'wreckline'
      && !new URL(handoff.url).searchParams.has('seed'),
    'NEXT STAGE did not perform the canonical WRECKLINE reload.', evidence);
    verify(progressBefore.selectedCourse === 'wreckline'
      && progressBefore.courses?.['cairn-drift']?.cleared === true
      && briefing.open,
    'WRECKLINE handoff lost selection, prior progress, or briefing state.', evidence);
    verifySuccessfulStage(run, STAGES[1]);
    verify(run.radio !== null && run.radio.text.length > 0,
      'No WRECKLINE radio subtitle was actually presented.', evidence);
    verify(JSON.stringify(run.actions.map(({ action }) => action))
      === JSON.stringify(['next-stage', 'run-again', 'stage-select'])
      && run.actions[0]?.stageId === 'ringfall'
      && run.result.newlyUnlockedCourseId === 'ringfall',
    'WRECKLINE first-clear result does not reveal RINGFALL.', evidence);
    verify(signatures.get('wreckline') !== signatures.get('cairn-drift'),
      'WRECKLINE landmark signature is not distinct from CAIRN.', evidence);
    return evidence;
  });

  const ringfallCheck = await report.check({
    id: 'CAMPAIGN.ringfall-final',
    name: 'The second real reload clears 01-3 without inventing another stage',
    assertion:
      'RINGFALL boots into briefing, presents authored radio, completes cleanly, and the chapter '
      + 'final result contains RUN AGAIN, STAGE SELECT and RETURN but no NEXT STAGE.',
  }, async () => {
    verify(wrecklineCheck.ok, 'WRECKLINE prerequisite failed; RINGFALL handoff was not attempted.');
    const handoff = await clickNextStageAndReload(page, 'ringfall', options.timeoutMs);
    const course = await callHarness(page, 'course');
    const progressBefore = await callHarness(page, 'progress');
    const briefing = await openViewSnapshot(page, 'briefing');
    const run = await engageAndComplete(page, options, STAGES[2]);
    signatures.set(STAGES[2].id, run.landmarks.signature);

    const evidence = { handoff, course, progressBefore, briefing, ...run };
    verify(course.courseId === 'ringfall'
      && course.resolution?.source === 'url'
      && progressBefore.selectedCourse === 'ringfall'
      && progressBefore.courses?.wreckline?.cleared === true
      && briefing.open,
    'RINGFALL handoff lost route identity, prior clear, or briefing state.', evidence);
    verifySuccessfulStage(run, STAGES[2]);
    verify(run.radio !== null && run.radio.text.length > 0,
      'No RINGFALL radio subtitle was actually presented.', evidence);
    verify(JSON.stringify(run.actions.map(({ action }) => action))
      === JSON.stringify(['run-again', 'stage-select', 'return'])
      && !run.actions.some(({ action }) => action === 'next-stage')
      && run.result.newlyUnlockedCourseId === null,
    'Chapter-final result exposes an invalid NEXT STAGE flow.', evidence);
    verify(new Set(signatures.values()).size === 3,
      'The three boot-built stage landmark signatures are not distinct.', {
        signatures: Object.fromEntries(signatures),
      });
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.stage-select-refresh-responsive',
    name: 'STAGE SELECT and refresh preserve a one-row responsive completed rail',
    assertion:
      'STAGE SELECT consumes the one-shot briefing flag and returns to the title with RINGFALL '
      + 'selected; a natural refresh retains all clears, while the rail stays one row with '
      + 'usable targets at 1920x1080, 375x667 and 640x360.',
  }, async () => {
    verify(ringfallCheck.ok, 'RINGFALL prerequisite failed; final rail persistence was not attempted.');
    await page.locator(
      '[data-view="results"][data-open="1"] [data-action="stage-select"]',
    ).click();
    await page.waitForFunction(() => window.__LV?.phase() === 'title');
    const beforeRefresh = {
      url: page.url(),
      title: await titleSnapshot(page),
      progress: await callHarness(page, 'progress'),
    };
    verify(!new URL(beforeRefresh.url).searchParams.has('briefing'),
      'STAGE SELECT left the one-shot briefing flag in the URL.', beforeRefresh);

    await reloadHarness(page, options.timeoutMs);
    await callHarness(page, 'setDriven', [true]);
    const progress = await callHarness(page, 'progress');
    const phase = await callHarness(page, 'phase');
    const viewports = [];
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 375, height: 667 },
      { width: 640, height: 360 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(50);
      viewports.push(await railGeometry(page));
    }

    const afterRefresh = await titleSnapshot(page);
    const evidence = { beforeRefresh, phase, progress, afterRefresh, viewports };
    verify(phase === 'title'
      && progress.selectedCourse === 'ringfall'
      && STAGES.every(({ id }) => progress.courses?.[id]?.cleared === true),
    'Refresh did not retain the completed Chapter 01 selection and clear facts.', evidence);
    verify(afterRefresh.nodes.every(({ state }) => state === 'cleared')
      && afterRefresh.nodes.find(({ id }) => id === 'ringfall')?.selected === '1',
    'Completed stage rail did not restore RINGFALL selection.', evidence);
    for (const geometry of viewports) {
      verify(geometry.nodes.length === 3
        && geometry.oneRow
        && geometry.targetsAtLeast24
        && geometry.railInsideViewport
        && geometry.noHorizontalOverflow
        && geometry.startInsideViewport,
      `Stage rail failed responsive geometry at ${geometry.viewport.width}x${geometry.viewport.height}.`,
      evidence);
    }
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.direct-production-guards',
    name: 'Both new stages stay deterministic at 120 Hz and landmark contact is physical',
    assertion:
      'Small-viewport production simulation completes WRECKLINE and RINGFALL cleanly at 120 Hz '
      + 'with bounded pilot offset, then a staged ORISON landmark contact changes no hull until '
      + 'one real 120 Hz frame applies the expected damage and log entry.',
  }, async () => {
    await waitForHarness(page, options.timeoutMs);
    await callHarness(page, 'ready', [], options.timeoutMs);
    const installed = await callHarness(page, 'installProgress', [{
      version: 1,
      selectedCourse: 'ringfall',
      courses: {
        'cairn-drift': {
          cleared: true,
          clearedAt: 101,
          highestRank: 'S',
          cleanClear: true,
          precisionClear: true,
        },
        wreckline: {
          cleared: true,
          clearedAt: 102,
          highestRank: 'S',
          cleanClear: true,
          precisionClear: true,
        },
        ringfall: {
          cleared: true,
          clearedAt: 103,
          highestRank: 'A',
          cleanClear: true,
          precisionClear: true,
        },
      },
    }]);
    verify(installed.reloadSafe === true,
      'Direct production guard progress was not safe to reload.', installed);

    await page.setViewportSize({ width: 320, height: 180 });
    const wreckline = await completeDirectStage(page, options, STAGES[1], 120);
    const ringfall = await completeDirectStage(page, options, STAGES[2], 120);
    const collision = await verifyRingfallLandmarkContact(page);
    const evidence = { installed, wreckline, ringfall, collision };

    for (const run of [wreckline, ringfall]) {
      verify(run.phase === 'finished'
        && run.result?.courseId === run.stageId
        && run.result?.gatesCleared === run.gates
        && run.result?.gatesTotal === run.gates
        && run.result?.cleanRun === true
        && run.result?.maxGateOffset <= 0.96
        && run.errors.length === 0,
      `${run.stageId} did not complete the bounded 120 Hz production arm.`, evidence);
    }
    verify(collision.staged?.colliderId === 'orison-arch-crown-3'
      && collision.beforeHull === 1
      && collision.afterStagingHull === 1
      && Math.abs(collision.afterStepHull - 0.78055) <= 0.000001
      && collision.afterLogCount === collision.beforeLogCount + 1
      && collision.lastLogType === 'log.hull-contact'
      && collision.errors.length === 0,
    'RINGFALL landmark contact did not traverse the one-frame production damage path.', evidence);
    return evidence;
  });
}

async function completeDirectStage(page, options, stage, hz) {
  const url = new URL(page.url());
  url.search = '';
  url.searchParams.set('course', stage.id);
  const response = await page.goto(url.href, { waitUntil: 'load', timeout: options.timeoutMs });
  verify(response?.ok(), `Direct ${stage.id} document failed to load.`, {
    stageId: stage.id,
    status: response?.status() ?? null,
    url: url.href,
  });
  await waitForHarness(page, options.timeoutMs);
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setSettings', [{ ...FAST_SETTINGS, renderScale: 0.5 }]);
  await callHarness(page, 'setDriven', [true]);
  const course = await callHarness(page, 'course');
  const landmarks = await callHarness(page, 'landmarks');
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  const phaseAfterStart = await callHarness(page, 'phase');
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);

  const maximumFrames = Math.ceil(Math.min(options.maxSimSeconds, 120) * hz);
  const chunkFrames = 240;
  let simulatedFrames = 0;
  let phase = phaseAfterStart;
  while (simulatedFrames < maximumFrames && phase !== 'finished' && phase !== 'failed') {
    const frames = Math.min(chunkFrames, maximumFrames - simulatedFrames);
    await callHarness(page, 'stepSimulation', [frames, 1 / hz], options.timeoutMs);
    simulatedFrames += frames;
    phase = await callHarness(page, 'phase');
  }

  return {
    stageId: stage.id,
    gates: stage.gates,
    hz,
    phaseAfterStart,
    phase,
    simulatedFrames,
    course,
    landmarks,
    result: await callHarness(page, 'result'),
    errors: await callHarness(page, 'errors'),
  };
}

async function verifyRingfallLandmarkContact(page) {
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [false]);
  const before = await callHarness(page, 'telemetry');
  const staged = await callHarness(page, 'stageLandmarkCollision');
  const afterStaging = await callHarness(page, 'telemetry');
  await callHarness(page, 'step', [1, 1 / 120]);
  const afterStep = await callHarness(page, 'telemetry');
  return {
    staged,
    beforeHull: before.hull,
    afterStagingHull: afterStaging.hull,
    afterStepHull: afterStep.hull,
    beforeLogCount: before.log.length,
    afterLogCount: afterStep.log.length,
    lastLogType: afterStep.log.at(-1)?.message?.type ?? null,
    errors: await callHarness(page, 'errors'),
  };
}

async function engageAndComplete(page, options, stage) {
  await callHarness(page, 'setSettings', [FAST_SETTINGS]);
  await callHarness(page, 'setDriven', [true]);
  const landmarks = await callHarness(page, 'landmarks');
  const engage = page.locator(
    '[data-view="briefing"][data-open="1"] [data-action="engage"]',
  );
  await engage.waitFor({ state: 'visible', timeout: options.timeoutMs });
  await engage.click();
  const phaseAfterEngage = await callHarness(page, 'phase');
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);

  // Authored stages target 60–85 seconds including CAIRN. Two minutes is ample diagnostic room
  // without turning a stuck pilot into a five-minute browser run.
  const maximumFrames = Math.ceil(Math.min(options.maxSimSeconds, 120) * 60);
  let steppedFrames = 0;
  let radio = null;
  let phase = phaseAfterEngage;
  while (steppedFrames < maximumFrames && phase !== 'finished' && phase !== 'failed') {
    const frames = radio === null ? 60 : 300;
    await callHarness(page, 'step', [frames, 1 / 60], 120_000);
    steppedFrames += frames;
    if (radio === null) radio = await radioSnapshot(page);
    phase = await callHarness(page, 'phase');
  }

  const result = await callHarness(page, 'result');
  const progress = await callHarness(page, 'progress');
  const actions = await resultActions(page);
  return {
    stageId: stage.id,
    phaseAfterEngage,
    phase,
    steppedFrames,
    result,
    progress,
    actions,
    radio,
    landmarks,
  };
}

function verifySuccessfulStage(run, stage) {
  verify(run.phase === 'finished'
    && run.result?.courseId === stage.id
    && run.result?.gatesCleared === stage.gates
    && run.result?.gatesTotal === stage.gates
    && run.result?.cleanRun === true,
  `${stage.id} did not complete cleanly through the production flight path.`, run);
  verify(run.landmarks.kind === stage.landmarkKind
    && JSON.stringify(run.landmarks.landmarks) === JSON.stringify(stage.landmarks)
    && typeof run.landmarks.signature === 'string'
    && run.landmarks.signature.length > 0
    && run.landmarks.colliders <= 24,
  `${stage.id} loaded the wrong or unbounded landmark world.`, run);
}

async function clickNextStageAndReload(page, stageId, timeoutMs) {
  const button = page.locator(
    `[data-view="results"][data-open="1"] [data-action="next-stage"][data-stage-id="${stageId}"]`,
  );
  await button.waitFor({ state: 'visible', timeout: timeoutMs });
  const navigation = page.waitForNavigation({ waitUntil: 'load', timeout: timeoutMs });
  await button.click();
  const response = await navigation;
  verify(response?.ok(), 'NEXT STAGE navigation did not return a successful document.', {
    stageId,
    status: response?.status() ?? null,
    url: page.url(),
  });
  await waitForHarness(page, timeoutMs);
  await callHarness(page, 'ready', [], timeoutMs);
  return { stageId, status: response.status(), url: page.url() };
}

async function titleSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-view="title"]');
    return {
      open: root?.getAttribute('data-open') === '1',
      nodes: [...(root?.querySelectorAll('[data-stage-id]') ?? [])].map((node) => ({
        id: node.getAttribute('data-stage-id'),
        state: node.getAttribute('data-stage-state'),
        selected: node.getAttribute('data-stage-selected'),
        ariaDisabled: node.getAttribute('aria-disabled'),
        tabIndex: node instanceof HTMLElement ? node.tabIndex : null,
      })),
    };
  });
}

async function openViewSnapshot(page, view) {
  return page.evaluate((viewName) => {
    const root = document.querySelector(`[data-view="${viewName}"]`);
    return {
      open: root?.getAttribute('data-open') === '1',
      actionIds: [...(root?.querySelectorAll('[data-action]') ?? [])]
        .map((node) => node.getAttribute('data-action')),
    };
  }, view);
}

async function radioSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.lv-radio[data-on="1"]');
    if (!(root instanceof HTMLElement) || root.getClientRects().length === 0) return null;
    return {
      speaker: root.querySelector('.lv-radio-who')?.textContent?.trim() ?? '',
      text: root.querySelector('.lv-radio-text')?.textContent?.trim() ?? '',
    };
  });
}

async function resultActions(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-view="results"][data-open="1"]');
    return [...(root?.querySelectorAll('.lv-actions--res [data-action]') ?? [])]
      .filter((node) => node instanceof HTMLElement
        && getComputedStyle(node).display !== 'none'
        && node.getClientRects().length > 0)
      .map((node) => ({
        action: node.getAttribute('data-action'),
        stageId: node.getAttribute('data-stage-id'),
        text: node.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      }));
  });
}

async function railGeometry(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('.lv-stage-rail');
    const start = document.querySelector('[data-view="title"] [data-action="begin"]');
    const nodes = [...document.querySelectorAll('.lv-stage-rail [data-stage-id]')];
    const rectOf = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        centerY: rect.top + rect.height / 2,
      };
    };
    const railRect = rectOf(rail);
    const startRect = rectOf(start);
    const nodeRects = nodes.map(rectOf).filter(Boolean);
    const centers = nodeRects.map(({ centerY }) => centerY);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      rail: railRect,
      start: startRect,
      nodes: nodeRects,
      oneRow: centers.length === 3 && Math.max(...centers) - Math.min(...centers) <= 2,
      targetsAtLeast24: nodeRects.length === 3
        && nodeRects.every(({ width, height }) => width >= 24 && height >= 24),
      railInsideViewport: railRect !== null && railRect.left >= -1 && railRect.right <= innerWidth + 1,
      noHorizontalOverflow: rail instanceof HTMLElement
        && rail.scrollWidth <= rail.clientWidth + 1
        && document.documentElement.scrollWidth <= innerWidth + 1,
      startInsideViewport: startRect !== null
        && startRect.left >= -1 && startRect.right <= innerWidth + 1
        && startRect.top >= -1 && startRect.bottom <= innerHeight + 1,
    };
  });
}
