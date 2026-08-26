import {
  callHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'course',
  'catalog',
  'progress',
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
  execute: runCampaignProof,
});

async function runCampaignProof({ report, session, options }) {
  const page = session.page;

  await report.check({
    id: 'MISSION.two-chapter-title',
    name: 'The shipped title contains exactly the approved two chapters',
    assertion: 'CAIRN is available, BLACKOUT RELAY is locked, and rejected missions never enter the live catalog or DOM.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const course = await callHarness(page, 'course');
    const catalog = await callHarness(page, 'catalog');
    const progress = await callHarness(page, 'progress');
    const title = await page.evaluate(() => ({
      nodes: [...document.querySelectorAll('.lv-stage-node')].map((node) => ({
        id: node.getAttribute('data-stage-id'),
        state: node.getAttribute('data-stage-state'),
      })),
      text: document.querySelector('[data-view="title"]')?.textContent ?? '',
    }));
    verify(course.courseId === 'cairn-drift', 'Fresh boot did not select CAIRN.', { course });
    verify(JSON.stringify(catalog.order) === JSON.stringify(['cairn-drift', 'relay-harvest']),
      'Active catalog is not exactly two chapters.', { catalog });
    verify(JSON.stringify(title.nodes) === JSON.stringify([
      { id: 'cairn-drift', state: 'available' },
      { id: 'relay-harvest', state: 'locked' },
    ]), 'Title rail does not express the clear-only handoff.', { title, progress });
    verify(!/LAST ASCENT|DEAD SIGNAL|FIRE/u.test(title.text),
      'Rejected mission copy remains in the product title.', { title });
    return { course, catalog, progress, title };
  });

  await report.check({
    id: 'MISSION.cairn-production-60hz',
    name: 'Chapter 01 still completes through its production path',
    assertion: 'The unchanged CAIRN route clears 9/9 cleanly at 60 Hz and exposes BLACKOUT RELAY as the next chapter.',
  }, async () => {
    await callHarness(page, 'setSettings', [FAST_SETTINGS]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true, { skill: 0.75 }]);
    let phase = await callHarness(page, 'phase');
    for (let chunk = 0; chunk < 30 && phase === 'flying'; chunk++) {
      await callHarness(page, 'stepSimulation', [300, 1 / 60], 120_000);
      phase = await callHarness(page, 'phase');
    }
    const result = await callHarness(page, 'result');
    const errors = await callHarness(page, 'errors');
    const actions = await page.locator('[data-view="results"][data-open="1"] [data-action]')
      .evaluateAll((nodes) => nodes.map((node) => ({
        action: node.getAttribute('data-action'),
        stage: node.getAttribute('data-stage-id'),
      })));
    verify(phase === 'finished'
      && result?.kind === 'gate-race'
      && result.gatesCleared === 9
      && result.gatesTotal === 9
      && result.cleanRun === true
      && result.hullRemaining === 1
      && errors.length === 0,
    'CAIRN production completion regressed.', { phase, result, errors });
    verify(actions[0]?.action === 'next-stage' && actions[0]?.stage === 'relay-harvest',
      'First clear does not lead directly to BLACKOUT RELAY.', { actions });
    return { result, actions };
  });

  await report.check({
    id: 'MISSION.relay-handoff',
    name: 'NEXT CHAPTER constructs the BLACKOUT RELAY world by canonical reload',
    assertion: 'The handoff reloads one relay mission with a validated layout and no rejected chapter in the active catalog.',
  }, async () => {
    await Promise.all([
      page.waitForURL(/mission=relay-harvest/u, { waitUntil: 'load', timeout: options.timeoutMs }),
      page.locator('[data-action="next-stage"][data-stage-id="relay-harvest"]').click(),
    ]);
    verify(await waitForHarness(page, options.timeoutMs), 'Harness did not return after chapter handoff.');
    await callHarness(page, 'ready', [], options.timeoutMs);
    const course = await callHarness(page, 'course');
    const catalog = await callHarness(page, 'catalog');
    const url = new URL(page.url());
    verify(course.courseId === 'relay-harvest'
      && course.recordId.includes('-layout-rh2-')
      && url.searchParams.get('mission') === 'relay-harvest'
      && /^\d+$/u.test(url.searchParams.get('layout') ?? ''),
    'Chapter handoff did not construct a canonical relay layout.', { course, url: url.href });
    verify(JSON.stringify(catalog.order) === JSON.stringify(['cairn-drift', 'relay-harvest']),
      'Rejected mission returned after handoff.', { catalog });
    return { course, catalog, url: url.href };
  });
}
