import {
  callHarness,
  finiteNumber,
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
  'shear',
  'crossings',
  'stageShearBlock',
  'installProgress',
  'routeUrl',
  'startRun',
  'setDriven',
  'setInput',
  'setAutopilot',
  'setSettings',
  'seekCourse',
  'step',
  'phase',
  'result',
  'telemetry',
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
    id: 'CAMPAIGN.harness-default',
    name: 'Harness v1.8 exposes the default CAIRN campaign state',
    assertion: 'The no-course boot is CAIRN with its historical record ID, nine gates, a locked NEEDLE catalog entry, and no navigation side effect from routeUrl().',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    const before = page.url();
    const evidence = await page.evaluate(() => ({
      version: window.__LV?.version ?? null,
      course: window.__LV?.course() ?? null,
      catalog: window.__LV?.catalog() ?? null,
      progress: window.__LV?.progress() ?? null,
      routeUrl: window.__LV?.routeUrl('needle-grave') ?? null,
    }));
    verify(evidence.version === '1.8.0', 'Campaign harness version is not 1.8.0.', evidence);
    verify(evidence.course?.courseId === 'cairn-drift' && evidence.course?.gateCount === 9,
      'Default boot is not the nine-gate CAIRN route.', evidence);
    verify(evidence.course.recordId === `cairn-drift-${evidence.course.seed}`,
      'CAIRN record identity is not course-and-seed scoped.', evidence);
    verify(JSON.stringify(evidence.catalog?.order) === JSON.stringify(['cairn-drift', 'needle-grave']),
      'Harness catalog order differs from production.', evidence);
    verify(evidence.progress?.courses?.['cairn-drift']?.cleared !== true,
      'Fresh managed context unexpectedly contains a CAIRN clear.', evidence);
    verify(page.url() === before, 'routeUrl() navigated instead of returning data.', { before, after: page.url() });
    const routeUrl = new URL(evidence.routeUrl);
    verify(routeUrl.searchParams.get('course') === 'needle-grave' && !routeUrl.searchParams.has('seed'),
      'routeUrl() did not produce normal route navigation data.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.locked-route-ui',
    name: 'Locked NEEDLE remains discoverable without becoming actionable',
    assertion: 'The Korean-default title exposes two native route radios; NEEDLE is focusable, visibly locked, aria-disabled, described, and not selected.',
  }, async () => {
    const evidence = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-action="select-route"][data-route]')];
      const needle = document.querySelector('[data-action="select-route"][data-route="needle-grave"]');
      needle?.focus();
      return {
        lang: document.documentElement.lang,
        count: cards.length,
        needle: needle instanceof HTMLElement ? {
          tag: needle.tagName,
          state: needle.dataset['routeState'] ?? null,
          checked: needle.getAttribute('aria-checked'),
          disabled: needle.getAttribute('aria-disabled'),
          describedBy: needle.getAttribute('aria-describedby'),
          focused: document.activeElement === needle,
          text: needle.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
        } : null,
      };
    });
    verify(evidence.lang === 'ko', 'Fresh title is not Korean by default.', evidence);
    verify(evidence.count === 2 && evidence.needle?.tag === 'BUTTON', 'Route strip is not two native buttons.', evidence);
    verify(evidence.needle.state === 'locked' && evidence.needle.disabled === 'true'
      && evidence.needle.checked === 'false', 'Locked state is not exposed semantically.', evidence);
    verify(Boolean(evidence.needle.describedBy) && evidence.needle.focused,
      'Locked route is not focusable/described for discovery.', evidence);
    verify(evidence.needle.text.length > 0, 'Locked route has no visible explanation.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.locked-deep-link',
    name: 'A locked NEEDLE deep link fails closed to a complete CAIRN world',
    assertion: 'Navigating to the generated NEEDLE URL before unlock rebuilds CAIRN and reports locked-url instead of consulting or mutating selection.',
  }, async () => {
    const routeUrl = await callHarness(page, 'routeUrl', ['needle-grave']);
    const response = await page.goto(routeUrl, { waitUntil: 'load', timeout: options.timeoutMs });
    verify(response?.ok(), 'Locked deep-link document failed to load.', { status: response?.status() ?? null });
    await waitForHarness(page, options.timeoutMs);
    await callHarness(page, 'ready', [], options.timeoutMs);
    const course = await callHarness(page, 'course');
    verify(course.courseId === 'cairn-drift' && course.resolution.source === 'locked-url',
      'Locked URL did not resolve directly to CAIRN.', course);
    return course;
  });

  await report.check({
    id: 'CAMPAIGN.authorized-needle-boot',
    name: 'Installed progress authorizes a route-aware NEEDLE boot',
    assertion: 'A validated CAIRN clear survives reload, authorizes the same NEEDLE URL, retains selected English, and builds the six-gate 24–26 km NADIR route with four SHEAR fields.',
  }, async () => {
    await page.locator('[data-locale="en"]').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    const installed = await callHarness(page, 'installProgress', [{
      version: 1,
      selectedCourse: 'needle-grave',
      courses: {
        'cairn-drift': {
          cleared: true,
          clearedAt: 100,
          highestRank: 'B',
          cleanClear: false,
          precisionClear: false,
        },
      },
    }]);
    verify(installed.reloadSafe === true, 'Test progress was not safe to reload.', installed);
    await reloadHarness(page, options.timeoutMs);
    const evidence = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      course: window.__LV?.course() ?? null,
      progress: window.__LV?.progress() ?? null,
      shear: window.__LV?.shear() ?? null,
      cards: [...document.querySelectorAll('[data-action="select-route"][data-route]')].map((node) => ({
        route: node.getAttribute('data-route'),
        state: node.getAttribute('data-route-state'),
        checked: node.getAttribute('aria-checked'),
        disabled: node.getAttribute('aria-disabled'),
      })),
    }));
    const { course, shear } = evidence;
    verify(evidence.lang === 'en', 'Active locale did not survive route reload.', evidence);
    verify(course?.courseId === 'needle-grave' && course?.resolution?.source === 'url',
      'Authorized URL did not build NEEDLE.', evidence);
    verify(course.gateCount === 6 && course.length >= 24_000 && course.length <= 26_000,
      'NEEDLE is not the calibrated six-gate 24–26 km route.', evidence);
    verify(course.recordId === `needle-grave-${course.seed}`, 'NEEDLE PB identity is not isolated.', evidence);
    verify(shear?.states?.length === 4 && shear.drawCalls <= 6 && shear.triangles <= 2_000,
      'SHEAR topology exceeds its compact render budget.', evidence);
    const selected = evidence.cards.find((card) => card.route === 'needle-grave');
    verify(selected?.checked === 'true' && selected.disabled === 'false' && selected.state !== 'locked',
      'Authorized NEEDLE is not selected and actionable in the route strip.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.responsive-route-strip',
    name: 'Route selection remains usable at both compact target viewports',
    assertion: 'At 375×667 and 640×360 the selected route and primary action stay inside the viewport without horizontal document overflow.',
  }, async () => {
    const samples = [];
    for (const viewport of [{ width: 375, height: 667 }, { width: 640, height: 360 }]) {
      await page.setViewportSize(viewport);
      const sample = await page.evaluate(() => {
        const route = document.querySelector('[data-route="needle-grave"]')?.getBoundingClientRect();
        const begin = document.querySelector('[data-action="begin"]')?.getBoundingClientRect();
        return {
          viewport: [innerWidth, innerHeight],
          scrollWidth: document.documentElement.scrollWidth,
          route: route ? { left: route.left, right: route.right, top: route.top, bottom: route.bottom } : null,
          begin: begin ? { left: begin.left, right: begin.right, top: begin.top, bottom: begin.bottom } : null,
        };
      });
      verify(sample.scrollWidth <= viewport.width + 1, 'Campaign title overflows horizontally.', sample);
      for (const [name, rect] of [['route', sample.route], ['begin', sample.begin]]) {
        verify(rect && rect.left >= -1 && rect.right <= viewport.width + 1,
          `${name} action leaves the compact viewport horizontally.`, sample);
        verify(rect.bottom >= 0 && rect.top <= viewport.height,
          `${name} action is not reachable in the compact title viewport.`, sample);
      }
      samples.push(sample);
    }
    return samples;
  });

  await report.check({
    id: 'CAMPAIGN.shear-block-feedback',
    name: 'A closed SHEAR crossing explains the actual failure',
    assertion: 'A deterministic hub crossing stays recoverable, records blockedBy=shear, and presents Korean SHEAR-specific callout and log descriptors instead of the ordinary aperture-miss copy.',
  }, async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.locator('[data-locale="ko"]').click();
    await page.waitForFunction(() => document.documentElement.lang === 'ko');
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'seekCourse', [0.35]);
    const staged = await callHarness(page, 'stageShearBlock');
    await callHarness(page, 'step', [1, 1 / 60], 120_000);
    const evidence = await page.evaluate(() => {
      const telemetry = window.__LV?.telemetry() ?? null;
      const crossings = window.__LV?.crossings() ?? [];
      const callout = telemetry?.callout ?? null;
      const log = telemetry?.log?.[telemetry.log.length - 1] ?? null;
      return {
        phase: window.__LV?.phase() ?? null,
        nextGate: telemetry?.gate?.index ?? null,
        crossing: crossings[crossings.length - 1] ?? null,
        callout,
        log,
        calloutText: document.querySelector('.lv-callout')?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
        logText: document.querySelector('.lv-log-line:last-child')?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      };
    });
    verify(staged?.index === 2 && staged?.blockedBy === 'shear' && staged?.cleared === false,
      'The deterministic crossing did not hit the first SHEAR hub.', evidence);
    verify(evidence.crossing?.index === 2 && evidence.crossing?.blockedBy === 'shear'
      && evidence.nextGate === 2 && evidence.phase === 'flying',
    'A SHEAR block was not recoverable at the same armed gate.', evidence);
    verify(evidence.callout?.titleMessage?.type === 'callout-title.gate-missed'
      && evidence.callout?.titleMessage?.blockedBy === 'shear'
      && evidence.callout?.subMessage?.type === 'callout-sub.gate-shear-window',
    'The user-facing callout discarded the SHEAR cause.', evidence);
    verify(evidence.log?.message?.type === 'log.gate-missed'
      && evidence.log?.message?.blockedBy === 'shear'
      && evidence.calloutText.includes('SHEAR 차단')
      && evidence.calloutText.includes('열린 구역')
      && evidence.logText.includes('SHEAR 차단'),
    'Localized SHEAR feedback was not visible in the HUD.', evidence);
    await reloadHarness(page, options.timeoutMs);
    return evidence;
  });

  let sixtyHz = null;
  await report.check({
    id: 'CAMPAIGN.shear-fixed-step',
    name: 'SHEAR phase is fixed-time invariant and restart-stable',
    assertion: 'Initial phases reproduce after reload, and one simulated second at 60 Hz and 120 Hz yields matching phases within 1e-6 radians.',
  }, async () => {
    await callHarness(page, 'setSettings', [{
      quality: 'low',
      renderScale: 0.6,
      filmGrain: false,
      chromaticAberration: false,
      motionBlur: false,
    }]);
    const initial60 = await callHarness(page, 'shear');
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true]);
    await callHarness(page, 'step', [60, 1 / 60], 120_000);
    sixtyHz = await callHarness(page, 'shear');

    await reloadHarness(page, options.timeoutMs);
    const initial120 = await callHarness(page, 'shear');
    verifyShearMatch(initial60, initial120, 1e-12, 'Initial SHEAR phase changed across restart/reload.');
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [true]);
    await callHarness(page, 'step', [120, 1 / 120], 120_000);
    const oneTwentyHz = await callHarness(page, 'shear');
    verifyShearMatch(sixtyHz, oneTwentyHz, 1e-6, 'SHEAR phase depends on fixed-step frequency.');
    return { initial60, initial120, sixtyHz, oneTwentyHz };
  });

  await report.check({
    id: 'CAMPAIGN.needle-autopilot',
    name: 'The phase-aware pilot completes NEEDLE cleanly in its target band',
    assertion: 'Within 56 simulated seconds the pilot clears six gates, reaches NADIR in 45–55 seconds, takes no impact, and records no SHEAR block.',
  }, async () => {
    // The preceding 120 Hz check leaves a clean phase-aware run exactly one second in. Advance in
    // bounded chunks so a tuned 45–55 second run stops promptly instead of rendering dead frames.
    for (let chunk = 0; chunk < 12; chunk++) {
      if (await callHarness(page, 'phase') !== 'flying') break;
      await callHarness(page, 'step', [300, 1 / 60], 120_000);
    }
    const evidence = await page.evaluate(() => ({
      phase: window.__LV?.phase() ?? null,
      result: window.__LV?.result() ?? null,
      telemetry: window.__LV?.telemetry() ?? null,
      crossings: window.__LV?.crossings() ?? null,
      shear: window.__LV?.shear() ?? null,
    }));
    verify(evidence.phase === 'finished' && evidence.result,
      'Autopilot did not finish NEEDLE within the simulation budget.', evidence);
    verify(evidence.result.totalTime >= 45 && evidence.result.totalTime <= 55,
      'NEEDLE completion is outside the 45–55 second target.', evidence);
    verify(evidence.result.gatesCleared === 6 && evidence.result.gatesTotal === 6,
      'Autopilot did not clear exactly six NEEDLE gates.', evidence);
    verify(evidence.result.cleanRun === true, 'Autopilot completion was not collision-free.', evidence);
    verify(Array.isArray(evidence.crossings) && evidence.crossings.length === 6
      && evidence.crossings.every((crossing) => crossing.cleared),
    'Autopilot produced a recoverable miss instead of six direct clears.', evidence);
    verify(evidence.crossings.every((crossing) => crossing.blockedBy !== 'shear'),
      'Phase-aware autopilot crossed a closed SHEAR sector.', evidence);
    verify(finiteNumber(evidence.result.maxGateOffset) && evidence.result.maxGateOffset < 1,
      'Result lacks a valid normalized maximum gate offset.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.result-mastery-feedback',
    name: 'Results explain precision and recommend one next mastery target',
    assertion: 'The completed NEEDLE run shows its measured widest marker against the strict <40% rule and emphasizes only the remaining precision objective.',
  }, async () => {
    const evidence = await page.evaluate(() => {
      const result = window.__LV?.result() ?? null;
      const stat = document.querySelector('[data-stat="max-gate-offset"]');
      const focused = [...document.querySelectorAll('[data-objective-list="results"] [data-objective][data-focus="1"]')];
      return {
        result,
        stat: stat ? {
          text: stat.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
          tone: stat.getAttribute('data-tone'),
        } : null,
        focused: focused.map((node) => ({
          objective: node.getAttribute('data-objective'),
          complete: node.getAttribute('data-complete'),
          text: node.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
        })),
      };
    });
    verify(finiteNumber(evidence.result?.maxGateOffset), 'Finished run has no precision evidence.', evidence);
    const expectedPercent = (Math.ceil(evidence.result.maxGateOffset * 1_000) / 10).toFixed(1);
    verify(evidence.stat?.text.includes(`${expectedPercent}%`) && evidence.stat.text.includes('<40.0%')
      && evidence.stat.tone === 'warn',
    'Results do not explain the measured precision miss against the strict target.', evidence);
    verify(evidence.focused.length === 1 && evidence.focused[0].objective === 'precision'
      && evidence.focused[0].complete === '0' && evidence.focused[0].text.includes('다음 목표'),
    'Results did not emphasize exactly the nearest incomplete mastery target.', evidence);
    return evidence;
  });

  await report.check({
    id: 'CAMPAIGN.live-pb-delta',
    name: 'A repeat run reports a compatible per-gate PB delta',
    assertion: 'The next NEEDLE run loads the completed six-split PB and adds one correctly signed, toned delta only when the matching gate split appears.',
  }, async () => {
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [{ throttle: 0, brake: true }]);
    await callHarness(page, 'step', [60, 1 / 60], 120_000);
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setAutopilot', [true]);
    let telemetry = await callHarness(page, 'telemetry');
    for (let chunk = 0; chunk < 80 && telemetry.splits.length === 0; chunk++) {
      await callHarness(page, 'step', [30, 1 / 60], 120_000);
      telemetry = await callHarness(page, 'telemetry');
    }
    const evidence = await page.evaluate(() => {
      const telemetry = window.__LV?.telemetry() ?? null;
      const row = document.querySelector('.lv-splitfeed-row:last-child');
      const delta = row?.querySelector('.lv-splitfeed-dlt');
      return {
        telemetry,
        feedComparable: document.querySelector('.lv-splitfeed')?.getAttribute('data-delta'),
        rowText: row?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
        delta: delta ? {
          text: delta.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
          tone: delta.getAttribute('data-tone'),
        } : null,
      };
    });
    verify(evidence.telemetry?.splits?.length === 1
      && evidence.telemetry?.bestSplits?.length === evidence.telemetry?.gate?.total,
    'Repeat run did not load a compatible full-route PB before the first split.', evidence);
    const currentLeg = evidence.telemetry.splits[0];
    const bestLeg = evidence.telemetry.bestSplits[0];
    const expectedDelta = currentLeg - bestLeg;
    const expectedText = formatDeltaEvidence(expectedDelta);
    const expectedTone = Math.round(expectedDelta * 100) === 0
      ? 'flat'
      : expectedDelta < 0 ? 'good' : 'bad';
    verify(evidence.feedComparable === '1' && evidence.delta?.text.includes(expectedText)
      && evidence.delta?.text.includes('최고기록 대비') && evidence.delta?.tone === expectedTone,
    'Live split delta differs from the same-leg PB evidence.', {
      ...evidence,
      currentLeg,
      bestLeg,
      expectedDelta,
      expectedText,
      expectedTone,
    });
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [null]);
    return evidence;
  });
}

function formatDeltaEvidence(seconds) {
  const rounded = Math.round(seconds * 100) / 100;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded).toFixed(2)}`;
}

function verifyShearMatch(left, right, tolerance, message) {
  verify(left && right && left.states.length === right.states.length, message, { left, right, tolerance });
  for (let index = 0; index < left.states.length; index++) {
    const a = left.states[index];
    const b = right.states[index];
    verify(a.gateIndex === b.gateIndex && Math.abs(wrappedDelta(a.phase, b.phase)) <= tolerance,
      message, { index, left: a, right: b, tolerance });
  }
}

function wrappedDelta(a, b) {
  let delta = (a - b + Math.PI) % (Math.PI * 2);
  if (delta < 0) delta += Math.PI * 2;
  return delta - Math.PI;
}
