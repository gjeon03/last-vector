import {
  callHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const SURVIVAL_RECORDS_KEY = 'last-vector.survival-records.v1';
const SURVIVAL_RULESET_ID = 'meteor-survival-v1';
const RUN_MODE = 'meteor-survival';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'telemetry',
  'phase',
  'result',
  'runMode',
  'survivalDebug',
  'setDriven',
  'step',
  'activeInput',
  'damageHull',
  'setSettings',
  'errors',
];

await runManagedSuite({
  suite: 'survival',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runSurvival,
});

async function runSurvival({ report, session, options }) {
  const page = session.page;

  await report.check({
    id: 'SURVIVAL.title-surface',
    name: 'The default title exposes one compact mode switch and no campaign cards',
    assertion:
      'TIME TRIAL is selected on the default title, METEOR SURVIVAL is the only alternate '
      + 'mode, and the release-disabled campaign card grid has no visible surface at desktop '
      + 'or 375x667.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    const desktop = await titleEvidence(page, { width: 1920, height: 1080 });
    const compact = await titleEvidence(page, { width: 375, height: 667 });
    await page.setViewportSize({ width: 1920, height: 1080 });

    for (const evidence of [desktop, compact]) {
      verify(evidence.phase === 'title' && evidence.runMode === 'time-trial',
        'Default boot did not remain on the TIME TRIAL title.', evidence);
      verify(evidence.selector.visible && evidence.selector.height > 0
        && evidence.selector.height < 150,
      'Run-mode control is absent or no longer a compact instrument strip.', evidence);
      verify(JSON.stringify(evidence.options.map(({ mode }) => mode))
        === JSON.stringify(['time-trial', RUN_MODE]),
      'Run-mode selector contains an unexpected choice.', evidence);
      verify(evidence.options[0]?.checked && !evidence.options[1]?.checked,
        'TIME TRIAL is not the selected default.', evidence);
      verify(JSON.stringify(evidence.options.map(({ tabIndex }) => tabIndex))
        === JSON.stringify([0, -1])
        && evidence.options.every(({ height }) => height >= 24),
      'Run-mode radios do not use a 24px roving-tabindex target.', evidence);
      verify(evidence.visibleRouteCards === 0 && !evidence.routeSectionVisible,
        'Dormant campaign cards are visible beside the run-mode selector.', evidence);
      verify(!evidence.horizontalOverflow && evidence.offscreenControls.length === 0,
        'Title controls overflow the viewport horizontally.', evidence);
    }
    return { desktop, compact };
  });

  await report.check({
    id: 'SURVIVAL.invalid-mode',
    name: 'Unknown run-mode URLs fail closed to TIME TRIAL',
    assertion:
      'An untrusted mode query never boots survival and never exposes a selected survival '
      + 'control, even when mixed with stale campaign and seed parameters.',
  }, async () => {
    const invalid = new URL(session.target.url);
    invalid.searchParams.set('mode', 'meteor-chaos');
    invalid.searchParams.set('course', 'needle-grave');
    invalid.searchParams.set('seed', String(options.seed));
    await navigateHarness(page, invalid.href, options.timeoutMs);
    const evidence = await page.evaluate(() => ({
      url: window.location.href,
      runMode: window.__LV?.runMode() ?? null,
      phase: window.__LV?.phase() ?? null,
      selected: document.querySelector('.lv-mode-option[aria-checked="true"]')
        ?.getAttribute('data-run-mode') ?? null,
      titleSector: document.querySelector('[data-view="title"] .lv-title-sector')
        ?.textContent?.trim() ?? '',
    }));
    verify(evidence.runMode === 'time-trial' && evidence.phase === 'title',
      'Invalid mode query escaped the default-mode boundary.', evidence);
    verify(evidence.selected === 'time-trial' && !evidence.titleSector.includes('METEOR SURVIVAL'),
      'The title rendered survival as selected after invalid-mode fallback.', evidence);
    return evidence;
  });

  await report.check({
    id: 'SURVIVAL.mode-navigation',
    name: 'The real METEOR SURVIVAL selector performs canonical boot navigation',
    assertion:
      'Clicking the visible mode control reloads the game into meteor-survival, preserves no '
      + 'irrelevant course or diagnostic seed query, and selects the survival segment on title.',
  }, async () => {
    const selected = page.locator(
      '[data-view="title"][data-open="1"] .lv-mode-option[data-run-mode="time-trial"]',
    );
    await selected.waitFor({ state: 'visible', timeout: options.timeoutMs });
    await selected.focus();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: options.timeoutMs }),
      page.keyboard.press('ArrowRight'),
    ]);
    await waitForHarness(page, options.timeoutMs);
    await callHarness(page, 'ready', [], options.timeoutMs);
    const evidence = await page.evaluate(() => ({
      url: window.location.href,
      runMode: window.__LV?.runMode() ?? null,
      phase: window.__LV?.phase() ?? null,
      selected: document.querySelector('.lv-mode-option[aria-checked="true"]')
        ?.getAttribute('data-run-mode') ?? null,
      routeCards: [...document.querySelectorAll('.lv-route-card')]
        .filter((node) => node instanceof HTMLElement
          && getComputedStyle(node).display !== 'none'
          && node.getClientRects().length > 0).length,
    }));
    const url = new URL(evidence.url);
    verify(evidence.runMode === RUN_MODE && evidence.phase === 'title'
      && evidence.selected === RUN_MODE,
    'The selector did not finish on a survival title.', evidence);
    verify(url.searchParams.get('mode') === RUN_MODE
      && !url.searchParams.has('course')
      && !url.searchParams.has('briefing')
      && !url.searchParams.has('seed'),
    'Mode selection did not produce the canonical survival URL.', evidence);
    verify(evidence.routeCards === 0,
      'Campaign cards became visible after survival navigation.', evidence);
    return evidence;
  });

  await report.check({
    id: 'SURVIVAL.briefing-controls',
    name: 'Survival briefing teaches ballistic play and all three C views',
    assertion:
      'BEGIN opens the dedicated survival briefing, which says ENDURE THE FIELD, identifies '
      + 'ballistic/rising pressure, and advertises C as CHASE / COCKPIT / FAR CHASE without '
      + 'horizontal overflow at desktop or 375x667.',
  }, async () => {
    await page.locator('[data-view="title"][data-open="1"] [data-action="begin"]').click();
    await page.waitForFunction(() => window.__LV?.phase() === 'briefing');
    const desktop = await briefingEvidence(page, { width: 1920, height: 1080 });
    const compact = await briefingEvidence(page, { width: 375, height: 667 });
    const compactScroll = await exerciseScrollRegion(
      page,
      '[data-view="briefing"][data-open="1"] [data-scroll-region="survival-briefing-content"]',
      'PageDown',
    );
    await page.setViewportSize({ width: 1920, height: 1080 });

    for (const evidence of [desktop, compact]) {
      verify(evidence.phase === 'briefing' && evidence.runMode === RUN_MODE,
        'Survival BEGIN did not open the survival briefing.', evidence);
      verify(evidence.title.includes('METEOR SURVIVAL')
        && evidence.sub.includes('ENDURE THE FIELD'),
      'Briefing identity copy is missing.', evidence);
      verify(evidence.stats.includes('BALLISTIC')
        && evidence.stats.includes('RISING')
        && evidence.stats.includes('CHASE / COCKPIT / FAR CHASE'),
      'Briefing omits the threat model or three-view sequence.', evidence);
      verify(evidence.cameraPrimer.includes('C')
        && (/3개 시점/u.test(evidence.cameraPrimer)
          || /three views/iu.test(evidence.cameraPrimer)),
      'C primer does not explain that survival cycles three views.', evidence);
      verify(evidence.engageVisible && evidence.visibleRouteCards === 0,
        'Briefing lost ENGAGE or exposed campaign cards.', evidence);
      verify(!evidence.horizontalOverflow && evidence.offscreenControls.length === 0,
        'Survival briefing overflows horizontally.', evidence);
      verify(evidence.scrollRegion.tabIndex === 0 && evidence.scrollRegion.role === 'region',
        'Briefing overflow owner is not a keyboard-readable region.', evidence);
    }
    verify(!compactScroll.scrollable || compactScroll.after > compactScroll.before,
      'PageDown could not reach clipped compact briefing content.', compactScroll);
    return { desktop, compact, compactScroll };
  });

  await report.check({
    id: 'SURVIVAL.grace-and-threats',
    name: 'A real start preserves ten seconds of grace before deterministic threats',
    assertion:
      'ENGAGE enters the production countdown; a reset deterministic run has no live/spawned '
      + 'meteor before 10 seconds and has the same non-zero threat state immediately afterward '
      + 'when replayed from the same boot seed.',
  }, async () => {
    await page.locator('[data-view="briefing"][data-open="1"] [data-action="engage"]').click();
    const productStartPhase = await callHarness(page, 'phase');
    verify(productStartPhase === 'countdown', 'ENGAGE bypassed the production countdown.', {
      productStartPhase,
    });

    await callHarness(page, 'setSettings', [{
      quality: 'low',
      renderScale: 0.6,
      filmGrain: false,
      chromaticAberration: false,
      motionBlur: false,
    }]);
    await page.setViewportSize({ width: 640, height: 360 });

    const trace = [];
    for (let replay = 0; replay < 2; replay += 1) {
      await callHarness(page, 'startRun', [{ skipIntro: true }]);
      await callHarness(page, 'setDriven', [true]);
      const initial = await callHarness(page, 'survivalDebug');
      await callHarness(page, 'step', [599, 1 / 60], 120_000);
      const before = await callHarness(page, 'survivalDebug');
      await callHarness(page, 'step', [2, 1 / 60], 120_000);
      const after = await callHarness(page, 'survivalDebug');
      trace.push({ initial, before, after });
    }

    for (const replay of trace) {
      verify(replay.initial.elapsedSeconds === 0
        && replay.initial.activeMeteors === 0
        && replay.initial.totalSpawned === 0,
      'A reset survival run inherited threats.', replay);
      verify(replay.before.elapsedSeconds < 10
        && replay.before.activeMeteors === 0
        && replay.before.totalSpawned === 0,
      'A meteor entered during the ten-second grace period.', replay);
      verify(replay.after.elapsedSeconds > 10
        && replay.after.activeMeteors > 0
        && replay.after.totalSpawned > 0,
      'Threat scheduling did not begin after grace.', replay);
    }
    verify(JSON.stringify(pickThreatState(trace[0].after))
      === JSON.stringify(pickThreatState(trace[1].after)),
    'Replaying the same seed and no-input clock produced different first threats.', trace);
    return { productStartPhase, trace };
  });

  await report.check({
    id: 'SURVIVAL.camera-cycle-input',
    name: 'Physical C cycles three views without swallowing flight controls',
    assertion:
      'Three non-synthetic KeyC presses move CHASE -> COCKPIT -> FAR CHASE -> CHASE, while '
      + 'arrow steering and the W+SHIFT chord still reach the active flight command.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setDriven', [true]);
    const modes = [(await callHarness(page, 'survivalDebug')).cameraMode];
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('KeyC');
      modes.push((await callHarness(page, 'survivalDebug')).cameraMode);
    }

    await page.keyboard.down('ArrowLeft');
    await callHarness(page, 'step', [2, 1 / 60], 120_000);
    const steering = await callHarness(page, 'activeInput');
    await page.keyboard.up('ArrowLeft');

    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await callHarness(page, 'step', [4, 1 / 60], 120_000);
    const chord = await callHarness(page, 'activeInput');
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');

    const evidence = { modes, steering, chord };
    verify(JSON.stringify(modes) === JSON.stringify([
      'chase', 'cockpit', 'far-chase', 'chase',
    ]), 'Physical C did not traverse the authored three-view sequence.', evidence);
    verify(steering.yaw < -0.75,
      'Arrow steering stopped reaching the command after cycling views.', evidence);
    verify(chord.boost === true && chord.throttle > 0.85,
      'W+SHIFT stopped reaching boost/throttle after cycling views.', evidence);
    return evidence;
  });

  let completedRun = null;
  await report.check({
    id: 'SURVIVAL.result-record',
    name: 'An accelerated no-input survival run ends in coherent results and PB storage',
    assertion:
      'With no pilot override or held key, deterministic fixed steps reach a hull-loss result '
      + 'within the bounded production clock; SURVIVED, avoidance stats, NEW BEST and the v1 '
      + 'localStorage record all describe the same run.',
  }, async () => {
    await page.setViewportSize({ width: 640, height: 360 });
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setDriven', [true]);

    const stepSeconds = 10;
    const dt = 1 / 30;
    const frames = Math.round(stepSeconds / dt);
    let phase = await callHarness(page, 'phase');
    let simulatedSeconds = 0;
    while (phase === 'flying' && simulatedSeconds < options.maxSimSeconds) {
      await callHarness(page, 'step', [frames, dt], 120_000);
      simulatedSeconds += stepSeconds;
      phase = await callHarness(page, 'phase');
    }

    const evidence = await readResultEvidence(page);
    evidence.simulatedSeconds = simulatedSeconds;
    completedRun = evidence;
    verify(phase === 'finished',
      `No-input survival did not reach its result within ${options.maxSimSeconds} seconds.`, evidence);
    verify(evidence.bodyState === 'survival'
      && evidence.bodyMode === RUN_MODE
      && evidence.title.includes('METEOR SURVIVAL'),
    'Terminal survival used the wrong result surface.', evidence);
    verify(evidence.record !== null && evidence.record.rulesetId === SURVIVAL_RULESET_ID,
      'Survival PB record was not persisted under its ruleset.', evidence);
    verify(Math.abs(evidence.record.scoreSeconds - evidence.telemetry.elapsed) <= 0.001,
      'PB duration differs from the run clock.', evidence);
    verify(evidence.survived === formatTime(evidence.record.scoreSeconds)
      && evidence.best === evidence.survived,
    'SURVIVED/BEST copy disagrees with the persisted score.', evidence);
    verify(evidence.newBestVisible,
      'The first completed survival run was not presented as NEW BEST.', evidence);
    verify(Number(evidence.stats.dodged) === evidence.record.stats.meteorsDodged
      && Number(evidence.stats['near-misses']) === evidence.record.stats.nearMisses
      && Number(evidence.stats.impacts) === evidence.record.stats.collisions
      && Number(evidence.stats['peak-threat']) === evidence.record.stats.peakActive,
    'Result ledger disagrees with persisted avoidance data.', evidence);
    verify(JSON.stringify(evidence.actions) === JSON.stringify(['retry', 'return']),
      'Survival result does not expose RETRY + RETURN.', evidence);
    verify(evidence.legacyResult === null,
      'Survival leaked through the time-trial result contract.', evidence);
    return evidence;
  });

  await report.check({
    id: 'SURVIVAL.responsive-result',
    name: 'Survival results stay contained at desktop and 375x667',
    assertion:
      'The result body, stat grid and RETRY/RETURN controls have no horizontal document '
      + 'overflow or off-screen controls at 1920x1080 and 375x667.',
  }, async () => {
    verify(completedRun !== null, 'No completed run is available for result layout checks.');
    const desktop = await resultLayoutEvidence(page, { width: 1920, height: 1080 });
    const compact = await resultLayoutEvidence(page, { width: 375, height: 667 });
    const compactScroll = await exerciseScrollRegion(
      page,
      '[data-view="results"][data-open="1"] [data-scroll-region="survival-result-content"]',
      'End',
    );
    await page.setViewportSize({ width: 1920, height: 1080 });
    for (const evidence of [desktop, compact]) {
      verify(evidence.open && evidence.bodyState === 'survival',
        'Survival result was not open during layout measurement.', evidence);
      verify(!evidence.horizontalOverflow && evidence.offscreenControls.length === 0,
        'Survival results overflow horizontally.', evidence);
      verify(evidence.statCount === 5 && evidence.actionCount === 2,
        'Responsive layout lost a result stat or action.', evidence);
      verify(evidence.scrollRegion.tabIndex === 0 && evidence.scrollRegion.role === 'region',
        'Result overflow owner is not a keyboard-readable region.', evidence);
      verify(evidence.lastStatWidth >= evidence.statGridWidth * 0.9,
        'The fifth result metric leaves an empty sixth-cell hole.', evidence);
    }
    verify(!compactScroll.scrollable || compactScroll.after > compactScroll.before,
      'End could not reach clipped compact result content.', compactScroll);
    return { desktop, compact, compactScroll };
  });

  await report.check({
    id: 'SURVIVAL.retry-return',
    name: 'RETRY starts a new run and RETURN restores the survival title',
    assertion:
      'The real result buttons start a fresh countdown without erasing the PB, then return '
      + 'from a second terminal result to the selected METEOR SURVIVAL title.',
  }, async () => {
    const originalRecord = completedRun?.record ?? null;
    await page.locator('[data-view="results"][data-open="1"] [data-action="retry"]').click();
    const afterRetry = {
      phase: await callHarness(page, 'phase'),
      debug: await callHarness(page, 'survivalDebug'),
      stored: await readStoredBest(page),
    };
    verify(afterRetry.phase === 'countdown'
      && afterRetry.debug.elapsedSeconds === 0
      && afterRetry.debug.activeMeteors === 0,
    'RETRY did not begin a clean survival countdown.', afterRetry);
    verify(afterRetry.stored?.scoreSeconds === originalRecord?.scoreSeconds,
      'RETRY erased or rewrote the standing PB.', { afterRetry, originalRecord });

    // Deterministically cross the terminal phase again so RETURN is tested on the real survival
    // result surface without spending another full run. This does not contribute evidence to the
    // no-input/natural-contact check above.
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'damageHull', [2]);
    await callHarness(page, 'step', [1, 1 / 60], 120_000);
    verify(await callHarness(page, 'phase') === 'finished',
      'Terminal phase injection did not produce the second result.');
    const secondResult = await readResultEvidence(page);
    verify(!secondResult.newBestVisible
      && secondResult.record?.scoreSeconds === originalRecord?.scoreSeconds,
    'A shorter retry replaced the standing PB.', { secondResult, originalRecord });

    await page.locator('[data-view="results"][data-open="1"] [data-action="return"]').click();
    await page.waitForFunction(() => window.__LV?.phase() === 'title');
    const returned = await page.evaluate(() => ({
      phase: window.__LV?.phase() ?? null,
      runMode: window.__LV?.runMode() ?? null,
      selected: document.querySelector('.lv-mode-option[aria-checked="true"]')
        ?.getAttribute('data-run-mode') ?? null,
      titleOpen: document.querySelector('[data-view="title"]')
        ?.getAttribute('data-open') ?? null,
      stored: JSON.parse(localStorage.getItem('last-vector.survival-records.v1') ?? 'null'),
    }));
    verify(returned.phase === 'title'
      && returned.runMode === RUN_MODE
      && returned.selected === RUN_MODE
      && returned.titleOpen === '1',
    'RETURN did not restore the selected survival title.', returned);
    verify(returned.stored?.bests?.[SURVIVAL_RULESET_ID]?.scoreSeconds
      === originalRecord?.scoreSeconds,
    'RETURN did not preserve the survival PB.', { returned, originalRecord });
    return { afterRetry, secondResult, returned };
  });
}

async function navigateHarness(page, url, timeoutMs) {
  const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  verify(response?.ok(), 'Navigation did not return a successful document.', {
    status: response?.status() ?? null,
    url,
  });
  await waitForHarness(page, timeoutMs);
  await callHarness(page, 'ready', [], timeoutMs);
}

async function titleEvidence(page, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(50);
  return page.evaluate(() => {
    const visible = (node) => node instanceof HTMLElement
      && getComputedStyle(node).display !== 'none'
      && getComputedStyle(node).visibility !== 'hidden'
      && node.getClientRects().length > 0;
    const selector = document.querySelector('.lv-mode-select');
    const rect = selector?.getBoundingClientRect();
    const controls = [...document.querySelectorAll(
      '[data-view="title"][data-open="1"] button, '
      + '[data-view="title"][data-open="1"] [tabindex="0"]',
    )].filter(visible);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      phase: window.__LV?.phase() ?? null,
      runMode: window.__LV?.runMode() ?? null,
      selector: {
        visible: visible(selector),
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      },
      options: [...document.querySelectorAll('.lv-mode-option')].map((node) => {
        const optionRect = node.getBoundingClientRect();
        return {
          mode: node.getAttribute('data-run-mode'),
          checked: node.getAttribute('aria-checked') === 'true',
          text: node.textContent?.trim() ?? '',
          tabIndex: node instanceof HTMLElement ? node.tabIndex : null,
          height: optionRect.height,
        };
      }),
      routeSectionVisible: visible(document.querySelector('.lv-route-select')),
      visibleRouteCards: [...document.querySelectorAll('.lv-route-card')].filter(visible).length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      offscreenControls: controls.map((node) => {
        const r = node.getBoundingClientRect();
        return { action: node.getAttribute('data-action'), left: r.left, right: r.right };
      }).filter(({ left, right }) => left < -1 || right > innerWidth + 1),
    };
  });
}

async function briefingEvidence(page, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(50);
  return page.evaluate(() => {
    const visible = (node) => node instanceof HTMLElement
      && getComputedStyle(node).display !== 'none'
      && getComputedStyle(node).visibility !== 'hidden'
      && node.getClientRects().length > 0;
    const view = document.querySelector('[data-view="briefing"][data-open="1"]');
    const controls = [...(view?.querySelectorAll('button, [tabindex="0"]') ?? [])].filter(visible);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      phase: window.__LV?.phase() ?? null,
      runMode: window.__LV?.runMode() ?? null,
      title: view?.querySelector('.lv-brief-title')?.textContent?.trim() ?? '',
      sub: view?.querySelector('.lv-brief-sub')?.textContent?.trim() ?? '',
      stats: view?.querySelector('.lv-stats')?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      cameraPrimer: view?.querySelector('[data-control="camera-toggle"]')
        ?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      engageVisible: visible(view?.querySelector('[data-action="engage"]')),
      scrollRegion: (() => {
        const node = view?.querySelector('[data-scroll-region="survival-briefing-content"]');
        return {
          tabIndex: node instanceof HTMLElement ? node.tabIndex : null,
          role: node?.getAttribute('role') ?? null,
          clientHeight: node?.clientHeight ?? 0,
          scrollHeight: node?.scrollHeight ?? 0,
        };
      })(),
      visibleRouteCards: [...document.querySelectorAll('.lv-route-card')].filter(visible).length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      offscreenControls: controls.map((node) => {
        const r = node.getBoundingClientRect();
        return { action: node.getAttribute('data-action'), left: r.left, right: r.right };
      }).filter(({ left, right }) => left < -1 || right > innerWidth + 1),
    };
  });
}

function pickThreatState(debug) {
  return {
    elapsedSeconds: Math.round(debug.elapsedSeconds * 1_000_000) / 1_000_000,
    difficulty: debug.difficulty,
    activeMeteors: debug.activeMeteors,
    peakActiveMeteors: debug.peakActiveMeteors,
    totalSpawned: debug.totalSpawned,
    totalRecycled: debug.totalRecycled,
  };
}

async function readResultEvidence(page) {
  return page.evaluate(({ storageKey, rulesetId }) => {
    const body = document.querySelector('[data-view="results"][data-open="1"] .lv-res-body');
    const records = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    const statEntries = [...(body?.querySelectorAll('[data-stat]') ?? [])]
      .filter((node) => node.classList.contains('lv-survival-stat'))
      .map((node) => [
        node.getAttribute('data-stat'),
        node.querySelector('dd')?.textContent?.trim() ?? '',
      ]);
    return {
      phase: window.__LV?.phase() ?? null,
      bodyState: body?.getAttribute('data-state') ?? null,
      bodyMode: body?.getAttribute('data-run-mode') ?? null,
      title: body?.querySelector('.lv-res-title')?.textContent?.trim() ?? '',
      survived: body?.querySelector('[data-stat="survived"] .lv-res-time')
        ?.textContent?.trim() ?? '',
      best: body?.querySelector('[data-stat="best"] .lv-survival-best-v')
        ?.textContent?.trim() ?? '',
      newBestVisible: Boolean(body?.querySelector('.lv-newbest')),
      stats: Object.fromEntries(statEntries),
      actions: [...(body?.querySelectorAll('[data-action]') ?? [])]
        .map((node) => node.getAttribute('data-action')),
      telemetry: window.__LV?.telemetry() ?? null,
      legacyResult: window.__LV?.result() ?? null,
      record: records?.bests?.[rulesetId] ?? null,
    };
  }, { storageKey: SURVIVAL_RECORDS_KEY, rulesetId: SURVIVAL_RULESET_ID });
}

async function resultLayoutEvidence(page, viewport) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(50);
  return page.evaluate(() => {
    const view = document.querySelector('[data-view="results"][data-open="1"]');
    const body = view?.querySelector('.lv-res-body');
    const visible = (node) => node instanceof HTMLElement
      && getComputedStyle(node).display !== 'none'
      && getComputedStyle(node).visibility !== 'hidden'
      && node.getClientRects().length > 0;
    const controls = [...(view?.querySelectorAll('button') ?? [])].filter(visible);
    const scrollRegion = view?.querySelector('[data-scroll-region="survival-result-content"]');
    const statGrid = body?.querySelector('.lv-survival-stats');
    const lastStat = body?.querySelector('.lv-survival-stat:last-child');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      open: Boolean(view),
      bodyState: body?.getAttribute('data-state') ?? null,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      offscreenControls: controls.map((node) => {
        const r = node.getBoundingClientRect();
        return { action: node.getAttribute('data-action'), left: r.left, right: r.right };
      }).filter(({ left, right }) => left < -1 || right > innerWidth + 1),
      statCount: body?.querySelectorAll('.lv-survival-stat').length ?? 0,
      actionCount: body?.querySelectorAll('.lv-survival-actions [data-action]').length ?? 0,
      bodyScrolls: body instanceof HTMLElement && body.scrollHeight > body.clientHeight + 1,
      scrollRegion: {
        tabIndex: scrollRegion instanceof HTMLElement ? scrollRegion.tabIndex : null,
        role: scrollRegion?.getAttribute('role') ?? null,
        clientHeight: scrollRegion?.clientHeight ?? 0,
        scrollHeight: scrollRegion?.scrollHeight ?? 0,
      },
      statGridWidth: statGrid?.getBoundingClientRect().width ?? 0,
      lastStatWidth: lastStat?.getBoundingClientRect().width ?? 0,
    };
  });
}

async function exerciseScrollRegion(page, selector, key) {
  const region = page.locator(selector);
  await region.focus();
  const before = await region.evaluate((node) => node.scrollTop);
  await page.keyboard.press(key);
  await page.waitForTimeout(50);
  return region.evaluate((node, prior) => ({
    before: prior,
    after: node.scrollTop,
    scrollable: node.scrollHeight > node.clientHeight + 1,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }), before);
}

async function readStoredBest(page) {
  return page.evaluate(({ storageKey, rulesetId }) => {
    const records = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return records?.bests?.[rulesetId] ?? null;
  }, { storageKey: SURVIVAL_RECORDS_KEY, rulesetId: SURVIVAL_RULESET_ID });
}

function formatTime(seconds) {
  const total = Math.floor(seconds * 100);
  const centiseconds = total % 100;
  const wholeSeconds = Math.floor(total / 100) % 60;
  const minutes = Math.floor(total / 6000);
  return `${pad2(minutes)}:${pad2(wholeSeconds)}.${pad2(centiseconds)}`;
}

function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}
