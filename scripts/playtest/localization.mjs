#!/usr/bin/env node

import {
  callHarness,
  inspectHarness,
  openBootScenario,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const LOCALE_STORAGE_KEY = 'last-vector.locale.v1';
const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'phase',
  'telemetry',
  'result',
  'damageHull',
  'setAutopilot',
  'setDriven',
  'step',
  'locale',
  'errors',
];
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 375, height: 667 },
  { width: 640, height: 360 },
];
const COMPACT_VIEWPORTS = VIEWPORTS.slice(2);
const BEST_STORAGE_KEY = 'last-vector.best.v1';
const BEST_STORAGE_VALUE = JSON.stringify({
  'cairn-drift-1337': {
    time: 1,
    splits: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  },
});
const STATIC_COPY = {
  ko: {
    title: {
      aria: '주 메뉴',
      eyebrow: '구역',
      tagline: 'CAIRN 항로를 꿰뚫고, 드리프트가 닫히기 전에 TERMINUS에 도달하라.',
      actions: { begin: '비행 시작', settings: '설정', controls: '조작법' },
      localeAria: '언어 선택',
      localeLabels: ['한국어', '영어'],
      footer: ['선체 KESTREL-C7', '주성 ACHRA', '항법 고정 정상'],
    },
    settings: {
      aria: '설정', kicker: '환경 설정', title: '설정', back: '뒤로',
      sections: ['비행', '화면', '영상', '오디오'],
      rows: [
        ['비행 보조', '항전 장치가 입력을 얼마나 감쇠할지 정합니다.'],
        ['기본 시점', '비행 중 C를 눌러 시점을 전환합니다.'],
        ['마우스 감도', ''], ['피치 반전', ''],
        ['시야각', '넓을수록 빠르게 읽고, 좁을수록 멀리 봅니다.'],
        ['카메라 흔들림', ''], ['품질', ''],
        ['렌더 배율', '내부 해상도입니다. 품질보다 먼저 낮추세요.'],
        ['프레임 표시', ''], ['모션 블러', ''], ['필름 그레인', ''],
        ['색수차', ''], ['전체 음량', ''], ['음악', ''],
      ],
      enumLabels: [
        ['아케이드', '표준', '원본'], ['추적', '조종석'], ['낮음', '중간', '높음', '최고'],
      ],
      switchLabels: ['끔', '끔', '켬', '켬', '켬'],
    },
    controls: {
      aria: '조작법', kicker: '조종사 참고', title: '조작법', back: '뒤로', or: '또는',
      actions: [
        '조향 — 자동 복귀 가상 스틱', '스로틀 올림 / 내림', '좌 / 우 롤', '부스터',
        '제동 및 드리프트', '좌 / 우 평행 이동', '상 / 하 평행 이동',
        '마우스 없이 피치 / 요', '추적 / 1인칭 조종석 전환', '일시정지', '비행 재시작',
      ],
      note: '출격하면 마우스가 고정됩니다. ESC를 누르면 마우스가 풀리고 비행이 일시정지됩니다.',
    },
    briefing: {
      aria: '비행 브리핑', kicker: '비행 브리핑', transit: '목적지 VESPER TERMINUS',
      statLabels: ['표식', '항로', '주성', '선체', '드리프트'],
      lines: [
        'ACHRA가 꺼져 가고 있다. 매시간 선반 얼음과 회전하는 철편이 마지막 생존 항로로 쏟아진다.',
        '응답하는 CAIRN은 아홉 기. 오래전에 사라진 손들이 남긴 표식이 곧 항로다.',
        '순서대로 통과하라. 좁은 구간에서는 암석이 바짝 파고들며, 제동만이 선회 공간을 만든다.',
      ],
      primer: '핵심 조작',
      primerActions: ['조향', '스로틀 올림 / 내림', '좌 / 우 롤', '부스터', '제동 및 드리프트', '마우스 없이 조향', '1인칭 조종석 전환'],
      actions: { engage: '출격', return: '뒤로' },
    },
    countdown: { aria: '출격 초읽기', launch: '출격 준비', go: '출발', live: '벡터 활성' },
    pause: {
      aria: '일시정지', kicker: '비행 정지', title: '일시정지',
      detail: '드리프트는 계속된다. 항로는 기다려 주지 않는다.',
      actions: { resume: '계속', restart: '재시작', settings: '설정', controls: '조작법', abort: '비행 중단' },
    },
    results: {
      aria: '비행 종료', kicker: '도착 확인', rank: '등급', total: '총 시간', newBest: '신기록',
      stats: ['표식', '최고 속도', '선체'], headers: ['표식', '구간', '', '경과'],
      actions: { again: '다시 비행', return: '타이틀로' },
    },
    failure: { aria: '선체 파손', title: '선체 파손', time: '시간', retry: '재도전' },
  },
  en: {
    title: {
      aria: 'Main menu', eyebrow: 'SECTOR',
      tagline: 'Thread the cairns. Make the terminus before the drift closes.',
      actions: { begin: 'BEGIN RUN', settings: 'SETTINGS', controls: 'CONTROLS' },
      localeAria: 'Language', localeLabels: ['Korean', 'English'],
      footer: ['HULL KESTREL-C7', 'PRIMARY ACHRA', 'NAV LOCK NOMINAL'],
    },
    settings: {
      aria: 'Settings', kicker: 'CONFIGURATION', title: 'SETTINGS', back: 'BACK',
      sections: ['FLIGHT', 'DISPLAY', 'IMAGE', 'AUDIO'],
      rows: [
        ['Flight assist', 'How much the avionics damp your inputs.'],
        ['Default camera', 'Press C during flight to switch views.'],
        ['Mouse sensitivity', ''], ['Invert pitch', ''],
        ['Field of view', 'Wider reads faster, narrower reads further.'],
        ['Camera shake', ''], ['Quality', ''],
        ['Render scale', 'Internal resolution. Drop it before you drop quality.'],
        ['Frame counter', ''], ['Motion blur', ''], ['Film grain', ''],
        ['Chromatic aberration', ''], ['Master', ''], ['Score', ''],
      ],
      enumLabels: [['ARCADE', 'STANDARD', 'RAW'], ['CHASE', 'COCKPIT'], ['LOW', 'MED', 'HIGH', 'ULTRA']],
      switchLabels: ['OFF', 'OFF', 'ON', 'ON', 'ON'],
    },
    controls: {
      aria: 'Controls', kicker: 'PILOT REFERENCE', title: 'CONTROLS', back: 'BACK', or: 'or',
      actions: [
        'Steer — self-centering virtual stick', 'Throttle up / down', 'Roll left / right', 'Boost',
        'Brake and drift', 'Strafe left / right', 'Strafe up / down',
        'Pitch / yaw without mouse', 'Toggle chase / first-person cockpit', 'Pause', 'Restart run',
      ],
      note: 'Pointer lock captures the mouse on launch. ESC releases it and holds the flight.',
    },
    briefing: {
      aria: 'Run briefing', kicker: 'RUN BRIEFING', transit: 'TRANSIT TO VESPER TERMINUS',
      statLabels: ['MARKERS', 'CORRIDOR', 'PRIMARY', 'HULL', 'DRIFT'],
      lines: [
        'ACHRA is going out. Every hour it sheds another kilometre of shelf ice and tumbling iron across the only corridor anything hull-sized can still survive.',
        'The cairns answer a hail — nine of them, set by hands that stopped setting things a long time ago. They are the line.',
        'Fly them in order. The line between two markers is not empty — on the tight legs the rock comes in close, and only the brake buys you room.',
      ],
      primer: 'CORE CONTROLS',
      primerActions: ['Steer', 'Throttle up / down', 'Roll left / right', 'Boost', 'Brake and drift', 'Steer without mouse', 'Toggle first-person cockpit'],
      actions: { engage: 'ENGAGE', return: 'BACK' },
    },
    countdown: { aria: 'Launch countdown', launch: 'LAUNCH SEQUENCE', go: 'GO', live: 'VECTOR LIVE' },
    pause: {
      aria: 'Paused', kicker: 'FLIGHT HELD', title: 'PAUSED',
      detail: 'Drift continues. The corridor does not wait.',
      actions: { resume: 'RESUME', restart: 'RESTART', settings: 'SETTINGS', controls: 'CONTROLS', abort: 'ABORT RUN' },
    },
    results: {
      aria: 'Run complete', kicker: 'ARRIVAL CONFIRMED', rank: 'RATING', total: 'TOTAL', newBest: 'NEW BEST',
      stats: ['MARKERS', 'TOP SPEED', 'HULL'], headers: ['MARKER', 'SEGMENT', '', 'ELAPSED'],
      actions: { again: 'RUN AGAIN', return: 'RETURN' },
    },
    failure: { aria: 'Hull breach', title: 'HULL BREACH', time: 'TIME', retry: 'RETRY' },
  },
};
const TERMINAL_COPY = {
  ko: {
    clean: '무손상',
    damaged: '손상',
    speedUnit: 'M/S',
    bestComparison: '최고 00:01.00 대비 +188.05',
  },
  en: {
    clean: 'UNTOUCHED',
    damaged: 'SCARRED',
    speedUnit: 'M/S',
    bestComparison: '+188.05 vs BEST 00:01.00',
  },
};
const EXPECTED_VIEW_SEMANTICS = {
  title: {
    actions: ['begin', 'settings', 'controls'],
    controls: [],
    settings: [],
  },
  settings: {
    actions: ['return'],
    controls: [],
    settings: [
      { setting: 'assistLevel', value: 'standard', options: ['arcade', 'standard', 'raw'] },
      { setting: 'cameraMode', value: 'chase', options: ['chase', 'cockpit'] },
      { setting: 'mouseSensitivity', value: '1', options: [] },
      { setting: 'invertY', value: 'false', options: [] },
      { setting: 'fov', value: '76', options: [] },
      { setting: 'cameraShake', value: '1', options: [] },
      { setting: 'quality', value: 'high', options: ['low', 'medium', 'high', 'ultra'] },
      { setting: 'renderScale', value: '1', options: [] },
      { setting: 'showFps', value: 'false', options: [] },
      { setting: 'motionBlur', value: 'true', options: [] },
      { setting: 'filmGrain', value: 'true', options: [] },
      { setting: 'chromaticAberration', value: 'true', options: [] },
      { setting: 'masterVolume', value: '0.8', options: [] },
      { setting: 'musicVolume', value: '0.65', options: [] },
    ],
  },
  controls: {
    actions: ['return'],
    controls: [
      'mouse-steer', 'throttle', 'roll', 'boost', 'brake', 'strafe-horizontal',
      'strafe-vertical', 'keyboard-steer', 'camera-toggle', 'pause', 'restart',
    ],
    settings: [],
  },
  briefing: {
    actions: ['engage', 'return'],
    controls: [
      'mouse-steer', 'throttle', 'roll', 'boost', 'brake', 'keyboard-steer', 'camera-toggle',
    ],
    settings: [],
  },
  pause: {
    actions: ['resume', 'restart', 'settings', 'controls', 'abort'],
    controls: [],
    settings: [],
  },
  results: {
    actions: ['again', 'return'],
    controls: [],
    settings: [],
  },
  failure: {
    actions: ['retry'],
    controls: [],
    settings: [],
  },
};
const EXPECTED_NAV_ORDER = {
  title: ['action:begin', 'action:settings', 'action:controls', 'nav:segmented'],
  settings: [
    'setting:assistLevel',
    'setting:cameraMode',
    'setting:mouseSensitivity',
    'setting:invertY',
    'setting:fov',
    'setting:cameraShake',
    'setting:quality',
    'setting:renderScale',
    'setting:showFps',
    'setting:motionBlur',
    'setting:filmGrain',
    'setting:chromaticAberration',
    'setting:masterVolume',
    'setting:musicVolume',
    'action:return',
  ],
  controls: ['action:return'],
  briefing: ['action:engage', 'action:return'],
  pause: ['action:resume', 'action:restart', 'action:settings', 'action:controls', 'action:abort'],
  results: ['action:again', 'action:return'],
  failure: ['action:retry'],
};
const EXPECTED_METADATA = {
  ko: {
    title: 'LAST VECTOR — THE CAIRN DRIFT',
    description: '붕괴하는 잔해 항로를 가르는 우주 비행 게임.',
  },
  en: {
    title: 'LAST VECTOR — The Cairn Drift',
    description: 'Fly the cairn line through a collapsing debris corridor.',
  },
};

await runManagedSuite({
  suite: 'localization',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runLocalization,
});

async function runLocalization({ report, session, options }) {
  const page = session.page;
  await callHarness(page, 'ready', [], options.timeoutMs);

  await report.check({
    id: 'I18N.default-korean',
    name: 'A clean first boot selects Korean before player-facing UI',
    assertion:
      'An isolated empty-storage boot uses lang=ko before both loader and Overlay insertion, exposes '
      + 'the exact 1.4.0 locale contract, and remains unlocked on the title screen.',
  }, async () => {
    const scenario = await openBootScenario(session, { initScripts: [installBootProbe] });
    try {
      await ready(scenario.page, options.timeoutMs);
      const inspection = await inspectHarness(scenario.page, REQUIRED_METHODS);
      const locale = await localeSnapshot(scenario.page);
      const boot = await scenario.page.evaluate(() => window.__LV_BOOT_PROBE ?? []);
      const title = await titleLocaleEvidence(scenario.page);
      const evidence = { inspection, locale, boot, title, requests: scenario.requests };
      verify(inspection.version === '1.4.0', 'Harness version is not exactly 1.4.0.', evidence);
      verify(inspection.methods.locale === true, 'Harness locale() capability is missing.', evidence);
      verify(locale.selected === 'ko' && locale.active === null && locale.locked === false,
        'Empty storage did not produce an unlocked Korean title.', evidence);
      verify(locale.documentLang === 'ko', 'The clean document language is not Korean.', evidence);
      verify(boot.some((entry) => entry.kind === 'loader' && entry.lang === 'ko'),
        'Korean was not active when the loader entered the document.', evidence);
      verify(boot.some((entry) => entry.kind === 'overlay' && entry.lang === 'ko'),
        'Korean was not active when the Overlay entered the document.', evidence);
      verify(title.value === 'ko' && title.checked.length === 1 && title.checked[0] === 'ko',
        'The clean title selector does not contain exactly one checked Korean option.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.persisted-english-clean-boot',
    name: 'Persisted English is applied before first boot UI construction',
    assertion:
      'A separate storageState-seeded context uses lang=en when its loader and Overlay are inserted, '
      + 'without sharing context, cache, requests, or init scripts with the Korean boot.',
  }, async () => {
    const scenario = await openBootScenario(session, {
      localStorageSeed: { [LOCALE_STORAGE_KEY]: 'en' },
      initScripts: [installBootProbe],
    });
    try {
      await ready(scenario.page, options.timeoutMs);
      const locale = await localeSnapshot(scenario.page);
      const boot = await scenario.page.evaluate(() => window.__LV_BOOT_PROBE ?? []);
      const title = await titleLocaleEvidence(scenario.page);
      const evidence = { locale, boot, title, requests: scenario.requests };
      verify(locale.selected === 'en' && locale.active === null && locale.locked === false,
        'Persisted English did not produce an unlocked English title.', evidence);
      verify(locale.documentLang === 'en', 'The persisted-English document language is not English.', evidence);
      verify(boot.some((entry) => entry.kind === 'loader' && entry.lang === 'en'),
        'English was not active when the loader entered the document.', evidence);
      verify(boot.some((entry) => entry.kind === 'overlay' && entry.lang === 'en'),
        'English was not active when the Overlay entered the document.', evidence);
      verify(boot.some((entry) => entry.kind === 'loader' && entry.text.includes('initialising')),
        'The first persisted-English loader did not use the English loader catalog.', evidence);
      verify(title.value === 'en' && title.checked.length === 1 && title.checked[0] === 'en',
        'The persisted-English title selector does not contain exactly one checked English option.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.title-selector',
    name: 'Title locale changes update document state and preserve semantic focus',
    assertion:
      'From the initially focused BEGIN RUN action, keyboard navigation performs ko -> en -> ko; '
      + 'each change persists, replaces the visible Overlay, updates metadata, and keeps focus on '
      + 'the locale radiogroup; directly focused radios are restored, and an independent context-loss '
      + 'scenario resolves fatal copy from the current locale.',
  }, async () => {
    const initial = await localeSnapshot(page);
    verify(initial.selected === 'ko' && initial.active === null, 'Managed title did not start unlocked in Korean.', initial);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await assertLocaleFocus(page);

    const koreanRoot = await page.locator('.lv-root').elementHandle();
    await page.keyboard.press('ArrowRight');
    await waitForSelected(page, 'en');
    const english = await localeSnapshot(page);
    const englishTitle = await titleLocaleEvidence(page);
    const englishMetadata = await metadataEvidence(page);
    const englishFocus = await assertLocaleFocus(page);
    const englishStored = await page.evaluate((key) => localStorage.getItem(key), LOCALE_STORAGE_KEY);
    const koreanDetached = koreanRoot ? !(await koreanRoot.evaluate((node) => node.isConnected)) : false;

    const englishRoot = await page.locator('.lv-root').elementHandle();
    await page.keyboard.press('ArrowLeft');
    await waitForSelected(page, 'ko');
    const korean = await localeSnapshot(page);
    const koreanTitle = await titleLocaleEvidence(page);
    const koreanMetadata = await metadataEvidence(page);
    const koreanFocus = await assertLocaleFocus(page);
    const koreanStored = await page.evaluate((key) => localStorage.getItem(key), LOCALE_STORAGE_KEY);
    const englishDetached = englishRoot ? !(await englishRoot.evaluate((node) => node.isConnected)) : false;

    const directEnglishRoot = await page.locator('.lv-root').elementHandle();
    await page.locator('[data-view="title"][data-open="1"] [data-locale="en"]').evaluate((radio) => {
      radio.focus();
      radio.click();
    });
    await waitForSelected(page, 'en');
    const directEnglishFocus = await directLocaleFocus(page);
    const directEnglishDetached = directEnglishRoot
      ? !(await directEnglishRoot.evaluate((node) => node.isConnected))
      : false;

    const directKoreanRoot = await page.locator('.lv-root').elementHandle();
    await page.locator('[data-view="title"][data-open="1"] [data-locale="ko"]').evaluate((radio) => {
      radio.focus();
      radio.click();
    });
    await waitForSelected(page, 'ko');
    const directKoreanFocus = await directLocaleFocus(page);
    const directKoreanDetached = directKoreanRoot
      ? !(await directKoreanRoot.evaluate((node) => node.isConnected))
      : false;

    const lossScenario = await openBootScenario(session);
    let contextLoss;
    try {
      await ready(lossScenario.page, options.timeoutMs);
      await focusLocale(lossScenario.page);
      await lossScenario.page.keyboard.press('ArrowRight');
      await waitForSelected(lossScenario.page, 'en');
      const beforeLoss = await metadataEvidence(lossScenario.page);
      await lossScenario.page.evaluate(() => {
        const canvas = document.querySelector('.lv-canvas');
        if (!canvas) throw new Error('Game canvas is missing.');
        canvas.dispatchEvent(new Event('webglcontextlost', { bubbles: false, cancelable: true }));
      });
      await lossScenario.page.locator('.lv-fatal').waitFor({ state: 'visible', timeout: 5_000 });
      const fatal = await lossScenario.page.evaluate(() => ({
        title: document.querySelector('.lv-fatal h1')?.textContent ?? null,
        detail: document.querySelector('.lv-fatal p')?.textContent ?? null,
      }));
      contextLoss = { beforeLoss, fatal };
    } finally {
      await lossScenario.close();
    }

    const evidence = {
      initial,
      english: {
        locale: english,
        title: englishTitle,
        metadata: englishMetadata,
        focus: englishFocus,
        stored: englishStored,
        oldRootDetached: koreanDetached,
      },
      korean: {
        locale: korean,
        title: koreanTitle,
        metadata: koreanMetadata,
        focus: koreanFocus,
        stored: koreanStored,
        oldRootDetached: englishDetached,
      },
      directRadio: {
        english: { focus: directEnglishFocus, oldRootDetached: directEnglishDetached },
        korean: { focus: directKoreanFocus, oldRootDetached: directKoreanDetached },
      },
      contextLoss,
    };
    verify(english.selected === 'en' && englishStored === 'en' && koreanDetached,
      'The Korean-to-English keyboard change did not persist and replace the Overlay.', evidence);
    verify(korean.selected === 'ko' && koreanStored === 'ko' && englishDetached,
      'The English-to-Korean keyboard change did not persist and replace the Overlay.', evidence);
    for (const state of [englishTitle, koreanTitle]) {
      verify(state.checked.length === 1 && state.checked[0] === state.value,
        'A reconstructed selector does not have exactly one checked option matching its value.', evidence);
    }
    verify(JSON.stringify(englishMetadata) === JSON.stringify({ lang: 'en', ...EXPECTED_METADATA.en })
      && JSON.stringify(koreanMetadata) === JSON.stringify({ lang: 'ko', ...EXPECTED_METADATA.ko }),
    'Title locale switching did not update lang, document title, and meta description together.', evidence);
    verify(directEnglishDetached && directEnglishFocus.locale === 'en'
      && directEnglishFocus.checked === 'true'
      && directKoreanDetached && directKoreanFocus.locale === 'ko'
      && directKoreanFocus.checked === 'true',
    'A directly focused locale radio was not restored after Overlay replacement.', evidence);
    verify(contextLoss.beforeLoss.lang === 'en'
      && contextLoss.fatal.title === 'GRAPHICS CONTEXT LOST'
      && contextLoss.fatal.detail
        === 'The browser dropped the WebGL context — usually a driver reset, a GPU switch, or another tab exhausting video memory. Reload the page to continue.',
    'Context-loss fatal UI did not resolve the current English locale at event time.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.run-lock',
    name: 'Beginning the briefing locks the selected locale for the run',
    assertion:
      'A title-only English selection becomes the active run locale before phase changes to briefing, '
      + 'and no visible locale control remains available after that boundary.',
  }, async () => {
    await focusLocale(page);
    await page.keyboard.press('ArrowRight');
    await waitForSelected(page, 'en');
    await page.locator('[data-view="title"][data-open="1"] [data-action="begin"]').click();
    await page.waitForFunction(() => window.__LV?.phase() === 'briefing');
    const storedBeforeRejectedRequest = await page.evaluate(
      (key) => localStorage.getItem(key),
      LOCALE_STORAGE_KEY,
    );
    await page.evaluate(() => {
      document.querySelector('[data-view="title"] [data-locale="ko"]')?.click();
    });
    const storedAfterRejectedRequest = await page.evaluate(
      (key) => localStorage.getItem(key),
      LOCALE_STORAGE_KEY,
    );
    const locale = await localeSnapshot(page);
    const activeViewControls = await page.locator('[data-view][data-open="1"] [data-locale]').count();
    const evidence = {
      locale,
      phase: await callHarness(page, 'phase'),
      activeViewControls,
      storedBeforeRejectedRequest,
      storedAfterRejectedRequest,
    };
    verify(locale.selected === 'en' && locale.active === 'en' && locale.locked,
      'The briefing boundary did not lock the selected English locale.', evidence);
    verify(activeViewControls === 0, 'A locale control remained in the active view after the run lock.', evidence);
    verify(storedBeforeRejectedRequest === 'en' && storedAfterRejectedRequest === 'en',
      'An out-of-title locale request mutated persistence.', evidence);

    const directScenario = await openBootScenario(session, {
      localStorageSeed: { [LOCALE_STORAGE_KEY]: 'en' },
    });
    try {
      await ready(directScenario.page, options.timeoutMs);
      const directBefore = await localeSnapshot(directScenario.page);
      await callHarness(directScenario.page, 'startRun', [{ skipIntro: true }]);
      const directAfter = await localeSnapshot(directScenario.page);
      evidence.directStart = { before: directBefore, after: directAfter };
      verify(directBefore.active === null && directAfter.active === 'en' && directAfter.locked,
        'Harness direct-start did not establish the run locale lock.', evidence);
    } finally {
      await directScenario.close();
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.restart-lock',
    name: 'Restart and failure retry preserve the active run locale',
    assertion:
      'External storage changes cannot alter the active locale through restart or failure retry; '
      + 'selected and active remain the locale captured at the run boundary.',
  }, async () => {
    const before = await localeSnapshot(page);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await page.evaluate((key) => localStorage.setItem(key, 'ko'), LOCALE_STORAGE_KEY);
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__LV?.phase() === 'countdown');
    const afterRestart = await localeSnapshot(page);

    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'damageHull', [2]);
    await callHarness(page, 'step', [1, 1 / 60]);
    await page.waitForFunction(() => window.__LV?.phase() === 'failed');
    await page.locator('[data-view="results"][data-open="1"] [data-action="retry"]').click();
    await page.waitForFunction(() => window.__LV?.phase() === 'countdown');
    const afterRetry = await localeSnapshot(page);
    const evidence = { before, afterRestart, afterRetry };
    for (const state of [before, afterRestart, afterRetry]) {
      verify(state.selected === 'en' && state.active === 'en' && state.locked,
        'Restart or retry changed the locked English run locale.', evidence);
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.return-title-unlock',
    name: 'Returning to title unlocks and reloads the persisted locale',
    assertion:
      'After run cleanup and the title phase transition, storage is reloaded, the run locale becomes '
      + 'nullable/unlocked, Korean is applied, and the visible title BEGIN RUN action regains focus.',
  }, async () => {
    const locked = await localeSnapshot(page);
    if (await page.locator('[data-view="pause"][data-open="1"] [data-action="abort"]').count() === 0) {
      await page.keyboard.press('Escape');
    }
    const abort = page.locator('[data-view="pause"][data-open="1"] [data-action="abort"]');
    await abort.waitFor({ state: 'visible', timeout: 5_000 });
    await abort.click();
    await page.waitForFunction(() => window.__LV?.phase() === 'title');
    const locale = await localeSnapshot(page);
    const title = await page.evaluate(() => {
      const begin = document.querySelector('[data-view="title"][data-open="1"] [data-action="begin"]');
      return {
        beginVisible: begin instanceof HTMLElement && begin.getClientRects().length > 0,
        beginFocused: document.activeElement === begin,
      };
    });
    const evidence = { locked, locale, title };
    verify(locked.active === 'en' && locked.locked, 'The run was not locked before returning to title.', evidence);
    verify(locale.selected === 'ko' && locale.active === null && locale.locked === false,
      'Returning to title did not reload Korean and clear the active run locale.', evidence);
    verify(locale.documentLang === 'ko', 'Returning to title did not apply lang=ko.', evidence);
    verify(title.beginVisible && title.beginFocused,
      'The visible title BEGIN RUN action was not restored and focused.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.overlay-listener-stability',
    name: 'Repeated Overlay replacement keeps active listeners and subscribers stable',
    assertion:
      'A pre-document EventTarget/ResizeObserver census reports the same active listener population '
      + 'by semantic target/type/capture after repeated switches, one active ResizeObserver, and '
      + 'exactly one SettingsStore subscriber throughout.',
  }, async () => {
    const scenario = await openBootScenario(session, { initScripts: [installListenerCensus] });
    try {
      await ready(scenario.page, options.timeoutMs);
      await scenario.page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      const firstLocale = await localeSnapshot(scenario.page);
      await focusLocale(scenario.page);
      const before = await scenario.page.evaluate(() => window.__LV_LISTENER_CENSUS.snapshot());
      const snapshots = [firstLocale];
      for (let i = 0; i < 8; i++) {
        await scenario.page.keyboard.press(i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
        await waitForSelected(scenario.page, i % 2 === 0 ? 'en' : 'ko');
        snapshots.push(await localeSnapshot(scenario.page));
        await assertLocaleFocus(scenario.page);
      }
      const after = await scenario.page.evaluate(() => window.__LV_LISTENER_CENSUS.snapshot());
      const evidence = { before, after, localeSnapshots: snapshots };
      const listenerKeys = before.listeners.map(({ key }) => key);
      verify(listenerKeys.some((key) => key.includes('::click::'))
        && listenerKeys.some((key) => key.includes('::keydown::'))
        && listenerKeys.some((key) => key.includes('::resize::'))
        && listenerKeys.some((key) => key.includes('::pointerlockchange::'))
        && listenerKeys.some((key) => key.includes('::pointerlockerror::')),
      'The listener census did not observe every required listener category.', evidence);
      verify(JSON.stringify(after.listeners) === JSON.stringify(before.listeners),
        'The active listener population changed across Overlay replacements.', evidence);
      verify(before.resize.active === 1 && after.resize.active === 1,
        'Overlay replacement did not preserve exactly one active ResizeObserver.', evidence);
      verify(after.resize.constructed - before.resize.constructed === 8
        && after.resize.disconnected - before.resize.disconnected === 8,
      'Each replacement did not pair one ResizeObserver construction with one disconnection.', evidence);
      verify(snapshots.every((snapshot) => snapshot.settingsSubscribers === 1),
        'SettingsStore subscriber count did not remain exactly one.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.static-copy',
    name: 'Every static screen renders the selected locale exactly',
    assertion:
      'Independent empty-storage Korean and persisted-English boots use literal fixtures while '
      + 'real controls reach title, settings, controls, briefing, countdown, pause, results, and failure.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale);
      try {
        await ready(scenario.page, options.timeoutMs);
        evidence[locale] = {
          fresh: await assertStaticCopyFlow(scenario.page, locale, options),
          freshRequests: scenario.requests,
        };
      } finally {
        await scenario.close();
      }

      const existingBestScenario = await openLocaleScenario(session, locale, {
        localStorageSeed: { [BEST_STORAGE_KEY]: BEST_STORAGE_VALUE },
      });
      try {
        await ready(existingBestScenario.page, options.timeoutMs);
        await finishAutopilot(existingBestScenario.page, options, { collision: true });
        const terminal = await terminalResultSnapshot(existingBestScenario.page);
        assertTerminalResult(locale, terminal, {
          hull: TERMINAL_COPY[locale].damaged,
          delta: TERMINAL_COPY[locale].bestComparison,
        });
        evidence[locale].existingBestDamaged = terminal;
        evidence[locale].existingBestRequests = existingBestScenario.requests;
      } finally {
        await existingBestScenario.close();
      }
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.semantic-stability',
    name: 'Localization preserves semantic action, control, and setting identifiers',
    assertion:
      'Per-view action/control ids and raw setting values are unique and byte-identical between '
      + 'Korean and English, including dynamically built terminal screens.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale);
      try {
        await ready(scenario.page, options.timeoutMs);
        evidence[locale] = await collectSemanticFlow(scenario.page, options);
        verify(JSON.stringify(evidence[locale]) === JSON.stringify(EXPECTED_VIEW_SEMANTICS),
          `${locale} semantic map differs from the independent literal manifest.`, {
            locale,
            expected: EXPECTED_VIEW_SEMANTICS,
            actual: evidence[locale],
          });
      } finally {
        await scenario.close();
      }
    }
    verify(JSON.stringify(evidence.ko) === JSON.stringify(evidence.en),
      'The Korean and English semantic maps differ.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.preserved-latin',
    name: 'Proper nouns, bindings, units, and ranks stay Latin',
    assertion:
      'Rendered Korean and English retain the exact proper nouns, key set, M/S unit, and rank code.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale);
      try {
        await ready(scenario.page, options.timeoutMs);
        evidence[locale] = await collectPreservedLatin(scenario.page, options);
      } finally {
        await scenario.close();
      }
    }
    const required = ['LAST VECTOR', 'THE CAIRN DRIFT', 'ACHRA', 'KESTREL-C7', 'VESPER TERMINUS', 'TERMINUS'];
    for (const locale of ['ko', 'en']) {
      verify(required.every((token) => evidence[locale].properNouns.includes(token)),
        `${locale} omitted a preserved proper noun.`, evidence);
      verify(evidence[locale].keys.join('|') === evidence.ko.keys.join('|'),
        `${locale} changed the rendered key set.`, evidence);
      verify(evidence[locale].speedUnits.every((unit) => unit === 'M/S'),
        `${locale} changed the results speed unit.`, evidence);
      verify(/^[SABCD]$/.test(evidence[locale].rank), `${locale} rendered a translated rank.`, evidence);
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.embedded-lang',
    name: 'Embedded Latin tokens carry explicit English language semantics',
    assertion:
      'Korean ACHRA, CAIRN, C, ESC, and tagline CAIRN/TERMINUS tokens are exact lang=en spans.',
  }, async () => {
    const scenario = await openLocaleScenario(session, 'ko');
    try {
      await ready(scenario.page, options.timeoutMs);
      const evidence = await collectEmbeddedLang(scenario.page);
      for (const [surface, expected] of Object.entries({
        tagline: ['CAIRN', 'TERMINUS'],
        briefingLine1: ['ACHRA'],
        briefingLine2: ['CAIRN'],
        cameraHint: ['C'],
        pointerNote: ['ESC'],
      })) {
        verify(JSON.stringify(evidence[surface]) === JSON.stringify(expected),
          `${surface} does not expose the required lang=en tokens.`, evidence);
      }
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.text-only',
    name: 'Localized screen copy is text-only and injection-safe',
    assertion:
      'The screens tree contains no executable/media nodes and catalog-copy children are only '
      + 'text nodes or explicit lang=en spans across menus, countdown, pause, results, and failure.',
  }, async () => {
    const probeScenario = await openLocaleScenario(session, 'ko');
    let scopeProbe;
    try {
      await ready(probeScenario.page, options.timeoutMs);
      await probeScenario.page.evaluate(() => {
        const screens = document.querySelector('.lv-screens');
        if (!(screens instanceof HTMLElement)) throw new Error('Screens root is missing.');
        const probe = document.createElement('img');
        probe.dataset['safeDomProbe'] = 'direct-child';
        probe.alt = '';
        screens.appendChild(probe);
      });
      try {
        scopeProbe = await safeDomSnapshot(probeScenario.page, 'title');
        verify(scopeProbe.forbidden.some((entry) => entry.probe === 'direct-child'),
          'The safe-DOM helper did not detect a forbidden direct child of .lv-screens.', scopeProbe);
      } finally {
        await probeScenario.page.evaluate(() => {
          document.querySelector('[data-safe-dom-probe="direct-child"]')?.remove();
        });
      }
    } finally {
      await probeScenario.close();
    }

    const scenario = await openLocaleScenario(session, 'ko', {
      localStorageSeed: { [BEST_STORAGE_KEY]: BEST_STORAGE_VALUE },
    });
    try {
      await ready(scenario.page, options.timeoutMs);
      const evidence = { scopeProbe, snapshots: [] };
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'title'));
      await clickAction(scenario.page, 'title', 'settings');
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'settings'));
      await clickAction(scenario.page, 'settings', 'return');
      await clickAction(scenario.page, 'title', 'controls');
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'controls'));
      await clickAction(scenario.page, 'controls', 'return');
      await clickAction(scenario.page, 'title', 'begin');
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'briefing'));
      await clickAction(scenario.page, 'briefing', 'engage');
      await scenario.page.locator('[data-view="countdown"][data-open="1"]').waitFor({ state: 'visible' });
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'countdown'));
      await scenario.page.waitForFunction(() => window.__LV?.phase() === 'flying');
      await scenario.page.keyboard.press('Escape');
      await scenario.page.locator('[data-view="pause"][data-open="1"]').waitFor({ state: 'visible' });
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'pause'));
      await clickAction(scenario.page, 'pause', 'resume');
      await finishAutopilot(scenario.page, options);
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'results'));
      await clickAction(scenario.page, 'results', 'again');
      await forceFailure(scenario.page, options);
      evidence.snapshots.push(await safeDomSnapshot(scenario.page, 'failure'));

      evidence.forbidden = evidence.snapshots.flatMap(({ forbidden }) => forbidden);
      evidence.invalidCopyChildren = evidence.snapshots.flatMap(({ invalidCopyChildren }) => invalidCopyChildren);
      verify(evidence.forbidden.length === 0, 'Screens contain a forbidden executable/media node.', evidence);
      verify(evidence.invalidCopyChildren.length === 0,
        'Catalog-derived copy contains a child other than a lang=en token span.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.responsive-actions',
    name: 'Primary actions remain visible without document overflow',
    assertion:
      'At 1920x1080, 1280x720, 375x667, and 640x360 in both locales, every opened screen keeps '
      + 'its primary action fully in the viewport and the document at viewport bounds.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale);
      try {
        await ready(scenario.page, options.timeoutMs);
        evidence[locale] = await collectResponsiveFlow(scenario.page, options);
      } finally {
        await scenario.close();
      }
    }
    const failures = Object.values(evidence).flat().filter((measurement) => !measurement.pass);
    verify(failures.length === 0, 'A primary action or document exceeds its viewport.', { failures, evidence });
    return evidence;
  });

  await report.check({
    id: 'I18N.primer-camera-row',
    name: 'The briefing camera row is initially visible on compact screens',
    assertion:
      'At 375x667 and 640x360 in both locales, the full camera-toggle row is inside the viewport '
      + 'and the visible clip of its nearest .lv-brief-cols scroller without scrolling.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale);
      try {
        await ready(scenario.page, options.timeoutMs);
        await clickAction(scenario.page, 'title', 'begin');
        evidence[locale] = [];
        for (const viewport of COMPACT_VIEWPORTS) {
          await scenario.page.setViewportSize(viewport);
          const measurement = await measurePrimerCamera(scenario.page, viewport);
          evidence[locale].push(measurement);
        }
      } finally {
        await scenario.close();
      }
    }
    const failures = Object.values(evidence).flat().filter((measurement) => !measurement.pass);
    verify(failures.length === 0, 'The camera-toggle row starts outside the visible briefing clip.', {
      failures,
      evidence,
    });
    return evidence;
  });

  await report.check({
    id: 'I18N.no-overflow',
    name: 'Fixed-width translated leaves do not overflow',
    assertion:
      'Result comparison headers/cells and other fixed-width labels satisfy scrollWidth <= clientWidth + 1 '
      + 'in Korean and English at 640x360.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale, {
        localStorageSeed: { [BEST_STORAGE_KEY]: BEST_STORAGE_VALUE },
      });
      try {
        await ready(scenario.page, options.timeoutMs);
        await scenario.page.setViewportSize({ width: 640, height: 360 });
        await finishAutopilot(scenario.page, options);
        evidence[locale] = await measureOverflow(scenario.page);
        const comparisonHeader = evidence[locale].find(({ kind }) => kind === 'comparison-header');
        if (locale === 'ko') {
          verify(comparisonHeader?.text === '최고기록 대비',
            'Korean results did not expose the approved comparison header for overflow measurement.', {
              comparisonHeader,
              measurements: evidence[locale],
            });
        }
      } finally {
        await scenario.close();
      }
    }
    const failures = Object.entries(evidence).flatMap(([locale, measurements]) => measurements
      .filter((measurement) => !measurement.pass)
      .map((measurement) => ({ locale, ...measurement })));
    verify(failures.length === 0, 'A fixed-width localized leaf overflows its box.', { failures, evidence });
    return evidence;
  });

  await report.check({
    id: 'I18N.locale-focus-parity',
    name: 'Focus order is locale-independent across replacement and screen entry',
    assertion:
      'Arrow adjustment, Enter activation, and direct radio activation preserve semantic focus; '
      + 'literal DOM order plus real W/S and range-aware Tab traversal match between locales.',
  }, async () => {
    const replacement = await collectLocaleReplacementFocus(session, options);
    const evidence = { replacement, locales: {} };
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale);
      try {
        await ready(scenario.page, options.timeoutMs);
        evidence.locales[locale] = await collectFocusFlow(scenario.page, options);
      } finally {
        await scenario.close();
      }
    }
    verify(replacement.every((entry) => entry.pass),
      'A locale activation path failed to preserve semantic focus.', evidence);
    verify(JSON.stringify(evidence.locales.ko) === JSON.stringify(evidence.locales.en),
      'Korean and English screen focus order differs.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.title-lock-visibility',
    name: 'Locale controls are title-only throughout the run lifecycle',
    assertion:
      'Exactly one title locale is selected and no active briefing, countdown, flying, results, '
      + 'or failure surface exposes a locale control.',
  }, async () => {
    const scenario = await openLocaleScenario(session, 'ko');
    try {
      await ready(scenario.page, options.timeoutMs);
      const evidence = { title: await localeVisibility(scenario.page), locked: [] };
      verify(evidence.title.selected === 1 && evidence.title.activeControls === 2,
        'The title does not expose exactly one selected locale.', evidence);
      await clickAction(scenario.page, 'title', 'begin');
      evidence.locked.push(await localeVisibility(scenario.page, 'briefing'));
      await clickAction(scenario.page, 'briefing', 'engage');
      await scenario.page.locator('[data-view="countdown"][data-open="1"]').waitFor({ state: 'visible' });
      evidence.locked.push(await localeVisibility(scenario.page, 'countdown'));
      await scenario.page.waitForFunction(() => window.__LV?.phase() === 'flying');
      evidence.locked.push(await localeVisibility(scenario.page, 'flying'));
      await finishAutopilot(scenario.page, options);
      evidence.locked.push(await localeVisibility(scenario.page, 'results'));
      await clickAction(scenario.page, 'results', 'again');
      await forceFailure(scenario.page, options);
      evidence.locked.push(await localeVisibility(scenario.page, 'failure'));
      verify(evidence.locked.every((entry) => entry.activeControls === 0),
        'A locale control is active after the title boundary.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });
}

async function openLocaleScenario(session, locale, extra = {}) {
  const localStorageSeed = { ...(extra.localStorageSeed ?? {}) };
  if (locale === 'en') localStorageSeed[LOCALE_STORAGE_KEY] = 'en';
  const options = { ...extra };
  if (Object.keys(localStorageSeed).length > 0) options.localStorageSeed = localStorageSeed;
  else delete options.localStorageSeed;
  return openBootScenario(session, options);
}

async function clickAction(page, view, action) {
  await page.locator(`[data-view="${view}"][data-open="1"] [data-action="${action}"]`).click();
}

async function assertStaticCopyFlow(page, locale, options) {
  const expected = STATIC_COPY[locale];
  const evidence = {};
  evidence.title = await staticCopySnapshot(page, 'title');
  assertExactCopy(locale, 'title', evidence.title, expected.title);

  await page.locator('[data-view="title"][data-open="1"] [data-action="settings"]').click();
  evidence.settings = await staticCopySnapshot(page, 'settings');
  assertExactCopy(locale, 'settings', evidence.settings, expected.settings);
  await page.locator('[data-view="settings"][data-open="1"] [data-action="return"]').click();

  await page.locator('[data-view="title"][data-open="1"] [data-action="controls"]').click();
  evidence.controls = await staticCopySnapshot(page, 'controls');
  assertExactCopy(locale, 'controls', evidence.controls, expected.controls);
  await page.locator('[data-view="controls"][data-open="1"] [data-action="return"]').click();

  await page.locator('[data-view="title"][data-open="1"] [data-action="begin"]').click();
  evidence.briefing = await staticCopySnapshot(page, 'briefing');
  assertExactCopy(locale, 'briefing', evidence.briefing, expected.briefing);

  await page.locator('[data-view="briefing"][data-open="1"] [data-action="engage"]').click();
  await page.locator('[data-view="countdown"][data-open="1"]').waitFor({ state: 'visible' });
  evidence.countdown = await staticCopySnapshot(page, 'countdown');
  verify(evidence.countdown.aria === expected.countdown.aria
    && evidence.countdown.label === expected.countdown.launch,
  `${locale} countdown launch copy differs from the literal fixture.`, {
    actual: evidence.countdown,
    expected: expected.countdown,
  });
  await page.waitForFunction(() => document.querySelector('[data-view="countdown"]')
    ?.getAttribute('data-countdown-value') === 'go');
  evidence.countdownGo = await staticCopySnapshot(page, 'countdown');
  verify(evidence.countdownGo.number === expected.countdown.go
    && evidence.countdownGo.label === expected.countdown.live,
  `${locale} countdown GO copy differs from the literal fixture.`, {
    actual: evidence.countdownGo,
    expected: expected.countdown,
  });

  await page.waitForFunction(() => window.__LV?.phase() === 'flying');
  await page.keyboard.press('Escape');
  await page.locator('[data-view="pause"][data-open="1"]').waitFor({ state: 'visible' });
  evidence.pause = await staticCopySnapshot(page, 'pause');
  assertExactCopy(locale, 'pause', evidence.pause, expected.pause);
  await page.locator('[data-view="pause"][data-open="1"] [data-action="resume"]').click();

  await finishAutopilot(page, options);
  evidence.results = await staticCopySnapshot(page, 'results');
  assertExactCopy(locale, 'results', evidence.results, expected.results);
  evidence.resultsTerminal = await terminalResultSnapshot(page);
  assertTerminalResult(locale, evidence.resultsTerminal, {
    hull: TERMINAL_COPY[locale].clean,
    delta: null,
  });

  await page.locator('[data-view="results"][data-open="1"] [data-action="again"]').click();
  await forceFailure(page, options);
  evidence.failure = await staticCopySnapshot(page, 'failure');
  assertExactCopy(locale, 'failure', evidence.failure, expected.failure);
  return evidence;
}

function assertExactCopy(locale, view, actual, expected) {
  verify(JSON.stringify(actual) === JSON.stringify(expected),
    `${locale} ${view} copy differs from the independent literal fixture.`, { actual, expected });
}

function assertTerminalResult(locale, actual, expected) {
  verify(actual.hull === expected.hull,
    `${locale} results hull state differs from the literal fixture.`, { actual, expected });
  verify(actual.delta === expected.delta,
    `${locale} results best comparison differs from the literal fixture.`, { actual, expected });
  verify(actual.speed.unitText === TERMINAL_COPY[locale].speedUnit
    && actual.speed.unitLang === 'en'
    && actual.speed.elementChildren === 1
    && /^\d+ $/.test(actual.speed.numberText)
    && actual.speed.text === `${actual.speed.numberText}${TERMINAL_COPY[locale].speedUnit}`,
  `${locale} results speed value does not have the exact number + lang=en unit structure.`, {
    actual,
    expectedUnit: TERMINAL_COPY[locale].speedUnit,
  });
}

async function terminalResultSnapshot(page) {
  return page.evaluate(() => {
    const result = document.querySelector('[data-view="results"][data-open="1"]');
    if (!(result instanceof HTMLElement)) throw new Error('Open results view is missing.');
    const stats = Array.from(result.querySelectorAll('.lv-res-stat'));
    const speed = stats[1]?.querySelector('.lv-res-statv');
    const hull = stats[2]?.querySelector('.lv-res-statv');
    const unit = speed?.querySelector(':scope > span');
    return {
      hull: hull?.textContent ?? '',
      delta: result.querySelector('.lv-res-delta')?.textContent ?? null,
      speed: {
        text: speed?.textContent ?? '',
        numberText: Array.from(speed?.childNodes ?? [])
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? '')
          .join(''),
        unitText: unit?.textContent ?? '',
        unitLang: unit?.getAttribute('lang') ?? null,
        elementChildren: speed?.children.length ?? -1,
      },
    };
  });
}

async function staticCopySnapshot(page, viewName) {
  return page.evaluate((requestedView) => {
    const view = requestedView === 'failure'
      ? document.querySelector('[data-view="results"][data-open="1"]')
      : document.querySelector(`[data-view="${requestedView}"][data-open="1"]`);
    if (!(view instanceof HTMLElement)) throw new Error(`Open ${requestedView} view is missing.`);
    const text = (selector) => view.querySelector(selector)?.textContent ?? '';
    const texts = (selector) => Array.from(view.querySelectorAll(selector), (node) => node.textContent ?? '');
    const actions = () => Object.fromEntries(Array.from(view.querySelectorAll('[data-action]'), (node) => [
      node.getAttribute('data-action'),
      node.querySelector('.lv-btn-t')?.textContent ?? '',
    ]));
    const aria = view.getAttribute('aria-label') ?? '';

    if (requestedView === 'title') {
      return {
        aria,
        eyebrow: text('.lv-title-eyebrow > span:first-child'),
        tagline: text('.lv-tagline'),
        actions: actions(),
        localeAria: view.querySelector('[data-nav="segmented"]')?.getAttribute('aria-label') ?? '',
        localeLabels: texts('[data-locale]'),
        footer: texts('.lv-title-foot > span'),
      };
    }
    if (requestedView === 'settings') {
      return {
        aria,
        kicker: text('.lv-kicker'),
        title: text('.lv-panel-title'),
        back: text('[data-action="return"] .lv-btn-t'),
        sections: texts('.lv-set-grouptitle'),
        rows: Array.from(view.querySelectorAll('.lv-set-row'), (row) => [
          row.querySelector('.lv-set-label')?.textContent ?? '',
          row.querySelector('.lv-set-hint')?.textContent ?? '',
        ]),
        enumLabels: Array.from(view.querySelectorAll('[data-setting][data-nav="segmented"]'), (group) =>
          Array.from(group.querySelectorAll('[data-seg]'), (node) => node.textContent ?? '')),
        switchLabels: texts('.lv-switch-t'),
      };
    }
    if (requestedView === 'controls') {
      return {
        aria,
        kicker: text('.lv-kicker'),
        title: text('.lv-panel-title'),
        back: text('[data-action="return"] .lv-btn-t'),
        or: text('.lv-key-or'),
        actions: texts('[data-control] .lv-key-d'),
        note: text('.lv-note'),
      };
    }
    if (requestedView === 'briefing') {
      return {
        aria,
        kicker: text('.lv-brief-head .lv-kicker'),
        transit: text('.lv-brief-sub'),
        statLabels: texts('.lv-stat dt'),
        lines: texts('.lv-prose-l'),
        primer: text('.lv-primer > .lv-kicker'),
        primerActions: texts('.lv-primer-list [data-control] > span:last-child'),
        actions: actions(),
      };
    }
    if (requestedView === 'countdown') {
      return { aria, number: text('.lv-count-n'), label: text('.lv-count-k') };
    }
    if (requestedView === 'pause') {
      return {
        aria,
        kicker: text('.lv-kicker'),
        title: text('.lv-pause-title'),
        detail: text('.lv-pause-sub'),
        actions: actions(),
      };
    }
    if (requestedView === 'results') {
      return {
        aria,
        kicker: text('.lv-res-headline .lv-kicker'),
        rank: text('.lv-res-rank .lv-res-k'),
        total: text('.lv-res-timeblock > .lv-res-k'),
        newBest: text('.lv-newbest span'),
        stats: texts('.lv-res-statk'),
        headers: texts('.lv-res-row.is-head > span'),
        actions: actions(),
      };
    }
    return {
      aria,
      title: text('.lv-res-title'),
      time: text('.lv-res-timeblock > .lv-res-k'),
      retry: text('[data-action="retry"] .lv-btn-t'),
    };
  }, viewName);
}

async function collectSemanticFlow(page, options) {
  const evidence = {};
  evidence.title = await semanticSnapshot(page, 'title');
  await clickAction(page, 'title', 'settings');
  evidence.settings = await semanticSnapshot(page, 'settings');
  await clickAction(page, 'settings', 'return');
  await clickAction(page, 'title', 'controls');
  evidence.controls = await semanticSnapshot(page, 'controls');
  await clickAction(page, 'controls', 'return');
  await clickAction(page, 'title', 'begin');
  evidence.briefing = await semanticSnapshot(page, 'briefing');
  await clickAction(page, 'briefing', 'engage');
  await page.waitForFunction(() => window.__LV?.phase() === 'flying');
  await page.keyboard.press('Escape');
  evidence.pause = await semanticSnapshot(page, 'pause');
  await clickAction(page, 'pause', 'resume');
  await finishAutopilot(page, options);
  evidence.results = await semanticSnapshot(page, 'results');
  await clickAction(page, 'results', 'again');
  await forceFailure(page, options);
  evidence.failure = await semanticSnapshot(page, 'results');
  return evidence;
}

async function semanticSnapshot(page, viewName) {
  const snapshot = await page.evaluate((viewKey) => {
    const view = document.querySelector(`[data-view="${viewKey}"][data-open="1"]`);
    if (!view) throw new Error(`Open ${viewKey} view is missing.`);
    const settings = Array.from(view.querySelectorAll('[data-setting]'), (node) => ({
      setting: node.getAttribute('data-setting'),
      value: node.getAttribute('data-value'),
      options: Array.from(node.querySelectorAll(':scope [data-seg]'), (option) => option.getAttribute('data-seg')),
    }));
    return {
      actions: Array.from(view.querySelectorAll('[data-action]'), (node) => node.getAttribute('data-action')),
      controls: Array.from(view.querySelectorAll('[data-control]'), (node) => node.getAttribute('data-control')),
      settings,
    };
  }, viewName);
  for (const key of ['actions', 'controls']) {
    verify(new Set(snapshot[key]).size === snapshot[key].length,
      `${viewName} contains duplicate ${key}.`, snapshot);
  }
  verify(new Set(snapshot.settings.map(({ setting }) => setting)).size === snapshot.settings.length,
    `${viewName} contains duplicate settings.`, snapshot);
  return snapshot;
}

async function collectPreservedLatin(page, options) {
  await finishAutopilot(page, options);
  return page.evaluate(() => {
    const rendered = document.querySelector('.lv-screens')?.textContent ?? '';
    const tokens = ['LAST VECTOR', 'THE CAIRN DRIFT', 'ACHRA', 'KESTREL-C7', 'VESPER TERMINUS', 'TERMINUS'];
    const accessibleTitle = document.querySelector('.lv-wordmark')?.getAttribute('aria-label') ?? '';
    return {
      properNouns: tokens.filter((token) => rendered.includes(token) || accessibleTitle === token),
      keys: Array.from(new Set(Array.from(document.querySelectorAll('.lv-key-keys kbd'),
        (node) => node.textContent ?? ''))).sort(),
      speedUnits: Array.from(document.querySelectorAll('.lv-res-statv'), (node) => node.textContent ?? '')
        .filter((value) => value.includes('M/S')).map(() => 'M/S'),
      rank: document.querySelector('.lv-res-letter')?.textContent ?? '',
    };
  });
}

async function collectEmbeddedLang(page) {
  await clickAction(page, 'title', 'settings');
  const cameraHint = await langTokens(page, '[data-view="settings"] [data-setting="cameraMode"]', '.lv-set-hint');
  await clickAction(page, 'settings', 'return');
  await clickAction(page, 'title', 'controls');
  const pointerNote = await langTokens(page, '[data-view="controls"]', '.lv-note');
  await clickAction(page, 'controls', 'return');
  const tagline = await langTokens(page, '[data-view="title"]', '.lv-tagline');
  await clickAction(page, 'title', 'begin');
  const briefingLine1 = await langTokens(page, '[data-view="briefing"]', '.lv-prose-l:nth-child(1)');
  const briefingLine2 = await langTokens(page, '[data-view="briefing"]', '.lv-prose-l:nth-child(2)');
  return { tagline, briefingLine1, briefingLine2, cameraHint, pointerNote };
}

async function safeDomSnapshot(page, phase) {
  const selectorsByPhase = {
    title: [
      '.lv-title-eyebrow > span:first-child', '.lv-title-sector', '.lv-tagline',
      '.lv-btn-t', '.lv-btn-s', '.lv-title-foot > span',
    ],
    settings: [
      '.lv-kicker', '.lv-panel-title', '.lv-set-grouptitle', '.lv-set-label',
      '.lv-set-hint', '.lv-seg-b', '.lv-switch-t', '.lv-btn-t',
    ],
    controls: [
      '.lv-kicker', '.lv-panel-title', '.lv-key-or', '.lv-key-d', '.lv-note', '.lv-btn-t',
    ],
    briefing: [
      '.lv-brief-head .lv-kicker', '.lv-brief-title', '.lv-brief-sub', '.lv-stat dt',
      '.lv-stat dd', '.lv-prose-l', '.lv-primer > .lv-kicker',
      '.lv-primer-list [data-control] > span:last-child', '.lv-btn-t',
    ],
    countdown: ['.lv-count-n', '.lv-count-k'],
    pause: ['.lv-kicker', '.lv-pause-title', '.lv-pause-sub', '.lv-btn-t'],
    results: [
      '.lv-res-headline .lv-kicker', '.lv-res-title', '.lv-res-rank .lv-res-k',
      '.lv-res-letter', '.lv-res-timeblock > .lv-res-k', '.lv-res-delta',
      '.lv-res-statk', '.lv-res-statv', '.lv-res-row.is-head > span', '.lv-res-idx',
      '.lv-res-seg', '.lv-res-cum', '.lv-res-dlt', '.lv-btn-t',
    ],
    failure: ['.lv-res-title', '.lv-res-timeblock > .lv-res-k', '.lv-btn-t'],
  };
  const selectors = selectorsByPhase[phase];
  verify(Array.isArray(selectors), `No safe-DOM selector manifest exists for ${phase}.`);
  const evidence = await page.evaluate(({ currentPhase, copySelectors }) => {
    const screens = document.querySelector('.lv-screens');
    if (!(screens instanceof HTMLElement)) throw new Error('Screens root is missing.');
    const viewName = currentPhase === 'failure' ? 'results' : currentPhase;
    const view = screens.querySelector(`[data-view="${viewName}"][data-open="1"]`);
    if (!(view instanceof HTMLElement)) throw new Error(`Open ${currentPhase} view is missing.`);
    const forbidden = Array.from(screens.querySelectorAll('script, img, iframe'), (node) => ({
      tag: node.tagName.toLowerCase(),
      location: node.parentElement === screens
        ? 'screens-direct-child'
        : node.closest('[data-view]')?.getAttribute('data-view') ?? 'screens-descendant',
      probe: node.getAttribute('data-safe-dom-probe'),
      html: node.outerHTML,
    }));
    const invalidCopyChildren = [];
    const counts = {};
    for (const selector of copySelectors) {
      const nodes = Array.from(view.querySelectorAll(selector));
      counts[selector] = nodes.length;
      for (const node of nodes) {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) continue;
          if (child instanceof HTMLSpanElement && child.lang === 'en'
            && Array.from(child.childNodes).every((nested) => nested.nodeType === Node.TEXT_NODE)) continue;
          invalidCopyChildren.push({ selector, html: node.outerHTML });
        }
      }
    }
    return {
      phase: currentPhase,
      forbidden,
      invalidCopyChildren,
      counts,
    };
  }, { currentPhase: phase, copySelectors: selectors });
  const unmatched = Object.entries(evidence.counts)
    .filter(([, count]) => count === 0)
    .map(([selector]) => selector);
  verify(unmatched.length === 0,
    `${phase} safe-DOM manifest contains selectors that matched no catalog-derived leaves.`, {
      unmatched,
      evidence,
    });
  return evidence;
}

async function langTokens(page, rootSelector, leafSelector) {
  return page.evaluate(({ rootSelector: root, leafSelector: leaf }) => {
    const owner = document.querySelector(root);
    const target = owner?.matches(leaf) ? owner : owner?.closest('.lv-set-row')?.querySelector(leaf)
      ?? owner?.querySelector(leaf);
    return Array.from(target?.querySelectorAll(':scope > span[lang="en"]') ?? [],
      (node) => node.textContent ?? '');
  }, { rootSelector, leafSelector });
}

async function collectResponsiveFlow(page, options) {
  const evidence = [];
  evidence.push(...await measureViewports(page, 'title'));
  await clickAction(page, 'title', 'settings');
  evidence.push(...await measureViewports(page, 'settings'));
  await clickAction(page, 'settings', 'return');
  await clickAction(page, 'title', 'controls');
  evidence.push(...await measureViewports(page, 'controls'));
  await clickAction(page, 'controls', 'return');
  await clickAction(page, 'title', 'begin');
  evidence.push(...await measureViewports(page, 'briefing'));
  await clickAction(page, 'briefing', 'engage');
  await page.waitForFunction(() => window.__LV?.phase() === 'flying');
  await page.keyboard.press('Escape');
  evidence.push(...await measureViewports(page, 'pause'));
  await clickAction(page, 'pause', 'resume');
  await finishAutopilot(page, options);
  evidence.push(...await measureViewports(page, 'results'));
  await clickAction(page, 'results', 'again');
  await forceFailure(page, options);
  evidence.push(...await measureViewports(page, 'failure'));
  return evidence;
}

async function measureViewports(page, viewName) {
  const measurements = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    measurements.push(await page.evaluate(({ viewport: expected, viewName: expectedView }) => {
      const domView = expectedView === 'failure' ? 'results' : expectedView;
      const view = document.querySelector(`[data-view="${domView}"][data-open="1"]`);
      const primary = view?.querySelector('.lv-btn.is-primary');
      const rect = primary?.getBoundingClientRect();
      const doc = document.documentElement;
      const inside = rect !== undefined && rect !== null
        && rect.left >= -1 && rect.top >= -1
        && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      const documentFits = doc.scrollWidth <= innerWidth + 1 && doc.scrollHeight <= innerHeight + 1;
      return {
        view: expectedView,
        viewport: expected,
        actualView: view?.getAttribute('data-view') ?? null,
        action: primary?.getAttribute('data-action') ?? null,
        rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        document: { scrollWidth: doc.scrollWidth, scrollHeight: doc.scrollHeight, innerWidth, innerHeight },
        pass: view?.getAttribute('data-view') === domView
          && inside && documentFits,
      };
    }, { viewport, viewName }));
  }
  return measurements;
}

async function measurePrimerCamera(page, viewport) {
  return page.evaluate((expectedViewport) => {
    const row = document.querySelector('[data-view="briefing"][data-open="1"] [data-control="camera-toggle"]');
    const clip = row?.closest('.lv-brief-cols');
    const boxes = Array.from(row?.children ?? [], (node) => node.getBoundingClientRect());
    const rowRect = boxes.length > 0 ? {
      left: Math.min(...boxes.map((box) => box.left)),
      top: Math.min(...boxes.map((box) => box.top)),
      right: Math.max(...boxes.map((box) => box.right)),
      bottom: Math.max(...boxes.map((box) => box.bottom)),
    } : null;
    const clipRect = clip?.getBoundingClientRect();
    const viewportPass = rowRect !== null && rowRect.left >= -1 && rowRect.top >= -1
      && rowRect.right <= innerWidth + 1 && rowRect.bottom <= innerHeight + 1;
    const clipPass = rowRect !== null && clipRect !== undefined
      && rowRect.left >= clipRect.left - 1 && rowRect.top >= clipRect.top - 1
      && rowRect.right <= clipRect.right + 1 && rowRect.bottom <= clipRect.bottom + 1;
    return {
      viewport: expectedViewport,
      row: rowRect,
      clip: clipRect ? {
        left: clipRect.left, top: clipRect.top, right: clipRect.right, bottom: clipRect.bottom,
        scrollTop: clip.scrollTop,
      } : null,
      viewportPass,
      clipPass,
      pass: viewportPass && clipPass && clip?.scrollTop === 0,
    };
  }, viewport);
}

async function measureOverflow(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll(
    '[data-view="results"][data-open="1"] .lv-res-row.is-head > span, '
    + '[data-view="results"][data-open="1"] .lv-res-delta, '
    + '[data-view="results"][data-open="1"] .lv-res-k, '
    + '[data-view="results"][data-open="1"] .lv-res-statk, '
    + '[data-view="results"][data-open="1"] .lv-btn-t',
  ), (node) => ({
    kind: node.matches('.lv-res-row.is-head > span:last-child') ? 'comparison-header' : 'fixed-leaf',
    className: node.className,
    text: node.textContent ?? '',
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    pass: node.scrollWidth <= node.clientWidth + 1,
  })));
}

async function collectLocaleReplacementFocus(session, options) {
  const paths = [
    { name: 'arrow', locale: 'ko', key: 'ArrowRight', expected: 'en', direct: false },
    { name: 'enter', locale: 'en', key: 'Enter', expected: 'ko', direct: false },
    { name: 'direct-radio', locale: 'ko', expected: 'en', direct: true },
  ];
  const evidence = [];
  for (const path of paths) {
    const scenario = await openLocaleScenario(session, path.locale);
    try {
      await ready(scenario.page, options.timeoutMs);
      await focusLocale(scenario.page);
      if (path.direct) {
        await scenario.page.locator(`[data-locale="${path.expected}"]`).evaluate((node) => {
          node.focus();
          node.click();
        });
      } else {
        await scenario.page.keyboard.press(path.key);
      }
      await waitForSelected(scenario.page, path.expected);
      const focus = await semanticFocus(scenario.page);
      evidence.push({
        path: path.name,
        expected: path.expected,
        focus,
        pass: focus.view === 'title' && focus.nav === 'segmented'
          && (path.direct ? focus.locale === path.expected : focus.locale === null),
      });
    } finally {
      await scenario.close();
    }
  }
  return evidence;
}

async function collectFocusFlow(page, options) {
  const evidence = {};
  evidence.title = await collectViewFocus(page, 'title');
  await clickAction(page, 'title', 'settings');
  evidence.settings = await collectViewFocus(page, 'settings');
  await clickAction(page, 'settings', 'return');
  await clickAction(page, 'title', 'controls');
  evidence.controls = await collectViewFocus(page, 'controls');
  await clickAction(page, 'controls', 'return');
  await clickAction(page, 'title', 'begin');
  evidence.briefing = await collectViewFocus(page, 'briefing');
  await clickAction(page, 'briefing', 'engage');
  await page.waitForFunction(() => window.__LV?.phase() === 'flying');
  await page.keyboard.press('Escape');
  evidence.pause = await collectViewFocus(page, 'pause');
  await clickAction(page, 'pause', 'resume');
  await finishAutopilot(page, options);
  evidence.results = await collectViewFocus(page, 'results');
  await clickAction(page, 'results', 'again');
  await forceFailure(page, options);
  evidence.failure = await collectViewFocus(page, 'failure');
  return evidence;
}

async function collectViewFocus(page, viewName) {
  const expected = EXPECTED_NAV_ORDER[viewName];
  verify(Array.isArray(expected), `No literal navigation manifest exists for ${viewName}.`);
  const domView = viewName === 'failure' ? 'results' : viewName;
  const domOrder = await page.evaluate((expectedView) => {
    const view = document.querySelector(`[data-view="${expectedView}"][data-open="1"]`);
    if (!(view instanceof HTMLElement)) throw new Error(`Open ${expectedView} view is missing.`);
    return Array.from(view.querySelectorAll('[data-nav]'), (node) => {
      const action = node.getAttribute('data-action');
      if (action !== null) return `action:${action}`;
      const setting = node.getAttribute('data-setting');
      if (setting !== null) return `setting:${setting}`;
      return `nav:${node.getAttribute('data-nav')}`;
    });
  }, domView);
  verify(new Set(domOrder).size === domOrder.length,
    `${viewName} DOM navigation tokens are not unique.`, { expected, domOrder });
  verify(JSON.stringify(domOrder) === JSON.stringify(expected),
    `${viewName} DOM navigation order differs from the independent literal manifest.`, {
      expected,
      domOrder,
    });

  const first = focusToken(await semanticFocus(page));
  verify(first === expected[0], `${viewName} did not focus the first literal navigation token.`, {
    expected,
    first,
  });
  const forward = [first];
  const transitions = [];
  for (let i = 1; i < expected.length; i++) {
    const fromRange = await activeElementIsRange(page);
    const key = fromRange ? 'Tab' : 's';
    const from = forward.at(-1);
    await page.keyboard.press(key);
    const to = focusToken(await semanticFocus(page));
    transitions.push({ direction: 'forward', from, to, key, fromRange });
    forward.push(to);
  }
  verify(JSON.stringify(forward) === JSON.stringify(expected),
    `${viewName} forward focus traversal differs from the literal navigation manifest.`, {
      expected,
      forward,
      transitions,
    });

  const backward = [forward.at(-1)];
  const reversed = [...expected].reverse();
  for (let i = 1; i < reversed.length; i++) {
    const fromRange = await activeElementIsRange(page);
    const key = fromRange ? 'Shift+Tab' : 'w';
    const from = backward.at(-1);
    await page.keyboard.press(key);
    const to = focusToken(await semanticFocus(page));
    transitions.push({ direction: 'backward', from, to, key, fromRange });
    backward.push(to);
  }
  verify(JSON.stringify(backward) === JSON.stringify(reversed),
    `${viewName} backward focus traversal differs from the reversed literal navigation manifest.`, {
      expected: reversed,
      backward,
      transitions,
    });
  return { first, domOrder, forward, backward, transitions };
}

function focusToken(focus) {
  if (focus.action !== null) return `action:${focus.action}`;
  if (focus.setting !== null) return `setting:${focus.setting}`;
  return `nav:${focus.nav}`;
}

async function activeElementIsRange(page) {
  return page.evaluate(() => document.activeElement instanceof HTMLInputElement
    && document.activeElement.type === 'range');
}

async function semanticFocus(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const nav = active?.closest('[data-nav]');
    return {
      view: active?.closest('[data-view]')?.getAttribute('data-view') ?? null,
      action: active?.getAttribute('data-action') ?? null,
      nav: nav?.getAttribute('data-nav') ?? null,
      setting: active?.getAttribute('data-setting') ?? null,
      locale: active?.getAttribute('data-locale') ?? null,
    };
  });
}

async function localeVisibility(page, phase = 'title') {
  return page.evaluate((expectedPhase) => ({
    phase: expectedPhase,
    selected: document.querySelectorAll('[data-view="title"] [data-locale][aria-checked="true"]').length,
    activeControls: document.querySelectorAll('[data-view][data-open="1"] [data-locale]').length,
  }), phase);
}

async function finishAutopilot(page, options, run = {}) {
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  if (run.collision === true) {
    const before = await callHarness(page, 'telemetry');
    const staged = await callHarness(page, 'stageCollision');
    verify(staged !== null, 'Could not stage a genuine collision for the damaged results fixture.', {
      before,
      staged,
    });
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const after = await callHarness(page, 'telemetry');
    verify(after.hull < before.hull,
      'The staged collision did not apply real flight damage before the results run.', {
        before,
        after,
        staged,
      });
  }
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
  const maxFrames = Math.ceil((options.maxSimSeconds ?? 300) * 60);
  let frames = 0;
  try {
    while (frames < maxFrames) {
      const phase = await callHarness(page, 'phase');
      if (phase === 'finished') break;
      verify(phase !== 'failed', 'Autopilot failed before reaching the results screen.', { phase, frames });
      const telemetry = await callHarness(page, 'telemetry');
      const allGatesCleared = Number.isInteger(telemetry?.gate?.total)
        && telemetry.gate.index >= telemetry.gate.total;
      const chunk = Math.min(allGatesCleared ? 1 : 240, maxFrames - frames);
      await callHarness(page, 'step', [chunk], options.timeoutMs);
      frames += chunk;
    }
    const phase = await callHarness(page, 'phase');
    verify(phase === 'finished', 'Autopilot did not reach the results screen.', { phase, frames, maxFrames });
    await page.locator('[data-view="results"][data-open="1"]').waitFor({ state: 'visible' });
    return { frames, result: await callHarness(page, 'result') };
  } finally {
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setDriven', [false]);
  }
}

async function forceFailure(page, options) {
  await callHarness(page, 'setDriven', [true]);
  try {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'damageHull', [2]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await page.waitForFunction(() => window.__LV?.phase() === 'failed');
    await page.locator('[data-view="results"][data-open="1"]').waitFor({ state: 'visible' });
  } finally {
    await callHarness(page, 'setDriven', [false]);
  }
}

async function ready(page, timeoutMs) {
  verify(await waitForHarness(page, timeoutMs), 'Harness did not appear during isolated boot.');
  await callHarness(page, 'ready', [], timeoutMs);
}

async function localeSnapshot(page) {
  const state = await callHarness(page, 'locale');
  const documentLang = await page.evaluate(() => document.documentElement.lang);
  const evidence = { ...state, documentLang };
  verify((state?.active === null || state?.active === 'ko' || state?.active === 'en')
    && (state?.selected === 'ko' || state?.selected === 'en')
    && typeof state?.locked === 'boolean'
    && Number.isInteger(state?.settingsSubscribers),
  'locale() returned an invalid state shape.', evidence);
  verify(state.locked === (state.active !== null),
    'Locale invariant failed: locked must equal (active !== null).', evidence);
  return evidence;
}

async function titleLocaleEvidence(page) {
  return page.evaluate(() => {
    const title = document.querySelector('[data-view="title"][data-open="1"]');
    const group = title?.querySelector('[data-nav="segmented"]');
    return {
      titleVisible: title instanceof HTMLElement && title.getClientRects().length > 0,
      value: group instanceof HTMLElement ? group.dataset.value ?? null : null,
      checked: group
        ? Array.from(group.querySelectorAll('[data-locale][aria-checked="true"]'))
          .map((node) => node.getAttribute('data-locale'))
        : [],
    };
  });
}

async function metadataEvidence(page) {
  return page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
  }));
}

async function directLocaleFocus(page) {
  return page.evaluate(() => ({
    locale: document.activeElement?.getAttribute('data-locale') ?? null,
    checked: document.activeElement?.getAttribute('aria-checked') ?? null,
    view: document.activeElement?.closest('[data-view]')?.getAttribute('data-view') ?? null,
  }));
}

async function focusLocale(page) {
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-nav') === 'segmented'
    && document.activeElement?.closest('[data-view]')?.getAttribute('data-view') === 'title');
  if (focused) return;
  const beginFocused = await page.evaluate(() => document.activeElement?.getAttribute('data-action') === 'begin');
  if (beginFocused) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
  } else {
    await page.locator('[data-view="title"][data-open="1"] [data-action="begin"]').focus();
    await page.keyboard.press('ArrowUp');
  }
  await assertLocaleFocus(page);
}

async function assertLocaleFocus(page) {
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      view: active?.closest('[data-view]')?.getAttribute('data-view') ?? null,
      nav: active?.getAttribute('data-nav') ?? null,
      value: active instanceof HTMLElement ? active.dataset.value ?? null : null,
    };
  });
  verify(focus.view === 'title' && focus.nav === 'segmented',
    'Keyboard focus did not remain on the title locale radiogroup.', focus);
  return focus;
}

async function waitForSelected(page, locale) {
  await page.waitForFunction((expected) => window.__LV?.locale?.().selected === expected, locale);
}

function installBootProbe() {
  window.__LV_BOOT_PROBE = [];
  const seen = new Set();
  const inspect = (node) => {
    if (!(node instanceof Element)) return;
    for (const [kind, selector] of [['loader', '.lv-loader'], ['overlay', '.lv-root']]) {
      const target = node.matches(selector) ? node : node.querySelector(selector);
      if (!target || seen.has(kind)) continue;
      seen.add(kind);
      window.__LV_BOOT_PROBE.push({
        kind,
        lang: document.documentElement?.lang ?? '',
        text: target.textContent ?? '',
      });
    }
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) inspect(node);
  }).observe(document, { childList: true, subtree: true });
}

function installListenerCensus() {
  const NativeResizeObserver = window.ResizeObserver;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const records = [];
  const resize = { constructed: 0, disconnected: 0, entries: [] };
  const captureOf = (options) => typeof options === 'boolean' ? options : options?.capture === true;

  EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    const capture = captureOf(options);
    if (listener !== null && !records.some((record) => record.active
      && record.target === this && record.type === type && record.listener === listener
      && record.capture === capture)) {
      records.push({ target: this, type, listener, capture, active: true });
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
    const capture = captureOf(options);
    const record = records.find((candidate) => candidate.active
      && candidate.target === this && candidate.type === type && candidate.listener === listener
      && candidate.capture === capture);
    if (record) record.active = false;
    return nativeRemove.call(this, type, listener, options);
  };

  if (typeof NativeResizeObserver === 'function') {
    window.ResizeObserver = class CensusResizeObserver extends NativeResizeObserver {
      constructor(callback) {
        super(callback);
        resize.constructed += 1;
        resize.entries.push({ observer: this, active: true });
      }

      disconnect() {
        const entry = resize.entries.find((candidate) => candidate.observer === this && candidate.active);
        if (entry) {
          entry.active = false;
          resize.disconnected += 1;
        }
        return super.disconnect();
      }
    };
  }

  const targetName = (target) => {
    if (target === window) return 'window';
    if (target === document) return 'document';
    if (!(target instanceof Element)) return target.constructor?.name ?? 'EventTarget';
    const view = target.closest('[data-view]')?.getAttribute('data-view');
    const setting = target.getAttribute('data-setting')
      ?? target.closest('[data-setting]')?.getAttribute('data-setting');
    const semantic = [
      ['view', view],
      ['action', target.getAttribute('data-action')],
      ['nav', target.getAttribute('data-nav')],
      ['locale', target.getAttribute('data-locale')],
      ['seg', target.getAttribute('data-seg')],
      ['setting', setting],
      ['control', target.getAttribute('data-control')],
    ].filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join('|');
    return `${target.tagName.toLowerCase()}${semantic ? `|${semantic}` : ''}`;
  };

  window.__LV_LISTENER_CENSUS = {
    snapshot() {
      const populations = new Map();
      for (const record of records) {
        if (!record.active) continue;
        if (record.target instanceof Node && !record.target.isConnected) continue;
        const key = `${targetName(record.target)}::${record.type}::${record.capture ? 'capture' : 'bubble'}`;
        populations.set(key, (populations.get(key) ?? 0) + 1);
      }
      return {
        listeners: Array.from(populations, ([key, count]) => ({ key, count }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        resize: {
          constructed: resize.constructed,
          disconnected: resize.disconnected,
          active: resize.entries.filter((entry) => entry.active).length,
        },
      };
    },
  };
}
