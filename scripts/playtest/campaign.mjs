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
  'routeUrl',
  'startRun',
  'setDriven',
  'setAutopilot',
  'setSettings',
  'step',
  'phase',
  'result',
  'pose',
  'errors',
];

await runManagedSuite({
  suite: 'campaign',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runCampaign,
});

async function runCampaign({ report, session, options }) {
  const page = session.page;

  await report.check({
    id: 'CAMPAIGN.disabled-surface',
    name: 'Disabled campaign code has no player-facing surface',
    assertion:
      'CAIRN remains the complete default game, NEEDLE stays in the internal authored catalog, '
      + 'and route selection/mastery controls are absent from the visible title and briefing.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    const before = page.url();
    const evidence = await page.evaluate(() => {
      const visible = (node) => node instanceof HTMLElement
        && getComputedStyle(node).display !== 'none'
        && node.getClientRects().length > 0;
      const routeSection = document.querySelector('.lv-route-select');
      const briefingObjectives = document.querySelector(
        '[data-view="briefing"] .lv-objectives',
      );
      return {
        version: window.__LV?.version ?? null,
        course: window.__LV?.course() ?? null,
        catalog: window.__LV?.catalog() ?? null,
        progress: window.__LV?.progress() ?? null,
        needleUrl: window.__LV?.routeUrl('needle-grave') ?? null,
        titleActions: [...document.querySelectorAll('[data-view="title"] [data-action]')]
          .filter(visible)
          .map((node) => node.getAttribute('data-action')),
        routeSection: routeSection instanceof HTMLElement ? {
          hidden: routeSection.hidden,
          visible: visible(routeSection),
        } : null,
        visibleRouteButtons: [...document.querySelectorAll('[data-action="select-route"]')]
          .filter(visible).length,
        briefingObjectives: briefingObjectives instanceof HTMLElement ? {
          hidden: briefingObjectives.hidden,
          visible: visible(briefingObjectives),
        } : null,
      };
    });
    verify(evidence.version === '1.9.0', 'Campaign harness version changed.', evidence);
    verify(evidence.course?.courseId === 'cairn-drift' && evidence.course?.gateCount === 9,
      'Disabled mode did not boot the historical nine-gate CAIRN route.', evidence);
    verify(evidence.course.recordId === `cairn-drift-${evidence.course.seed}`,
      'CAIRN PB identity changed.', evidence);
    verify(JSON.stringify(evidence.catalog?.order) === JSON.stringify(['cairn-drift', 'needle-grave'])
      && evidence.catalog?.courses?.some((course) => course.id === 'needle-grave'
        && course.gateCount === 6 && course.destination === 'NADIR RELAY'),
    'Dormant NEEDLE authoring was deleted instead of release-gated.', evidence);
    verify(new URL(evidence.needleUrl).searchParams.get('course') === 'cairn-drift'
      && !new URL(evidence.needleUrl).searchParams.has('seed'),
    'routeUrl minted a disabled NEEDLE route.', evidence);
    verify(page.url() === before, 'routeUrl navigated instead of returning sanitized data.', {
      before,
      after: page.url(),
    });
    verify(evidence.routeSection?.hidden && !evidence.routeSection.visible
      && evidence.visibleRouteButtons === 0,
    'Route selection remains visible while campaign mode is disabled.', evidence);
    verify(evidence.briefingObjectives?.hidden && !evidence.briefingObjectives.visible,
      'Route mastery remains visible while campaign mode is disabled.', evidence);
    verify(JSON.stringify(evidence.titleActions) === JSON.stringify(['begin', 'settings', 'controls']),
      'Title action surface contains a campaign action.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.disabled-selection',
    name: 'Deep links, saved selection and forged selection fail closed',
    assertion:
      'Even a historical CAIRN clear and saved NEEDLE selection cannot authorize NEEDLE; its '
      + 'progress facts survive, while boot, generated URL and a hidden-button click stay on CAIRN.',
  }, async () => {
    const installed = await callHarness(page, 'installProgress', [{
      version: 1,
      selectedCourse: 'needle-grave',
      courses: {
        'cairn-drift': {
          cleared: true,
          clearedAt: 100,
          highestRank: 'A',
          cleanClear: true,
          precisionClear: true,
        },
        'needle-grave': {
          cleared: true,
          clearedAt: 200,
          highestRank: 'B',
          cleanClear: false,
          precisionClear: false,
        },
      },
    }]);
    verify(installed.reloadSafe === true, 'Test progress was not safe to reload.', installed);

    const direct = new URL(page.url());
    direct.searchParams.set('course', 'needle-grave');
    direct.searchParams.delete('seed');
    const response = await page.goto(direct.href, { waitUntil: 'load', timeout: options.timeoutMs });
    verify(response?.ok(), 'Disabled deep-link document failed to load.', {
      status: response?.status() ?? null,
    });
    await waitForHarness(page, options.timeoutMs);
    await callHarness(page, 'ready', [], options.timeoutMs);

    const beforeForgedClick = page.url();
    await page.evaluate(() => {
      document.querySelector('[data-action="select-route"][data-route="needle-grave"]')?.click();
    });
    await page.waitForTimeout(50);
    const evidence = await page.evaluate(() => ({
      course: window.__LV?.course() ?? null,
      progress: window.__LV?.progress() ?? null,
      needleUrl: window.__LV?.routeUrl('needle-grave') ?? null,
      visibleRouteButtons: [...document.querySelectorAll('[data-action="select-route"]')]
        .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0).length,
    }));
    verify(evidence.course?.courseId === 'cairn-drift'
      && evidence.course?.resolution?.source === 'locked-url'
      && evidence.course?.resolution?.diagnostic?.includes('disabled'),
    'Explicit NEEDLE URL escaped the release gate.', evidence);
    verify(evidence.progress?.selectedCourse === 'cairn-drift',
      'Saved NEEDLE selection did not fall back to CAIRN.', evidence);
    verify(evidence.progress?.courses?.['needle-grave']?.cleared === true
      && evidence.progress?.courses?.['needle-grave']?.highestRank === 'B',
    'Release gating erased dormant NEEDLE progress.', evidence);
    verify(new URL(evidence.needleUrl).searchParams.get('course') === 'cairn-drift',
      'Generated route data escaped the release gate.', evidence);
    verify(page.url() === beforeForgedClick && evidence.visibleRouteButtons === 0,
      'Hidden route selection remained actionable.', {
        ...evidence,
        beforeForgedClick,
        afterForgedClick: page.url(),
      });
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.abort-title-motion',
    name: 'ABORT FLIGHT restores the moving title cinematic',
    assertion:
      'The real Escape-to-pause and ABORT path returns to title, clears the still vantage and '
      + 'moves both ship and camera after a short settle without runtime errors.',
  }, async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'step', [5, 1 / 60], 120_000);
    await page.keyboard.press('Escape');
    const abort = page.locator(
      '[data-view="pause"][data-open="1"] [data-action="abort"]',
    );
    await abort.waitFor({ state: 'visible', timeout: 5_000 });
    await abort.click();
    await page.waitForFunction(() => window.__LV?.phase() === 'title');

    await callHarness(page, 'step', [2, 1 / 60], 120_000);
    const before = await callHarness(page, 'pose');
    await callHarness(page, 'step', [30, 1 / 60], 120_000);
    const after = await callHarness(page, 'pose');
    const errors = await callHarness(page, 'errors');
    const evidence = {
      phase: await callHarness(page, 'phase'),
      shipMovement: distance(before.position, after.position),
      cameraMovement: distance(before.camera.position, after.camera.position),
      before,
      after,
      errors,
    };
    verify(evidence.phase === 'title', 'ABORT did not return to title.', evidence);
    verify(evidence.shipMovement > 1 && evidence.cameraMovement > 1,
      'ABORT left the title pinned to a still authored vantage.', evidence);
    verify(Array.isArray(errors) && errors.length === 0,
      'ABORT title recovery raised runtime errors.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.cairn-result-surface',
    name: 'A CAIRN finish exposes only the original single-route result flow',
    assertion:
      'A normal CAIRN completion unlocks no route and shows RUN AGAIN plus RETURN, with no '
      + 'mastery, route unlock, NEXT ROUTE or ROUTE SELECT surface.',
  }, async () => {
    await callHarness(page, 'setSettings', [{
      quality: 'low',
      renderScale: 0.6,
      filmGrain: false,
      chromaticAberration: false,
      motionBlur: false,
    }]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true]);
    for (let chunk = 0; chunk < 30; chunk++) {
      if (await callHarness(page, 'phase') !== 'flying') break;
      await callHarness(page, 'step', [300, 1 / 60], 120_000);
    }

    const evidence = await page.evaluate(() => {
      const visible = (node) => node instanceof HTMLElement
        && getComputedStyle(node).display !== 'none'
        && node.getClientRects().length > 0;
      const open = document.querySelector('[data-view="results"][data-open="1"]');
      return {
        phase: window.__LV?.phase() ?? null,
        result: window.__LV?.result() ?? null,
        progress: window.__LV?.progress() ?? null,
        resultLang: open?.querySelector('.lv-res-body')?.getAttribute('lang') ?? null,
        actions: [...(open?.querySelectorAll('[data-action]') ?? [])]
          .filter(visible)
          .map((node) => ({
            action: node.getAttribute('data-action'),
            text: node.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
          })),
        visibleMastery: [...(open?.querySelectorAll('.lv-objectives') ?? [])].filter(visible).length,
        visibleUnlocks: [...(open?.querySelectorAll('.lv-route-unlock') ?? [])].filter(visible).length,
      };
    });
    verify(evidence.phase === 'finished' && evidence.result?.courseId === 'cairn-drift',
      'Autopilot did not complete CAIRN within the bounded simulation.', evidence);
    verify(evidence.result.gatesCleared === 9 && evidence.result.gatesTotal === 9,
      'Completed result is not the original nine-gate CAIRN route.', evidence);
    verify(evidence.result.newlyUnlockedCourseId === null
      && evidence.progress?.selectedCourse === 'cairn-drift',
    'CAIRN completion exposed a dormant unlock or changed route.', evidence);
    verify(evidence.resultLang === 'en',
      'Instrument/result surface is not marked as English in Korean mode.', evidence);
    verify(JSON.stringify(evidence.actions.map(({ action }) => action))
      === JSON.stringify(['again', 'return'])
      && evidence.actions[0]?.text.includes('RUN AGAIN')
      && evidence.actions[1]?.text.includes('RETURN'),
    'Result actions do not match the original RUN AGAIN + RETURN flow.', evidence);
    verify(evidence.visibleMastery === 0 && evidence.visibleUnlocks === 0,
      'Campaign mastery or unlock feedback remains visible on results.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.result-action-navigation',
    name: 'RUN AGAIN and RETURN arrows follow the rendered axis',
    assertion:
      'Desktop horizontal actions use Left/Right without moving on Up/Down, while compact '
      + 'stacked actions use Up/Down without moving on Left/Right.',
  }, async () => {
    const actionFocus = () => page.evaluate(() =>
      document.activeElement?.getAttribute('data-action') ?? null);
    const measure = () => page.evaluate(() => {
      const open = document.querySelector('[data-view="results"][data-open="1"]');
      const again = open?.querySelector('[data-action="again"]')?.getBoundingClientRect();
      const returning = open?.querySelector('[data-action="return"]')?.getBoundingClientRect();
      const centre = (rect) => rect
        ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        : null;
      return { again: centre(again), returning: centre(returning) };
    });
    const focusAgain = () => page.locator(
      '[data-view="results"][data-open="1"] [data-action="again"]',
    ).focus();

    await page.setViewportSize({ width: 1920, height: 1080 });
    const desktopGeometry = await measure();
    await focusAgain();
    await page.keyboard.press('ArrowDown');
    const desktopAfterDown = await actionFocus();
    await page.keyboard.press('ArrowRight');
    const desktopAfterRight = await actionFocus();
    await page.keyboard.press('ArrowUp');
    const desktopAfterUp = await actionFocus();
    await page.keyboard.press('ArrowLeft');
    const desktopAfterLeft = await actionFocus();

    await page.setViewportSize({ width: 375, height: 667 });
    const compactGeometry = await measure();
    await focusAgain();
    await page.keyboard.press('ArrowRight');
    const compactAfterRight = await actionFocus();
    await page.keyboard.press('ArrowDown');
    const compactAfterDown = await actionFocus();
    await page.keyboard.press('ArrowLeft');
    const compactAfterLeft = await actionFocus();
    await page.keyboard.press('ArrowUp');
    const compactAfterUp = await actionFocus();
    await page.setViewportSize({ width: 1920, height: 1080 });

    const evidence = {
      desktopGeometry,
      compactGeometry,
      desktop: {
        afterDown: desktopAfterDown,
        afterRight: desktopAfterRight,
        afterUp: desktopAfterUp,
        afterLeft: desktopAfterLeft,
      },
      compact: {
        afterRight: compactAfterRight,
        afterDown: compactAfterDown,
        afterLeft: compactAfterLeft,
        afterUp: compactAfterUp,
      },
    };
    verify(desktopGeometry.again && desktopGeometry.returning
      && Math.abs(desktopGeometry.again.y - desktopGeometry.returning.y) <= 2
      && desktopGeometry.again.x < desktopGeometry.returning.x,
    'Desktop result actions are not a horizontal left-to-right pair.', evidence);
    verify(desktopAfterDown === 'again' && desktopAfterRight === 'return'
      && desktopAfterUp === 'return' && desktopAfterLeft === 'again',
    'Desktop result focus did not follow the horizontal arrow axis.', evidence);
    verify(compactGeometry.again && compactGeometry.returning
      && Math.abs(compactGeometry.again.x - compactGeometry.returning.x) <= 2
      && compactGeometry.again.y < compactGeometry.returning.y,
    'Compact result actions are not a vertical top-to-bottom stack.', evidence);
    verify(compactAfterRight === 'again' && compactAfterDown === 'return'
      && compactAfterLeft === 'return' && compactAfterUp === 'again',
    'Compact result focus did not follow the vertical arrow axis.', evidence);
    return evidence;
  });
}

function distance(left, right) {
  return Math.hypot(...left.map((value, index) => value - right[index]));
}
