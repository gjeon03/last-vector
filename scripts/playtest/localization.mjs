#!/usr/bin/env node

import {
  callHarness,
  inspectHarness,
  openBootScenario,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';
import { decodePng } from './pngstats.mjs';

const LOCALE_STORAGE_KEY = 'last-vector.locale.v1';
const HANGUL_FONT_ALIAS = 'NanumSquare Neo Hangul';
const HANGUL_FONT_FILES = [
  'NanumSquareNeo-Light.woff2',
  'NanumSquareNeo-Regular.woff2',
  'NanumSquareNeo-Bold.woff2',
];
const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'phase',
  'telemetry',
  'result',
  'damageHull',
  'cameraMode',
  'cockpitDebug',
  'cockpitMfd',
  'setAutopilot',
  'setDriven',
  'setInput',
  'setPaused',
  'setSettings',
  'step',
  'present',
  'pose',
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
      aria: '주 메뉴', eyebrow: 'SECTOR',
      tagline: 'CAIRN 항로를 꿰뚫고, 드리프트가 닫히기 전에 TERMINUS에 도달하라.',
      actions: { begin: 'START FLIGHT', settings: 'SETTINGS', controls: 'CONTROLS' },
      localeAria: '언어 선택',
      localeLabels: ['한국어', 'English'],
      footer: ['HULL KESTREL-C7', 'PRIMARY ACHRA', 'NAV LOCK NOMINAL'],
    },
    settings: {
      aria: '설정', kicker: 'CONFIGURATION', title: 'SETTINGS', back: 'BACK',
      sections: ['FLIGHT', 'DISPLAY', 'IMAGE', 'AUDIO'],
      rows: [
        ['Flight assist', '항전 장치가 입력을 얼마나 감쇠할지 정합니다.'],
        ['Default camera', '비행 중 C를 눌러 시점을 전환합니다.'],
        ['Mouse sensitivity', ''], ['Invert pitch', ''],
        ['Field of view', '넓을수록 빠르게 읽고, 좁을수록 멀리 봅니다.'],
        ['Camera shake', ''], ['Quality', ''],
        ['Render scale', '내부 해상도입니다. 품질보다 먼저 낮추세요.'],
        ['Frame counter', ''], ['Motion blur', ''], ['Film grain', ''],
        ['Chromatic aberration', ''], ['Master', ''], ['Score', ''],
      ],
      enumLabels: [
        ['ARCADE', 'STANDARD', 'RAW'], ['CHASE', 'COCKPIT'], ['LOW', 'MED', 'HIGH', 'ULTRA'],
      ],
      switchLabels: ['OFF', 'OFF', 'ON', 'ON', 'ON'],
    },
    controls: {
      aria: '조작법', kicker: 'PILOT REFERENCE', title: 'CONTROLS', back: 'BACK', or: '또는',
      actions: [
        '조향 — 자동 복귀 가상 스틱', '스로틀 올림 / 내림', '좌 / 우 롤', '부스터',
        '제동 및 드리프트', '좌 / 우 평행 이동', '상 / 하 평행 이동',
        '마우스 없이 피치 / 요', '추적 / 1인칭 조종석 전환', '일시정지', '비행 재시작',
      ],
      note: '출격하면 마우스가 고정됩니다. ESC를 누르면 마우스가 풀리고 비행이 일시정지됩니다.',
    },
    briefing: {
      aria: '비행 브리핑', kicker: 'RUN BRIEFING', transit: 'TRANSIT TO VESPER TERMINUS',
      statLabels: ['MARKERS', 'CORRIDOR', 'PRIMARY', 'HULL', 'DRIFT'],
      lines: [
        'ACHRA가 꺼져 가고 있다. 매시간 선반 얼음과 회전하는 철편이 마지막 생존 항로로 쏟아진다.',
        '응답하는 CAIRN은 아홉 기. 오래전에 사라진 손들이 남긴 표식이 곧 항로다.',
        '순서대로 통과하라. 좁은 구간에서는 암석이 바짝 파고들며, 제동만이 선회 공간을 만든다.',
      ],
      primer: 'CORE CONTROLS',
      primerActions: ['조향', '스로틀 올림 / 내림', '좌 / 우 롤', '부스터', '제동 및 드리프트', '마우스 없이 조향', '1인칭 조종석 전환'],
      actions: { engage: 'ENGAGE', return: 'BACK' },
    },
    countdown: { aria: '출격 초읽기', launch: 'LAUNCH SEQUENCE', go: 'GO', live: 'VECTOR LIVE' },
    pause: {
      aria: '일시정지', kicker: 'FLIGHT HELD', title: 'PAUSED',
      detail: '드리프트는 계속된다. 항로는 기다려 주지 않는다.',
      actions: { resume: 'RESUME', restart: 'RESTART', settings: 'SETTINGS', controls: 'CONTROLS', abort: 'ABORT FLIGHT' },
    },
    results: {
      aria: '비행 종료', kicker: 'ARRIVAL CONFIRMED', rank: 'RATING', total: 'TOTAL', newBest: 'NEW BEST',
      stats: ['MARKERS', 'TOP SPEED', 'HULL', 'MAX OFFSET'], headers: ['MARKER', 'SPLIT', '', 'ELAPSED'],
      actions: { again: 'RUN AGAIN', return: 'RETURN' },
    },
    failure: { aria: '선체 파손', title: 'HULL BREACH', time: 'TIME', retry: 'RETRY', return: 'RETURN' },
  },
  en: {
    title: {
      aria: 'Main menu', eyebrow: 'SECTOR',
      tagline: 'Thread the cairns. Make the terminus before the drift closes.',
      actions: { begin: 'START FLIGHT', settings: 'SETTINGS', controls: 'CONTROLS' },
      localeAria: 'Language', localeLabels: ['한국어', 'English'],
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
      actions: { resume: 'RESUME', restart: 'RESTART', settings: 'SETTINGS', controls: 'CONTROLS', abort: 'ABORT FLIGHT' },
    },
    results: {
      aria: 'Run complete', kicker: 'ARRIVAL CONFIRMED', rank: 'RATING', total: 'TOTAL', newBest: 'NEW BEST',
      stats: ['MARKERS', 'TOP SPEED', 'HULL', 'MAX OFFSET'], headers: ['MARKER', 'SEGMENT', '', 'ELAPSED'],
      actions: { again: 'RUN AGAIN', return: 'RETURN' },
    },
    failure: { aria: 'Hull breach', title: 'HULL BREACH', time: 'TIME', retry: 'RETRY', return: 'RETURN' },
  },
};
const TERMINAL_COPY = {
  ko: {
    clean: 'UNTOUCHED',
    damaged: 'SCARRED',
    speedUnit: 'M/S',
    bestComparison: '+188.05 vs BEST 00:01.00',
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
    actions: ['retry', 'return'],
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
  failure: ['action:retry', 'action:return'],
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
const HUD_COPY = {
  ko: {
    inputMode: 'KEYBOARD FLIGHT',
    labels: ['THR', 'BOOST', 'HULL', 'SPLIT', 'ELAPSED', 'BEST', 'NEXT MARKER', 'DEPARTURE'],
    meterLabels: { throttle: 'THR', hull: 'HULL' },
    capacityTitle: '완전 충전 시 사용 가능한 추진 시간',
    usableAria: '부스터 3.2초 사용 가능',
    lockedCaption: 'LOCK',
    lockedAria: '부스터 잠김 · 45%까지 충전 중',
  },
  en: {
    inputMode: 'KEYBOARD FLIGHT',
    labels: ['THR', 'BOOST', 'HULL', 'SPLIT', 'ELAPSED', 'BEST', 'NEXT MARKER', 'DEPARTURE'],
    meterLabels: { throttle: 'THR', hull: 'HULL' },
    capacityTitle: 'Usable drive time from a full reserve',
    usableAria: 'Boost reserve, 3.2 seconds usable',
    lockedCaption: 'LOCK',
    lockedAria: 'Boost reserve locked; recharging to 45 percent',
  },
};
const EVENT_COPY = {
  ko: {
    engage: ['ENGAGE', 'VESPER TERMINUS'],
    camera: {
      cockpit: ['COCKPIT VIEW', '조종석 카메라 활성'],
      chase: ['CHASE VIEW', '외부 카메라 활성'],
    },
    pointer: ['MOUSE CAPTURE UNAVAILABLE', 'W A S D / 방향키로 비행 가능'],
    boost: ['DRIVE DRY', '예비 동력 충전 중'],
    hullTitle: 'HULL IMPACT',
    accuracies: { 'dead-centre': 'DEAD CENTRE', clean: 'CLEAN', cleared: 'CLEARED' },
    progress: { 2: '2 CAIRNS REMAINING', 1: '1 CAIRN REMAINING', 0: 'TERMINUS AHEAD' },
    missed: ['MISSED', '재정렬 후 다시 진입'],
  },
  en: {
    engage: ['ENGAGE', 'VESPER TERMINUS'],
    camera: {
      cockpit: ['COCKPIT VIEW', 'PILOT CAMERA ACTIVE'],
      chase: ['CHASE VIEW', 'EXTERIOR CAMERA ACTIVE'],
    },
    pointer: ['MOUSE CAPTURE UNAVAILABLE', 'W A S D / ARROWS STILL FLY'],
    boost: ['DRIVE DRY', 'RESERVE RECHARGING'],
    hullTitle: 'HULL IMPACT',
    accuracies: { 'dead-centre': 'DEAD CENTRE', clean: 'CLEAN', cleared: 'CLEARED' },
    progress: { 2: '2 CAIRNS REMAINING', 1: '1 CAIRN REMAINING', 0: 'TERMINUS AHEAD' },
    missed: ['MISSED', 'REALIGN AND RE-ENTER'],
  },
};
const RADIO_COPY = {
  ko: [
    ['DRIFT CONTROL', 'Kestrel, CAIRN 항로 진입을 허가한다. 행운을 빈다.'],
    ['DRIFT CONTROL', '선반 밀도가 높아진다. 좌현을 주의하라.'],
    ['VESPER TERMINUS', '트랜스폰더를 확인했다. 항로를 유지하라.'],
    ['VESPER TERMINUS', '갈 길이 멀다, Kestrel. 태워 버려라.'],
    ['VESPER TERMINUS', '접근등 점등. 무사히 들어와라.'],
  ],
  en: [
    ['DRIFT CONTROL', 'Kestrel, you are clear on the cairn line. Good hunting.'],
    ['DRIFT CONTROL', 'Shelf density climbing. Watch your left.'],
    ['VESPER TERMINUS', 'We have your transponder. Hold the line.'],
    ['VESPER TERMINUS', 'Long run ahead, Kestrel. Burn it.'],
    ['VESPER TERMINUS', 'Approach lit. Bring her in.'],
  ],
};
const RADIO_EN_TOKENS = [
  ['Kestrel', 'CAIRN'],
  [],
  [],
  ['Kestrel'],
  [],
];
const HOSTILE_REASON = '<img src=x onerror=window.__LV_INJECTED=1>';
const STAGED_FULL_SEVERITY_HULL_DAMAGE = 0.22;
const MFD_CANVAS = { width: 1024, height: 256 };
const MFD_LABEL_ROI = { x: 16, y: 16, width: 992, height: 32 };
const MFD_SCREEN_SETTLE_EPSILON = 1e-3;
// Equivalent English avionics can differ by one output code across independent WebGL captures.
// Korean mode now intentionally uses the same English/mono cockpit layer, so both ready and
// failed-font Korean cases must stay inside this renderer envelope.
const MFD_FALLBACK_MAX_CHANNEL_DELTA = 1;
const MFD_FALLBACK_MAX_CHANGED_FRACTION = 0.01;
const MFD_LABELS = {
  en: [
    'ATTITUDE', 'VECTOR / RANGE', 'SHIP SYSTEMS', 'ENG', 'HULL', 'THR',
    'RETRO BRAKE', 'HULL WARN', 'PROX WARN',
  ],
  ko: [
    'ATTITUDE', 'VECTOR / RANGE', 'SHIP SYSTEMS', 'ENG', 'HULL', 'THR',
    'RETRO BRAKE', 'HULL WARN', 'PROX WARN',
  ],
};
const LEGACY_FALLBACK = {
  title: 'CAIRN ALERT',
  sub: 'return to VESPER TERMINUS',
  log: 'legacy log · return to VESPER TERMINUS',
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
      + 'the exact 1.8.0 locale/MFD/campaign contract with required fontStatus, and remains unlocked on the title screen.',
  }, async () => {
    const scenario = await openBootScenario(session, { initScripts: [installBootProbe] });
    try {
      await ready(scenario.page, options.timeoutMs);
      const inspection = await inspectHarness(scenario.page, REQUIRED_METHODS);
      const locale = await localeSnapshot(scenario.page);
      const boot = await scenario.page.evaluate(() => window.__LV_BOOT_PROBE ?? []);
      const title = await titleLocaleEvidence(scenario.page);
      const evidence = { inspection, locale, boot, title, requests: scenario.requests };
      verify(inspection.version === '1.8.0', 'Harness version is not exactly 1.8.0.', evidence);
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
    id: 'I18N.font-network',
    name: 'Korean fonts load locally while English boots request none',
    assertion:
      'Pre-document observation proves English calls FontFaceSet.load zero times and requests no '
      + 'NanumSquareNeo WOFF2 URL, while Korean makes exactly the declared calls and HTTP-200 requests.',
  }, async () => {
    const englishScenario = await openBootScenario(session, {
      localStorageSeed: { [LOCALE_STORAGE_KEY]: 'en' },
      initScripts: [installBootProbe, installFontLoadObserver],
    });
    let english;
    try {
      await ready(englishScenario.page, options.timeoutMs);
      english = {
        locale: await localeSnapshot(englishScenario.page),
        boot: await englishScenario.page.evaluate(() => window.__LV_BOOT_PROBE ?? []),
        overlay: await overlayFontEvidence(englishScenario.page),
        fontLoadCalls: await fontLoadCalls(englishScenario.page),
        requests: englishScenario.requests.filter(({ url }) => isNanumFontUrl(url)),
        responses: englishScenario.responses.filter(({ url }) => isNanumFontUrl(url)),
        consoleErrors: englishScenario.consoleErrors,
        pageErrors: englishScenario.pageErrors,
      };
    } finally {
      await englishScenario.close();
    }

    const koreanScenario = await openBootScenario(session, {
      initScripts: [installBootProbe, installFontLoadObserver],
    });
    let korean;
    try {
      await ready(koreanScenario.page, options.timeoutMs);
      const origin = new URL(session.target.url).origin;
      const resources = await koreanScenario.page.evaluate(() => performance.getEntriesByType('resource')
        .filter(({ name }) => /NanumSquareNeo-(Light|Regular|Bold)\.woff2(?:$|[?#])/u.test(name))
        .map((entry) => ({
          url: entry.name,
          initiatorType: entry.initiatorType,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          responseStatus: 'responseStatus' in entry ? entry.responseStatus : null,
        })));
      korean = {
        origin,
        locale: await localeSnapshot(koreanScenario.page),
        boot: await koreanScenario.page.evaluate(() => window.__LV_BOOT_PROBE ?? []),
        overlay: await overlayFontEvidence(koreanScenario.page),
        fontLoadCalls: await fontLoadCalls(koreanScenario.page),
        requests: koreanScenario.requests.filter(({ resourceType, url }) =>
          resourceType === 'font' || /\.woff2(?:$|[?#])/u.test(url)),
        responses: koreanScenario.responses.filter(({ resourceType, url }) =>
          resourceType === 'font' || /\.woff2(?:$|[?#])/u.test(url)),
        resources,
        consoleErrors: koreanScenario.consoleErrors,
        pageErrors: koreanScenario.pageErrors,
      };
    } finally {
      await koreanScenario.close();
    }

    const expectedPaths = HANGUL_FONT_FILES.map((name) => `/fonts/${name}`).sort();
    const actualRequestPaths = korean.requests.map(({ url }) => new URL(url).pathname).sort();
    const actualResponsePaths = korean.responses.map(({ url }) => new URL(url).pathname).sort();
    const expectedFontLoadCalls = [300, 400, 700].map((weight) => ({
      font: `${weight} 1em \"${HANGUL_FONT_ALIAS}\"`,
      text: '가힣',
      argumentCount: 2,
    }));
    const evidence = {
      english,
      korean,
      expectedPaths,
      actualRequestPaths,
      actualResponsePaths,
      expectedFontLoadCalls,
    };
    verify(english.locale.fontStatus === 'not-required' && english.requests.length === 0
      && english.responses.length === 0 && english.fontLoadCalls.length === 0,
    'Persisted English boot requested a Nanum font or called FontFaceSet.load.', evidence);
    verify(!fontEvidenceContainsAlias(english.boot, english.overlay),
      'Persisted English computed stacks contain the Korean font alias.', evidence);
    verify(korean.locale.fontStatus === 'ready',
      'Fresh Korean boot did not settle all declared font weights as ready.', evidence);
    verify(JSON.stringify(korean.fontLoadCalls) === JSON.stringify(expectedFontLoadCalls),
      'Fresh Korean boot did not make exactly the declared three explicit Hangul load calls.', evidence);
    verify(JSON.stringify(actualRequestPaths) === JSON.stringify(expectedPaths)
      && korean.requests.every(({ resourceType, url }) => resourceType === 'font'
        && new URL(url).origin === korean.origin),
    'Fresh Korean boot did not request exactly the three same-origin declared font files.', evidence);
    verify(JSON.stringify(actualResponsePaths) === JSON.stringify(expectedPaths)
      && korean.responses.every(({ status, resourceType, url }) => status === 200
        && resourceType === 'font' && new URL(url).origin === korean.origin),
    'A Korean font did not receive an isolated same-origin HTTP 200 font response.', evidence);
    verify(korean.resources.length === HANGUL_FONT_FILES.length
      && korean.resources.every(({ url, transferSize, encodedBodySize, decodedBodySize, responseStatus }) =>
        new URL(url).origin === korean.origin
        && (responseStatus === null || responseStatus === 200)
        && (transferSize > 0 || encodedBodySize > 0 || decodedBodySize > 0)),
    'Korean Resource Timing lacks non-empty transfer/resource evidence for a declared font.', evidence);
    verify(korean.boot.some(({ kind, fontFamily, bodyFontFamily }) => kind === 'loader'
      && fontFamily.includes(HANGUL_FONT_ALIAS) && bodyFontFamily.includes(HANGUL_FONT_ALIAS))
      && korean.overlay.display.includes(HANGUL_FONT_ALIAS)
      && korean.overlay.mono.includes(HANGUL_FONT_ALIAS),
    'Korean loader/body or either Overlay token omits the Hangul alias.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.font-lifecycle',
    name: 'Font preparation is bounded, late-safe, and generation-safe',
    assertion:
      'Pre-document FontFaceSet instrumentation proves fallback then controlled late ready or failed, '
      + 'stale en-ko-en rejection, and same-locale title return without duplicate loads or regression.',
  }, async () => {
    const delayedScenario = await openBootScenario(session, {
      initScripts: [installHeldFontLoads],
    });
    let delayed;
    try {
      await ready(delayedScenario.page, options.timeoutMs);
      const fallback = await localeSnapshot(delayedScenario.page);
      const held = await fontControlSnapshot(delayedScenario.page);
      verify(fallback.fontStatus === 'fallback' && held.calls.length === 3,
        'Held Korean boot did not reach bounded fallback with one three-weight preparation.', {
          fallback,
          held,
        });
      await releaseHeldFonts(delayedScenario.page);
      await delayedScenario.page.waitForFunction(() => window.__LV?.locale().fontStatus === 'ready',
        undefined, { timeout: 10_000 });
      const lateReady = await localeSnapshot(delayedScenario.page);
      const released = await fontControlSnapshot(delayedScenario.page);
      const beforeTitleReturnCalls = released.calls.length;
      await clickAction(delayedScenario.page, 'title', 'begin');
      await clickAction(delayedScenario.page, 'briefing', 'return');
      await delayedScenario.page.waitForFunction(() => window.__LV?.phase() === 'title');
      const afterTitleReturn = await localeSnapshot(delayedScenario.page);
      const afterTitleReturnControl = await fontControlSnapshot(delayedScenario.page);
      const errors = await callHarness(delayedScenario.page, 'errors');
      delayed = {
        fallback,
        held,
        lateReady,
        released,
        beforeTitleReturnCalls,
        afterTitleReturn,
        afterTitleReturnControl,
        errors,
        consoleErrors: delayedScenario.consoleErrors,
        pageErrors: delayedScenario.pageErrors,
      };
    } finally {
      await delayedScenario.close();
    }

    const lateFailureScenario = await openBootScenario(session, {
      initScripts: [installHeldFontLoads],
    });
    let lateFailure;
    try {
      await ready(lateFailureScenario.page, options.timeoutMs);
      const fallback = await localeSnapshot(lateFailureScenario.page);
      const held = await fontControlSnapshot(lateFailureScenario.page);
      verify(fallback.fontStatus === 'fallback' && held.calls.length === 3,
        'Held Korean boot did not reach fallback before controlled late rejection.', {
          fallback,
          held,
        });
      await rejectHeldFonts(lateFailureScenario.page, 'controlled late Korean font rejection');
      await lateFailureScenario.page.waitForFunction(
        () => window.__LV?.locale().fontStatus === 'failed',
        undefined,
        { timeout: 10_000 },
      );
      const failed = await localeSnapshot(lateFailureScenario.page);
      const rejected = await fontControlSnapshot(lateFailureScenario.page);
      const playableTitle = await lateFailureScenario.page.evaluate(() => {
        const title = document.querySelector('[data-view="title"][data-open="1"]');
        const begin = title?.querySelector('[data-action="begin"]');
        return {
          documentLang: document.documentElement.lang,
          titleText: title?.textContent?.trim() ?? '',
          titleVisible: title instanceof HTMLElement && title.getClientRects().length > 0,
          begin: begin instanceof HTMLButtonElement ? {
            text: begin.textContent ?? '',
            disabled: begin.disabled,
            visible: begin.getClientRects().length > 0,
          } : null,
        };
      });
      await clickAction(lateFailureScenario.page, 'title', 'begin');
      await lateFailureScenario.page.waitForFunction(() => window.__LV?.phase() === 'briefing');
      const afterBegin = {
        phase: await callHarness(lateFailureScenario.page, 'phase'),
        briefingVisible: await lateFailureScenario.page
          .locator('[data-view="briefing"][data-open="1"]')
          .isVisible(),
      };
      await clickAction(lateFailureScenario.page, 'briefing', 'return');
      await lateFailureScenario.page.waitForFunction(() => window.__LV?.phase() === 'title');
      const afterReturn = await localeSnapshot(lateFailureScenario.page);
      const afterReturnControl = await fontControlSnapshot(lateFailureScenario.page);
      const errors = await callHarness(lateFailureScenario.page, 'errors');
      lateFailure = {
        fallback,
        held,
        failed,
        rejected,
        playableTitle,
        afterBegin,
        afterReturn,
        afterReturnControl,
        errors,
        consoleErrors: lateFailureScenario.consoleErrors,
        pageErrors: lateFailureScenario.pageErrors,
      };
    } finally {
      await lateFailureScenario.close();
    }

    const rapidScenario = await openBootScenario(session, {
      localStorageSeed: { [LOCALE_STORAGE_KEY]: 'en' },
      initScripts: [installHeldFontLoads],
    });
    let rapid;
    try {
      await ready(rapidScenario.page, options.timeoutMs);
      const initial = await localeSnapshot(rapidScenario.page);
      await rapidScenario.page.locator('[data-view="title"][data-open="1"] [data-locale="ko"]').click();
      await rapidScenario.page.waitForFunction(() => window.__LV_FONT_CONTROL?.snapshot().calls.length >= 3);
      const koreanPending = await localeSnapshot(rapidScenario.page);
      const held = await fontControlSnapshot(rapidScenario.page);
      await rapidScenario.page.locator('[data-view="title"][data-open="1"] [data-locale="en"]').click();
      await waitForSelected(rapidScenario.page, 'en');
      const englishBeforeRelease = await localeSnapshot(rapidScenario.page);
      await releaseHeldFonts(rapidScenario.page);
      const englishAfterRelease = await localeSnapshot(rapidScenario.page);
      const released = await fontControlSnapshot(rapidScenario.page);
      const errors = await callHarness(rapidScenario.page, 'errors');
      rapid = {
        initial,
        koreanPending,
        held,
        englishBeforeRelease,
        englishAfterRelease,
        released,
        errors,
        consoleErrors: rapidScenario.consoleErrors,
        pageErrors: rapidScenario.pageErrors,
      };
    } finally {
      await rapidScenario.close();
    }

    const evidence = { delayed, lateFailure, rapid };
    verify(delayed.fallback.fontStatus === 'fallback'
      && delayed.held.calls.length === 3
      && delayed.held.calls.every(({ text, status }) => text === '가힣' && status === 'held'),
    'Held Korean boot did not reach bounded fallback with three explicit Hangul probes.', evidence);
    verify(delayed.lateReady.fontStatus === 'ready'
      && delayed.released.calls.every(({ status, faceCount }) => status === 'fulfilled' && faceCount > 0),
    'Released real Korean loads did not replace fallback with late ready.', evidence);
    verify(delayed.afterTitleReturn.fontStatus === 'ready'
      && delayed.afterTitleReturnControl.calls.length === delayed.beforeTitleReturnCalls,
    'Returning to title with the same locale reissued loads or regressed readiness.', evidence);
    verify(lateFailure.fallback.fontStatus === 'fallback'
      && lateFailure.held.calls.length === 3
      && lateFailure.held.calls.every(({ text, status }) => text === '가힣' && status === 'held')
      && lateFailure.failed.fontStatus === 'failed'
      && lateFailure.rejected.calls.length === 3
      && lateFailure.rejected.calls.every(({ status, error }) => status === 'rejected'
        && error === 'controlled late Korean font rejection'),
    'Controlled late rejection did not transition bounded fallback to failed.', evidence);
    verify(lateFailure.failed.selected === 'ko'
      && lateFailure.failed.documentLang === 'ko'
      && lateFailure.playableTitle.documentLang === 'ko'
      && lateFailure.playableTitle.titleVisible
      && lateFailure.playableTitle.titleText.length > 0
      && lateFailure.playableTitle.begin?.text.includes('START FLIGHT')
      && lateFailure.playableTitle.begin.visible
      && !lateFailure.playableTitle.begin.disabled
      && lateFailure.afterBegin.phase === 'briefing'
      && lateFailure.afterBegin.briefingVisible
      && lateFailure.afterReturn.selected === 'ko'
      && lateFailure.afterReturn.documentLang === 'ko'
      && lateFailure.afterReturn.fontStatus === 'failed'
      && lateFailure.afterReturnControl.calls.length === 3,
    'Late font failure did not preserve an actionable Korean title and stable failed state.', evidence);
    verify(rapid.initial.fontStatus === 'not-required'
      && rapid.koreanPending.selected === 'ko' && rapid.koreanPending.fontStatus === 'fallback'
      && rapid.held.calls.length === 3,
    'Rapid English-to-Korean transition did not start exactly one pending Korean preparation.', evidence);
    verify(rapid.englishBeforeRelease.selected === 'en'
      && rapid.englishBeforeRelease.fontStatus === 'not-required'
      && rapid.englishAfterRelease.selected === 'en'
      && rapid.englishAfterRelease.fontStatus === 'not-required'
      && rapid.englishAfterRelease.documentLang === 'en',
    'A stale Korean completion contaminated the final English title state.', evidence);
    verify(delayed.errors.length === 0 && lateFailure.errors.length === 0 && rapid.errors.length === 0
      && delayed.consoleErrors.length === 0 && delayed.pageErrors.length === 0
      && lateFailure.consoleErrors.length === 0 && lateFailure.pageErrors.length === 0
      && rapid.consoleErrors.length === 0 && rapid.pageErrors.length === 0,
    'Font lifecycle scenarios emitted a runtime, console, page, or unhandled-rejection error.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.font-fallback',
    name: 'Font failure keeps Korean UI playable and both boot locales styled correctly',
    assertion:
      'Rejected or empty Korean FontFaceSet results settle failed without deadlock or errors; Korean '
      + 'loader/fatal stacks retain the alias while independent English stacks exclude it.',
  }, async () => {
    const failureScenario = await openBootScenario(session, {
      initScripts: [installBootProbe, installForcedFontFailure],
    });
    let failure;
    try {
      await ready(failureScenario.page, options.timeoutMs);
      failure = await failureScenario.page.evaluate(() => {
        const begin = document.querySelector('[data-view="title"][data-open="1"] [data-action="begin"]');
        const root = document.querySelector('.lv-root');
        return {
          locale: window.__LV?.locale(),
          boot: window.__LV_BOOT_PROBE ?? [],
          failureCalls: window.__LV_FONT_FAILURE_CALLS ?? [],
          visibleText: root?.textContent?.trim() ?? '',
          begin: begin instanceof HTMLButtonElement ? {
            text: begin.textContent ?? '',
            disabled: begin.disabled,
            visible: begin.getClientRects().length > 0,
          } : null,
          overlay: root instanceof HTMLElement ? {
            display: getComputedStyle(root).getPropertyValue('--f-display'),
            mono: getComputedStyle(root).getPropertyValue('--f-mono'),
          } : null,
        };
      });
      failure.errors = await callHarness(failureScenario.page, 'errors');
      failure.consoleErrors = failureScenario.consoleErrors;
      failure.pageErrors = failureScenario.pageErrors;
    } finally {
      await failureScenario.close();
    }

    const emptyScenario = await openBootScenario(session, {
      initScripts: [installEmptyFontResult],
    });
    let empty;
    try {
      await ready(emptyScenario.page, options.timeoutMs);
      empty = await emptyScenario.page.evaluate(() => {
        const begin = document.querySelector('[data-view="title"][data-open="1"] [data-action="begin"]');
        const root = document.querySelector('.lv-root');
        return {
          locale: window.__LV?.locale(),
          calls: window.__LV_EMPTY_FONT_CONTROL?.snapshot().calls ?? [],
          visibleText: root?.textContent?.trim() ?? '',
          begin: begin instanceof HTMLButtonElement ? {
            text: begin.textContent ?? '',
            disabled: begin.disabled,
            visible: begin.getClientRects().length > 0,
          } : null,
        };
      });
      empty.errors = await callHarness(emptyScenario.page, 'errors');
      empty.consoleErrors = emptyScenario.consoleErrors;
      empty.pageErrors = emptyScenario.pageErrors;
    } finally {
      await emptyScenario.close();
    }

    const fatal = {};
    for (const locale of ['ko', 'en']) {
      const fatalScenario = await openBootScenario(session, {
        ...(locale === 'en' ? { localStorageSeed: { [LOCALE_STORAGE_KEY]: 'en' } } : {}),
        initScripts: [installBootProbe, installForcedFontFailure, installWebGL2Failure],
      });
      try {
        await fatalScenario.page.locator('.lv-fatal').waitFor({ state: 'visible', timeout: 5_000 });
        fatal[locale] = {
          dom: await fatalScenario.page.evaluate(() => {
            const node = document.querySelector('.lv-fatal');
            return {
              lang: document.documentElement.lang,
              text: node?.textContent?.trim() ?? '',
              fontFamily: node ? getComputedStyle(node).fontFamily : '',
              boot: window.__LV_BOOT_PROBE ?? [],
              failureCalls: window.__LV_FONT_FAILURE_CALLS ?? [],
            };
          }),
          requests: fatalScenario.requests.filter(({ url }) => isNanumFontUrl(url)),
          consoleErrors: fatalScenario.consoleErrors,
          pageErrors: fatalScenario.pageErrors,
        };
      } finally {
        await fatalScenario.close();
      }
    }

    const evidence = { failure, empty, fatal };
    verify(failure.locale?.selected === 'ko' && failure.locale?.fontStatus === 'failed'
      && failure.failureCalls.length === 3,
    'Rejected Korean font loads did not settle the public state as failed.', evidence);
    verify(failure.visibleText.length > 0 && failure.begin?.text.includes('START FLIGHT')
      && failure.begin.visible && !failure.begin.disabled,
    'Korean fallback title copy or BEGIN control is empty, hidden, or disabled.', evidence);
    const emptyCalls = empty.calls.filter(({ status }) => status === 'empty');
    verify(empty.locale?.selected === 'ko' && empty.locale?.fontStatus === 'failed'
      && empty.calls.length === 3
      && empty.calls.every(({ text }) => text === '가힣')
      && emptyCalls.length === 1
      && emptyCalls[0].font === `400 1em \"${HANGUL_FONT_ALIAS}\"`
      && emptyCalls[0].faceCount === 0
      && empty.calls.every(({ status, faceCount }) => status === 'empty'
        || (status === 'fulfilled' && faceCount > 0)),
    'A declared empty face result did not deterministically settle Korean fonts as failed.', evidence);
    verify(empty.visibleText.length > 0 && empty.begin?.text.includes('START FLIGHT')
      && empty.begin.visible && !empty.begin.disabled,
    'The empty-face failure did not preserve a playable Korean title.', evidence);
    verify(failure.boot.some(({ kind, fontFamily, bodyFontFamily }) => kind === 'loader'
      && fontFamily.includes(HANGUL_FONT_ALIAS) && bodyFontFamily.includes(HANGUL_FONT_ALIAS))
      && failure.overlay?.display.includes(HANGUL_FONT_ALIAS)
      && failure.overlay?.mono.includes(HANGUL_FONT_ALIAS),
    'Failed Korean loader/body or either Overlay token dropped the Hangul alias.', evidence);
    verify(fatal.ko.dom.lang === 'ko' && fatal.ko.dom.text.length > 0
      && fatal.ko.dom.fontFamily.includes(HANGUL_FONT_ALIAS),
    'The localized Korean fatal path omits its visible copy or Hangul stack.', evidence);
    verify(fatal.en.dom.lang === 'en' && fatal.en.dom.text.length > 0
      && !fatal.en.dom.fontFamily.includes(HANGUL_FONT_ALIAS)
      && fatal.en.requests.length === 0 && fatal.en.dom.failureCalls.length === 0,
    'The English fatal path contains the Hangul alias or attempted Korean font work.', evidence);
    verify(failure.errors.length === 0 && empty.errors.length === 0
      && failure.consoleErrors.length === 0
      && failure.pageErrors.length === 0
      && empty.consoleErrors.length === 0 && empty.pageErrors.length === 0
      && fatal.ko.consoleErrors.length === 0 && fatal.ko.pageErrors.length === 0
      && fatal.en.consoleErrors.length === 0 && fatal.en.pageErrors.length === 0,
    'A font failure scenario emitted a runtime, console, page, or unhandled-rejection error.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.mfd-canvas-pixels',
    name: 'Cockpit labels stay on the English avionics layer in every locale',
    assertion:
      'The fixed 1024x256 label atlas is deterministic and English/mono for English, ready Korean, '
      + 'failed-font Korean, late-ready Korean, and a stale en-ko-en completion.',
  }, async () => {
    const englishScenario = await openLocaleScenario(session, 'en');
    let english;
    try {
      await ready(englishScenario.page, options.timeoutMs);
      const first = await prepareMfdCockpit(englishScenario.page, options);
      const repeated = await callHarness(englishScenario.page, 'cockpitMfd');
      english = {
        locale: await localeSnapshot(englishScenario.page),
        first,
        repeated,
      };
    } finally {
      await englishScenario.close();
    }

    const koreanScenario = await openLocaleScenario(session, 'ko');
    let korean;
    try {
      await ready(koreanScenario.page, options.timeoutMs);
      const first = await prepareMfdCockpit(koreanScenario.page, options);
      const repeated = await callHarness(koreanScenario.page, 'cockpitMfd');
      korean = {
        locale: await localeSnapshot(koreanScenario.page),
        first,
        repeated,
      };
    } finally {
      await koreanScenario.close();
    }

    const fallbackScenario = await openLocaleScenario(session, 'ko', {
      initScripts: [installForcedFontFailure],
    });
    let fallback;
    try {
      await ready(fallbackScenario.page, options.timeoutMs);
      fallback = {
        locale: await localeSnapshot(fallbackScenario.page),
        evidence: await prepareMfdCockpit(fallbackScenario.page, options),
      };
    } finally {
      await fallbackScenario.close();
    }

    const lateScenario = await openLocaleScenario(session, 'ko', {
      initScripts: [installHeldFontLoads],
    });
    let lateReady;
    try {
      await ready(lateScenario.page, options.timeoutMs);
      const fallbackEvidence = await prepareMfdCockpit(lateScenario.page, options);
      const lockedFallback = await localeSnapshot(lateScenario.page);
      await releaseHeldFonts(lateScenario.page);
      await lateScenario.page.waitForFunction(
        () => window.__LV?.locale().fontStatus === 'ready',
        undefined,
        { timeout: 10_000 },
      );
      const dirtyOnly = await callHarness(lateScenario.page, 'cockpitMfd');
      await callHarness(lateScenario.page, 'step', [1, 1 / 60], options.timeoutMs);
      await callHarness(lateScenario.page, 'present');
      const readyEvidence = await callHarness(lateScenario.page, 'cockpitMfd');
      lateReady = {
        lockedFallback,
        readyLocale: await localeSnapshot(lateScenario.page),
        fallback: fallbackEvidence,
        dirtyOnly,
        ready: readyEvidence,
        fontControl: await fontControlSnapshot(lateScenario.page),
      };
    } finally {
      await lateScenario.close();
    }

    const staleScenario = await openLocaleScenario(session, 'en', {
      initScripts: [installHeldFontLoads],
    });
    let stale;
    try {
      await ready(staleScenario.page, options.timeoutMs);
      await staleScenario.page.locator('[data-view="title"][data-open="1"] [data-locale="ko"]').click();
      await staleScenario.page.waitForFunction(
        () => window.__LV?.locale().selected === 'ko'
          && window.__LV?.locale().fontStatus === 'fallback'
          && window.__LV_FONT_CONTROL?.snapshot().calls.length === 3,
      );
      const koreanPending = await localeSnapshot(staleScenario.page);
      await staleScenario.page.locator('[data-view="title"][data-open="1"] [data-locale="en"]').click();
      await waitForSelected(staleScenario.page, 'en');
      await prepareMfdCockpit(staleScenario.page, options);
      const beforeRelease = await alignAfterMfdRedraw(staleScenario.page, options);
      await releaseHeldFonts(staleScenario.page);
      await staleScenario.page.evaluate(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await callHarness(staleScenario.page, 'step', [1, 1 / 60], options.timeoutMs);
      await callHarness(staleScenario.page, 'present');
      stale = {
        koreanPending,
        afterReleaseLocale: await localeSnapshot(staleScenario.page),
        beforeRelease,
        afterRelease: await callHarness(staleScenario.page, 'cockpitMfd'),
        fontControl: await fontControlSnapshot(staleScenario.page),
      };
    } finally {
      await staleScenario.close();
    }

    const evidence = { english, korean, fallback, lateReady, stale };
    assertMfdEvidence(english.first, 'en', 'en', true, MFD_LABELS.en, evidence);
    assertMfdEvidence(korean.first, 'ko', 'en', true, MFD_LABELS.en, evidence);
    assertMfdEvidence(fallback.evidence, 'ko', 'en', false, MFD_LABELS.en, evidence);
    assertMfdEvidence(lateReady.ready, 'ko', 'en', true, MFD_LABELS.en, evidence);
    assertMfdEvidence(stale.afterRelease, 'en', 'en', true, MFD_LABELS.en, evidence);
    verify(english.locale.fontStatus === 'not-required'
      && english.first.labelRoi.hash === english.repeated.labelRoi.hash
      && english.first.mfdUpdates === english.repeated.mfdUpdates,
    'Repeated frozen English canvas evidence was not byte-stable.', evidence);
    verify(korean.locale.fontStatus === 'ready'
      && korean.first.labelRoi.hash === korean.repeated.labelRoi.hash
      && korean.first.mfdUpdates === korean.repeated.mfdUpdates
      && korean.first.labelRoi.hash === english.first.labelRoi.hash,
    'Ready Korean left the canonical English cockpit label atlas.', evidence);
    verify(fallback.locale.selected === 'ko' && fallback.locale.fontStatus === 'failed'
      && fallback.evidence.locale === 'ko' && fallback.evidence.renderedLocale === 'en'
      && fallback.evidence.labelRoi.hash === english.first.labelRoi.hash,
    'Failed Korean font preparation did not render the exact English canvas fallback.', evidence);
    verify(lateReady.lockedFallback.active === 'ko' && lateReady.lockedFallback.locked
      && lateReady.lockedFallback.fontStatus === 'fallback'
      && lateReady.readyLocale.active === 'ko' && lateReady.readyLocale.fontStatus === 'ready'
      && lateReady.fallback.labelRoi.hash === english.first.labelRoi.hash
      && lateReady.dirtyOnly.labelRoi.hash === lateReady.fallback.labelRoi.hash
      && lateReady.dirtyOnly.mfdUpdates === lateReady.fallback.mfdUpdates
      && lateReady.ready.mfdUpdates === lateReady.fallback.mfdUpdates
      && lateReady.ready.labelRoi.hash === lateReady.fallback.labelRoi.hash,
    'Korean font readiness incorrectly redrew or relocalized English avionics.', evidence);
    verify(stale.koreanPending.selected === 'ko' && stale.koreanPending.fontStatus === 'fallback'
      && stale.afterReleaseLocale.selected === 'en'
      && stale.afterReleaseLocale.fontStatus === 'not-required'
      && stale.afterRelease.labelRoi.hash === stale.beforeRelease.labelRoi.hash
      && stale.afterRelease.mfdUpdates === stale.beforeRelease.mfdUpdates,
    'A stale held Korean completion changed the final English canvas or redraw counter.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.mfd-postfx-pixels',
    name: 'English avionics remain pixel-stable across locale and font state',
    assertion:
      'With boost, warp, film grain, motion blur, and chromatic aberration settled off, physical-PNG '
      + 'pixels inside the projected MFD quad remain within the same renderer envelope for English, '
      + 'ready Korean and failed-font Korean, while a remote control ROI remains unchanged.',
  }, async () => {
    const cases = {
      english: { locale: 'en', renderedLocale: 'en', initScripts: [] },
      korean: { locale: 'ko', renderedLocale: 'en', initScripts: [] },
      fallback: { locale: 'ko', renderedLocale: 'en', initScripts: [installForcedFontFailure] },
    };
    const evidence = {};
    for (const [name, fixture] of Object.entries(cases)) {
      const scenario = await openLocaleScenario(session, fixture.locale, {
        initScripts: fixture.initScripts,
      });
      try {
        await ready(scenario.page, options.timeoutMs);
        const mfd = await prepareMfdCockpit(scenario.page, options, {
          settleFrames: 600,
          pinRenderScale: true,
        });
        verify(mfd.renderedLocale === fixture.renderedLocale,
          `${name} post-FX fixture did not reach the expected effective MFD locale.`, { mfd, fixture });
        evidence[name] = await captureMfdPostFx(scenario.page, mfd, options);
      } finally {
        await scenario.close();
      }
    }

    const expectedWidth = Math.round(options.viewport.width * options.deviceScaleFactor);
    const expectedHeight = Math.round(options.viewport.height * options.deviceScaleFactor);
    for (const [name, capture] of Object.entries(evidence)) {
      verify(capture.image.width === expectedWidth && capture.image.height === expectedHeight,
        `${name} screenshot did not use scale=device physical PNG dimensions.`, {
          expectedWidth,
          expectedHeight,
          capture,
        });
      verify(capture.mfd.pixelCount >= 2_000 * options.deviceScaleFactor ** 2,
        `${name} projected MFD sample is not material.`, capture);
      verify(capture.mfd.hash === capture.repeat.mfd.hash
        && capture.control.hash === capture.repeat.control.hash,
      `${name} frozen same-locale screenshot repeat was not pixel-identical.`, capture);
      verify(capture.overlay.hidden === true && capture.overlay.visibleOccluders === 0,
        `${name} DOM HUD/Overlay was not hidden before screenshot capture.`, capture);
      verify(capture.postFx.motionBlur === false && capture.postFx.filmGrain === false
        && capture.postFx.chromaticAberration === false && capture.postFx.boosting === false
        && capture.postFx.warpSettled === true
        && capture.postFx.maxRawScreenDelta <= MFD_SCREEN_SETTLE_EPSILON,
      `${name} capture did not settle every named post-FX source to zero/off.`, capture);
      verify(capture.control.overlapsMfd === false,
        `${name} remote background control ROI overlaps the MFD sample.`, capture);
    }
    verify(evidence.english.control.hash === evidence.korean.control.hash
      && evidence.english.control.hash === evidence.fallback.control.hash,
    'A remote post-FX background control changed across locale/font fixtures.', evidence);
    const fallbackLabelDiff = comparePixelSamples(evidence.english.mfd, evidence.fallback.mfd);
    const koreanLabelDiff = comparePixelSamples(evidence.english.mfd, evidence.korean.mfd);
    const fallbackControlDiff = comparePixelSamples(evidence.english.control, evidence.fallback.control);
    const koreanControlDiff = comparePixelSamples(evidence.english.control, evidence.korean.control);
    evidence.pixelDiff = {
      fallbackLabel: fallbackLabelDiff,
      koreanLabel: koreanLabelDiff,
      fallbackControl: fallbackControlDiff,
      koreanControl: koreanControlDiff,
      thresholds: {
        fallbackMaxChannelDelta: MFD_FALLBACK_MAX_CHANNEL_DELTA,
        fallbackMaxChangedFraction: MFD_FALLBACK_MAX_CHANGED_FRACTION,
      },
    };
    verify(evidence.fallback.sourceCanvasHash === evidence.english.sourceCanvasHash
      && fallbackLabelDiff.maxChannelDelta <= MFD_FALLBACK_MAX_CHANNEL_DELTA
      && fallbackLabelDiff.changedFraction <= MFD_FALLBACK_MAX_CHANGED_FRACTION,
    'Failed Korean font fallback exceeded the measured one-code English renderer envelope.', evidence);
    verify(evidence.korean.sourceCanvasHash === evidence.english.sourceCanvasHash
      && koreanLabelDiff.maxChannelDelta <= MFD_FALLBACK_MAX_CHANNEL_DELTA
      && koreanLabelDiff.changedFraction <= MFD_FALLBACK_MAX_CHANGED_FRACTION,
    'Ready Korean final pixels left the English avionics renderer envelope.', evidence);
    return evidence;
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
      + 'nullable/unlocked, Korean is applied, the START FLIGHT action regains focus, and the title '
      + 'ship/camera resume their cinematic motion.',
  }, async () => {
    const locked = await localeSnapshot(page);
    if (await page.locator('[data-view="pause"][data-open="1"] [data-action="abort"]').count() === 0) {
      await page.keyboard.press('Escape');
    }
    const abort = page.locator('[data-view="pause"][data-open="1"] [data-action="abort"]');
    await abort.waitFor({ state: 'visible', timeout: 5_000 });
    await abort.click();
    await page.waitForFunction(() => window.__LV?.phase() === 'title');
    await callHarness(page, 'step', [2, 1 / 60], options.timeoutMs);
    const poseBefore = await callHarness(page, 'pose');
    await callHarness(page, 'step', [30, 1 / 60], options.timeoutMs);
    const poseAfter = await callHarness(page, 'pose');
    const locale = await localeSnapshot(page);
    const title = await page.evaluate(() => {
      const begin = document.querySelector('[data-view="title"][data-open="1"] [data-action="begin"]');
      return {
        beginVisible: begin instanceof HTMLElement && begin.getClientRects().length > 0,
        beginFocused: document.activeElement === begin,
      };
    });
    const evidence = {
      locked,
      locale,
      title,
      motion: {
        ship: vectorDistance(poseBefore.position, poseAfter.position),
        camera: vectorDistance(poseBefore.camera.position, poseAfter.camera.position),
      },
    };
    verify(locked.active === 'en' && locked.locked, 'The run was not locked before returning to title.', evidence);
    verify(locale.selected === 'ko' && locale.active === null && locale.locked === false,
      'Returning to title did not reload Korean and clear the active run locale.', evidence);
    verify(locale.documentLang === 'ko', 'Returning to title did not apply lang=ko.', evidence);
    verify(title.beginVisible && title.beginFocused,
      'The visible title START FLIGHT action was not restored and focused.', evidence);
    verify(evidence.motion.ship > 1 && evidence.motion.camera > 1,
      'Returning to title left the cinematic pinned to an authored still vantage.', evidence);
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
    name: 'Hybrid Korean uses explicit English UI and Korean guidance boundaries',
    assertion:
      'English interface nodes and language names carry lang=en, Korean guidance inherits lang=ko, '
      + 'and embedded ACHRA, CAIRN, C, ESC, CAIRN/TERMINUS tokens remain exact lang=en spans.',
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
      verify(evidence.boundaries.documentLang === 'ko'
        && JSON.stringify(evidence.boundaries.english) === JSON.stringify([
          'titleEyebrow',
          'titleAction',
          'titleFooter',
          'settingLabel',
          'settingEnum',
          'settingSwitch',
          'settingSlider',
          'controlsTitle',
          'briefingKicker',
        ])
        && JSON.stringify(evidence.boundaries.korean) === JSON.stringify([
          'tagline',
          'settingHint',
          'controlDescription',
          'briefingProse',
        ])
        && JSON.stringify(evidence.boundaries.localeButtons) === JSON.stringify([
          { locale: 'ko', text: '한국어', lang: 'ko' },
          { locale: 'en', text: 'English', lang: 'en' },
        ]),
      'Hybrid Korean language boundaries differ from the approved UI-spine strategy.', evidence);
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
          verify(comparisonHeader?.text === 'Δ BEST',
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

  await report.check({
    id: 'I18N.event-descriptors',
    name: 'Production HUD events carry localized descriptors and unchanged legacy English',
    assertion:
      'Isolated Korean and English runs exercise engage, both cameras, pointer refusal, impact, '
      + 'boost depletion, every gate accuracy and remaining branch, gate clear/miss logs, and exact DOM copy.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale, {
        initScripts: [installPointerLockSuccess],
      });
      try {
        await ready(scenario.page, options.timeoutMs);
        await callHarness(scenario.page, 'setDriven', [true]);
        await callHarness(scenario.page, 'startRun', [{ skipIntro: false }]);
        await callHarness(scenario.page, 'step', [181, 1 / 60], options.timeoutMs);
        const engage = await hudEventSnapshot(scenario.page);
        assertCalloutEvent(locale, engage, {
          legacyTitle: 'ENGAGE',
          legacySub: 'VESPER TERMINUS',
          titleMessage: { type: 'callout-title.engage' },
          subMessage: undefined,
          dom: EVENT_COPY[locale].engage,
          domTokens: locale === 'ko' ? [[], ['VESPER TERMINUS']] : [[], []],
        });

        const cameras = {};
        for (const mode of ['cockpit', 'chase']) {
          await scenario.page.keyboard.press('c');
          await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
          cameras[mode] = await hudEventSnapshot(scenario.page);
          const legacy = EVENT_COPY.en.camera[mode];
          assertCalloutEvent(locale, cameras[mode], {
            legacyTitle: legacy[0],
            legacySub: legacy[1],
            titleMessage: { type: 'callout-title.camera-view', mode },
            subMessage: { type: 'callout-sub.camera-active', mode },
            dom: EVENT_COPY[locale].camera[mode],
          });
        }

        await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
        const beforeImpact = await callHarness(scenario.page, 'telemetry');
        const staged = await callHarness(scenario.page, 'stageCollision');
        verify(staged !== null, 'Could not stage the production hull-impact path.', { locale, staged });
        await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const impact = await hudEventSnapshot(scenario.page);
        const impactPhysical = assertImpactEvent(locale, impact, beforeImpact, staged);
        const impactPercentMutation = structuredClone(impact);
        const mutatedImpactLine = impactPercentMutation.telemetry.log
          .find(({ message }) => message?.type === 'log.hull-contact');
        verify(mutatedImpactLine !== undefined,
          'Could not construct the hull-percent contract self-test.', { locale, impact });
        mutatedImpactLine.message.percent = impactPhysical.expectedPercent + 1;
        mutatedImpactLine.text = `hull contact · ${mutatedImpactLine.message.percent}%`;
        const mutatedImpactIndex = impactPercentMutation.telemetry.log.indexOf(mutatedImpactLine);
        impactPercentMutation.dom.logs[mutatedImpactIndex] = locale === 'ko'
          ? `선체 접촉 · ${mutatedImpactLine.message.percent}%`
          : mutatedImpactLine.text;
        const impactMutationRejection = captureAssertionFailure(
          () => assertImpactEvent(locale, impactPercentMutation, beforeImpact, staged),
        );
        verify(impactMutationRejection?.message.includes('physical hull-delta evidence') === true,
          `${locale} independent hull-percent contract did not reject a wrong descriptor parameter.`, {
            expectedPercent: impactPhysical.expectedPercent,
            mutatedPercent: mutatedImpactLine.message.percent,
            impactMutationRejection,
          });

        await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
        await callHarness(scenario.page, 'setInput', [{ throttle: 1, boost: true }]);
        let boost = null;
        for (let frames = 0; frames < 300 && boost === null; frames += 12) {
          await callHarness(scenario.page, 'step', [12, 1 / 60], options.timeoutMs);
          const snapshot = await hudEventSnapshot(scenario.page);
          if (snapshot.telemetry.boostLocked === true) boost = snapshot;
        }
        await callHarness(scenario.page, 'setInput', [null]);
        verify(boost !== null, 'The production boost reserve did not reach its depleted transition.', { locale });
        assertBoostEvent(locale, boost);

        const gateEvents = await collectGateEventFlow(scenario.page, options);
        const gateContract = assertGateEventFlow(locale, gateEvents);
        evidence[locale] = {
          engage,
          cameras,
          impact,
          impactPhysical,
          impactMutationRejection,
          boost,
          gateEvents,
          gateContract,
        };
      } finally {
        await scenario.close();
      }

      const pointerScenario = await openLocaleScenario(session, locale, {
        initScripts: [installPointerLockRefusal],
      });
      try {
        await ready(pointerScenario.page, options.timeoutMs);
        await callHarness(pointerScenario.page, 'setDriven', [true]);
        await callHarness(pointerScenario.page, 'startRun', [{ skipIntro: true }]);
        await pointerScenario.page.waitForFunction(() => window.__LV?.telemetry().pointerLockRefused === true);
        await callHarness(pointerScenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const pointer = await hudEventSnapshot(pointerScenario.page);
        assertPointerEvent(locale, pointer, 'ordinary refusal');
        evidence[locale].pointer = pointer;
      } finally {
        await pointerScenario.close();
      }
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.gate-name-descriptor',
    name: 'Only the final gate owns the frozen localized name descriptor',
    assertion:
      'Gates 1-8 retain CAIRN NN without descriptors, the final gate localizes with stable identity '
      + 'across frames, and course completion clears the descriptor while preserving VESPER TERMINUS.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale, {
        initScripts: [installPointerLockSuccess],
      });
      try {
        await ready(scenario.page, options.timeoutMs);
        await callHarness(scenario.page, 'setDriven', [true]);
        await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
        const early = [];
        for (let index = 0; index < 8; index++) {
          await callHarness(scenario.page, 'seekCourse', [index / 9]);
          await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
          early.push(await gateNameSnapshot(scenario.page));
        }
        await callHarness(scenario.page, 'seekCourse', [0.999]);
        await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const final = await gateNameSnapshot(scenario.page);
        await scenario.page.evaluate(() => {
          window.__LV_GATE_MESSAGE_REF = window.__LV?.telemetry().gate.nameMessage;
        });
        await callHarness(scenario.page, 'step', [3, 1 / 60], options.timeoutMs);
        const stable = await scenario.page.evaluate(() => ({
          same: window.__LV_GATE_MESSAGE_REF === window.__LV?.telemetry().gate.nameMessage,
          descriptor: window.__LV?.telemetry().gate.nameMessage,
        }));
        await callHarness(scenario.page, 'vantage', ['terminus']);
        await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const complete = await gateNameSnapshot(scenario.page);
        const expectedFinal = 'TERMINUS APPROACH';
        verify(early.every((entry, index) => entry.name === `CAIRN ${String(index + 1).padStart(2, '0')}`
          && entry.nameMessage === undefined && entry.domText === entry.name && entry.domLang === 'en'
          && entry.domTokens.length === 0),
        `${locale} early gate fallback changed or acquired a descriptor.`, { early });
        verify(final.name === 'TERMINUS APPROACH'
          && JSON.stringify(final.nameMessage) === JSON.stringify({ type: 'gate-name.terminus-approach' })
          && final.domText === expectedFinal && final.domLang === null
          && JSON.stringify(final.domTokens) === JSON.stringify(locale === 'ko' ? ['TERMINUS'] : []),
        `${locale} final gate descriptor or localized DOM differs.`, { final, expectedFinal });
        verify(stable.same === true, `${locale} final gate descriptor identity changed across frames.`, stable);
        verify(complete.name === 'VESPER TERMINUS' && complete.nameMessage === undefined
          && complete.domText === 'VESPER TERMINUS' && complete.domLang === 'en'
          && complete.domTokens.length === 0,
        `${locale} completion did not clear the gate descriptor into the legacy destination fallback.`, complete);
        evidence[locale] = { early, final, stable, complete };
      } finally {
        await scenario.close();
      }
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.radio-lines',
    name: 'All five radio lines use the run-locked locale with timing parity',
    assertion:
      'Actual radio events preserve speakers, render exact localized bodies, agree with a same-run '
      + 'callout locale, and remain visible through the same English-length boundary in both locales.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale, {
        initScripts: [installPointerLockSuccess],
      });
      try {
        await ready(scenario.page, options.timeoutMs);
        await callHarness(scenario.page, 'setDriven', [true]);
        await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
        const first = await radioSnapshot(scenario.page);
        await callHarness(scenario.page, 'step', [307, 1 / 60], options.timeoutMs);
        const beforeBoundary = await radioSnapshot(scenario.page);
        await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const atBoundary = await radioSnapshot(scenario.page);
        await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
        const run = await collectRadioFlow(scenario.page, options);
        const expected = RADIO_COPY[locale].map(([speaker, text], index) => ({
          speaker,
          text,
          tokens: locale === 'ko' ? RADIO_EN_TOKENS[index] : [],
        }));
        verify(JSON.stringify(run.lines) === JSON.stringify(expected),
          `${locale} radio event sequence differs from the independent literal fixture.`, { run, expected });
        verify(first.speaker === expected[0].speaker && first.text === expected[0].text
          && JSON.stringify(first.textTokens) === JSON.stringify(expected[0].tokens)
          && first.speakerLang === 'en' && first.ariaHidden === null,
        `${locale} first radio event differs.`, { first, expected });
        verify(beforeBoundary.on === '1' && beforeBoundary.ariaHidden === null
          && atBoundary.on === '0' && atBoundary.ariaHidden === 'true',
          `${locale} radio dwell does not use the 55-character legacy-English boundary.`, {
            beforeBoundary,
            atBoundary,
            expectedVisibleFrames: 307,
            expectedHiddenFrame: 308,
          });
        verify(run.calloutLocaleText === EVENT_COPY[locale].accuracies[run.firstAccuracy],
          `${locale} radio and same-run callout translators disagree.`, run);
        evidence[locale] = { first, beforeBoundary, atBoundary, ...run };
      } finally {
        await scenario.close();
      }
    }
    verify(evidence.ko.beforeBoundary.on === evidence.en.beforeBoundary.on
      && evidence.ko.atBoundary.on === evidence.en.atBoundary.on,
    'Korean and English radio dwell boundaries differ.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.hud-static-copy',
    name: 'Static HUD labels, ARIA, and Latin-only nodes use the active locale safely',
    assertion:
      'Both locales render exact static labels, meters, boost copy, and Latin-only nodes; flight '
      + 'regions are hidden from accessibility while inactive without hiding the radio-capable HUD root.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale, {
        initScripts: [installPointerLockSuccess],
      });
      try {
        await ready(scenario.page, options.timeoutMs);
        const hidden = await hudStaticSnapshot(scenario.page);
        await callHarness(scenario.page, 'setDriven', [true]);
        await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
        await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const available = await hudStaticSnapshot(scenario.page);
        await callHarness(scenario.page, 'setInput', [{ throttle: 1, boost: true }]);
        let locked = null;
        for (let frames = 0; frames < 300 && locked === null; frames += 12) {
          await callHarness(scenario.page, 'step', [12, 1 / 60], options.timeoutMs);
          const telemetry = await callHarness(scenario.page, 'telemetry');
          if (telemetry.boostLocked === true) locked = await hudStaticSnapshot(scenario.page);
        }
        await callHarness(scenario.page, 'setInput', [null]);
        verify(locked !== null, `${locale} production boost reserve did not enter its locked state.`);
        assertHudStatic(locale, hidden, available, locked);
        evidence[locale] = { hidden, available, locked };
      } finally {
        await scenario.close();
      }
    }
    verify(JSON.stringify(evidence.ko.available.raw) === JSON.stringify(evidence.en.available.raw),
      'Localization changed raw HUD numeric/unit content.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.hostile-text',
    name: 'Hostile pointer-lock reasons remain inert text through Game and Hud',
    assertion:
      'A pre-document requestPointerLock rejection traverses Input -> Game descriptor -> Hud, '
      + 'renders the markup-shaped payload literally, creates no executable/media node or request, and reports no error.',
  }, async () => {
    const scenario = await openLocaleScenario(session, 'ko', {
      initScripts: [installHostilePointerLock],
    });
    try {
      await ready(scenario.page, options.timeoutMs);
      await callHarness(scenario.page, 'setDriven', [true]);
      await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
      await scenario.page.waitForFunction(() => window.__LV?.telemetry().pointerLockRefused === true);
      await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
      const dom = await scenario.page.evaluate((payload) => ({
        calloutTitle: document.querySelector('.lv-callout-t')?.textContent ?? '',
        calloutSub: document.querySelector('.lv-callout-s')?.textContent ?? '',
        logs: Array.from(document.querySelectorAll('.lv-log-line'), (node) => node.textContent ?? ''),
        hostileLogChildren: Array.from(document.querySelectorAll('.lv-log-line'))
          .find((node) => node.textContent?.includes(payload))?.children.length ?? -1,
        forbidden: Array.from(document.querySelectorAll('.lv-hud script, .lv-hud img, .lv-hud iframe, .lv-root script, .lv-root img, .lv-root iframe'),
          (node) => node.outerHTML),
        injected: window.__LV_INJECTED,
        positiveControl: new DOMParser().parseFromString(payload, 'text/html').querySelector('img') !== null,
      }), HOSTILE_REASON);
      const telemetry = await callHarness(scenario.page, 'telemetry');
      const errors = await callHarness(scenario.page, 'errors');
      const payloadRequests = scenario.requests.filter(({ url }) => new URL(url).pathname.endsWith('/x'));
      const evidence = { dom, telemetry, errors, payloadRequests, requests: scenario.requests };
      verify(dom.calloutTitle === EVENT_COPY.ko.pointer[0]
        && dom.calloutSub === EVENT_COPY.ko.pointer[1]
        && dom.logs.includes(`마우스 고정 거부 · ${HOSTILE_REASON}`),
      'Hostile reason did not render literally through the localized production path.', evidence);
      verify(telemetry.log.some(({ text, message }) => text === `mouse capture refused · ${HOSTILE_REASON}`
        && JSON.stringify(message) === JSON.stringify({ type: 'log.pointer-lock-refused', reason: HOSTILE_REASON })),
      'Hostile reason did not retain the independent English legacy log and exact descriptor.', evidence);
      verify(dom.positiveControl && dom.forbidden.length === 0 && dom.injected === undefined
        && dom.hostileLogChildren === 0,
        'Hostile text became active markup inside the HUD/root.', evidence);
      verify(payloadRequests.length === 0, 'Hostile text triggered an x resource request.', evidence);
      verify(errors.length === 0, 'Hostile text added a runtime/harness error.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.legacy-fallback',
    name: 'Descriptor-less public telemetry retains exact legacy fallback rendering',
    assertion:
      'In driven, flying, simulation-paused Korean and English runs, a live telemetry mutation '
      + 'renders unique descriptor-less callout/log bytes and the natural CAIRN 01 gate fallback unchanged.',
  }, async () => {
    const evidence = {};
    for (const locale of ['ko', 'en']) {
      const scenario = await openLocaleScenario(session, locale, {
        initScripts: [installPointerLockSuccess],
      });
      try {
        await ready(scenario.page, options.timeoutMs);
        await callHarness(scenario.page, 'setDriven', [true]);
        await callHarness(scenario.page, 'startRun', [{ skipIntro: true }]);
        await callHarness(scenario.page, 'setPaused', [true]);
        const before = await callHarness(scenario.page, 'telemetry');
        await scenario.page.evaluate(() => {
          const telemetry = window.__LV?.telemetry();
          if (!telemetry) throw new Error('Telemetry unavailable for legacy fallback prefill.');
          telemetry.callout = {
            id: 987654320,
            title: 'ENGAGE',
            titleMessage: { type: 'callout-title.engage' },
            sub: 'W A S D / ARROWS STILL FLY',
            subMessage: { type: 'callout-sub.keyboard-flight-available' },
            tone: 'neutral',
            ttl: 30,
            ttlMax: 30,
          };
          telemetry.log.push({
            id: 987654320,
            text: 'cairn 01 missed',
            message: { type: 'log.gate-missed', gate: 1 },
            tone: 'neutral',
            age: 0,
          });
        });
        await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const prefill = await pageTextSnapshot(scenario.page);
        await scenario.page.evaluate(() => {
          window.__LV_LEGACY_LOG_NODE = document.querySelector('.lv-log-line:last-child');
        });
        await scenario.page.evaluate((fixture) => {
          const telemetry = window.__LV?.telemetry();
          if (!telemetry) throw new Error('Telemetry unavailable for legacy fallback fixture.');
          telemetry.callout = {
            id: 987654321,
            title: fixture.title,
            titleMessage: undefined,
            sub: fixture.sub,
            subMessage: undefined,
            tone: 'neutral',
            ttl: 30,
            ttlMax: 30,
          };
          const prefillIndex = telemetry.log.findIndex((line) => line.id === 987654320);
          if (prefillIndex < 0) throw new Error('Legacy fallback prefill log is missing.');
          telemetry.log.splice(prefillIndex, 1);
          telemetry.log.push({
            id: 987654321,
            text: fixture.log,
            message: undefined,
            tone: 'neutral',
            age: 0,
          });
        }, LEGACY_FALLBACK);
        await callHarness(scenario.page, 'step', [1, 1 / 60], options.timeoutMs);
        const after = await callHarness(scenario.page, 'telemetry');
        const dom = await pageTextSnapshot(scenario.page);
        const reusedLogNode = await scenario.page.evaluate((text) =>
          Array.from(document.querySelectorAll('.lv-log-line'))
            .some((node) => node.textContent === text && node === window.__LV_LEGACY_LOG_NODE),
        LEGACY_FALLBACK.log);
        const evidenceEntry = { before, prefill, after, dom, reusedLogNode };
        verify(before.phase === 'flying' && after.phase === 'flying' && after.elapsed === before.elapsed,
          `${locale} fallback scenario was not driven/flying/simulation-paused.`, evidenceEntry);
        verify(locale === 'ko'
          ? prefill.calloutSubNode.childElementCount > 0
            && prefill.logNodes.some((node) => node.childElementCount > 0)
          : prefill.calloutSubNode.childElementCount === 0
            && prefill.logNodes.every((node) => node.childElementCount === 0),
        `${locale} descriptor-backed prefill did not establish the expected token structure.`, evidenceEntry);
        verify(dom.calloutTitle === LEGACY_FALLBACK.title && dom.calloutSub === LEGACY_FALLBACK.sub
          && dom.logs.includes(LEGACY_FALLBACK.log),
        `${locale} descriptor-less callout/log did not use exact legacy fallback bytes.`, evidenceEntry);
        verify(dom.calloutTitleNode.childElementCount === 0 && dom.calloutTitleNode.lang === 'en'
          && dom.calloutSubNode.childElementCount === 0 && dom.calloutSubNode.lang === 'en'
          && dom.logNodes.some((node) => node.textContent === LEGACY_FALLBACK.log
            && node.childElementCount === 0 && node.lang === 'en')
          && reusedLogNode === true,
        `${locale} descriptor-less callout/log fallback acquired token spans or lost whole-node lang=en.`,
        evidenceEntry);
        verify(dom.gateName === 'CAIRN 01' && dom.gateLang === 'en'
          && after.gate.name === 'CAIRN 01' && after.gate.nameMessage === undefined,
        `${locale} natural early gate did not use the legacy name fallback.`, evidenceEntry);
        evidence[locale] = evidenceEntry;
      } finally {
        await scenario.close();
      }
    }
    return evidence;
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

async function prepareMfdCockpit(page, options, {
  settleFrames = 60,
  pinRenderScale = false,
} = {}) {
  await callHarness(page, 'setDriven', [true]);
  if (pinRenderScale) await callHarness(page, 'setSettings', [{ renderScale: 0.99 }]);
  await callHarness(page, 'setSettings', [{
    cameraMode: 'cockpit',
    quality: 'high',
    renderScale: 1,
    showFps: false,
    cameraShake: 0,
    motionBlur: false,
    filmGrain: false,
    chromaticAberration: false,
  }]);
  await callHarness(page, 'setInput', [{
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    strafeX: 0,
    strafeY: 0,
    boost: false,
    brake: false,
  }]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'step', [settleFrames, 1 / 60], options.timeoutMs);
  await callHarness(page, 'present');
  const cameraMode = await callHarness(page, 'cameraMode');
  const evidence = await callHarness(page, 'cockpitMfd');
  verify(cameraMode === 'cockpit' && evidence?.visible === true,
    'MFD evidence was not captured from a visible applied cockpit camera.', {
      cameraMode,
      evidence,
    });
  return evidence;
}

async function alignAfterMfdRedraw(page, options) {
  let previous = await callHarness(page, 'cockpitMfd');
  for (let frame = 1; frame <= 4; frame += 1) {
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const current = await callHarness(page, 'cockpitMfd');
    if (current.mfdUpdates > previous.mfdUpdates) return current;
    previous = current;
  }
  throw Object.assign(new Error('No MFD redraw occurred within four 60 Hz frames.'), {
    evidence: { previous },
  });
}

function assertMfdEvidence(actual, locale, renderedLocale, fontReady, labels, context) {
  const evidence = { expected: { locale, renderedLocale, fontReady, labels }, actual, context };
  verify(actual?.locale === locale && actual?.renderedLocale === renderedLocale
    && actual?.fontReady === fontReady && actual?.visible === true,
  'MFD locale/readiness/visibility evidence differs from the expected effective state.', evidence);
  verify(JSON.stringify(actual.canvas) === JSON.stringify(MFD_CANVAS)
    && actual.labelRoi?.x === MFD_LABEL_ROI.x
    && actual.labelRoi?.y === MFD_LABEL_ROI.y
    && actual.labelRoi?.width === MFD_LABEL_ROI.width
    && actual.labelRoi?.height === MFD_LABEL_ROI.height
    && /^[0-9a-f]{8}$/u.test(actual.labelRoi?.hash ?? ''),
  'MFD canvas dimensions, fixed label ROI, or actual RGBA hash is invalid.', evidence);
  verify(Array.isArray(actual.labels) && actual.labels.length === labels.length
    && JSON.stringify(actual.labels.map(({ text }) => text)) === JSON.stringify(labels),
  'MFD fitted labels do not match the exact effective catalog.', evidence);
  verify(actual.labels.every(({ fontPx, measuredWidth, allowedWidth, ellipsized }) =>
    Number.isInteger(fontPx) && fontPx > 0
    && Number.isFinite(measuredWidth) && measuredWidth >= 0
    && Number.isFinite(allowedWidth) && allowedWidth > 0
    && measuredWidth <= allowedWidth + 1e-6
    && ellipsized === false),
  'An MFD label exceeds its panel width or unexpectedly ellipsized.', evidence);
  for (const field of [
    'projectedNdcCorners',
    'screenNdcCorners',
    'labelProjectedNdcCorners',
    'labelScreenNdcCorners',
  ]) {
    verify(Array.isArray(actual[field]) && actual[field].length === 4
      && actual[field].every((corner) => Array.isArray(corner) && corner.length === 3
        && corner.every((value) => Number.isFinite(value))),
    `MFD ${field} does not contain four finite TL/TR/BR/BL corners.`, evidence);
  }
  verify(Number.isInteger(actual.mfdUpdates) && actual.mfdUpdates > 0,
    'MFD redraw evidence is not a positive integer.', evidence);
}

async function captureMfdPostFx(page, mfd, options) {
  await page.locator('.lv-loader').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
  const overlay = await page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll('.lv-root'));
    for (const root of roots) {
      if (root instanceof HTMLElement) root.style.visibility = 'hidden';
    }
    const visibleOccluders = roots.filter((root) => root instanceof HTMLElement
      && root.getClientRects().length > 0
      && getComputedStyle(root).visibility !== 'hidden').length;
    return {
      roots: roots.length,
      hidden: roots.length > 0 && roots.every((root) => root instanceof HTMLElement
        && getComputedStyle(root).visibility === 'hidden'),
      visibleOccluders,
    };
  });
  await callHarness(page, 'present');

  const [settings, telemetry] = await Promise.all([
    callHarness(page, 'settings'),
    callHarness(page, 'telemetry'),
  ]);
  const firstBuffer = await page.screenshot({ type: 'png', scale: 'device' });
  const repeatBuffer = await page.screenshot({ type: 'png', scale: 'device' });
  const first = decodePng(firstBuffer);
  const repeated = decodePng(repeatBuffer);
  verify(first.width === repeated.width && first.height === repeated.height
    && first.channels === repeated.channels,
  'Frozen screenshot repeat changed its decoded PNG shape.', {
    first: { width: first.width, height: first.height, channels: first.channels },
    repeated: { width: repeated.width, height: repeated.height, channels: repeated.channels },
  });

  const insetPixels = Math.max(2, Math.round(2 * options.deviceScaleFactor));
  const mfdPixels = hashProjectedQuad(first, mfd.labelScreenNdcCorners, insetPixels);
  const repeatMfdPixels = hashProjectedQuad(repeated, mfd.labelScreenNdcCorners, insetPixels);
  const controlBounds = {
    x: Math.round(first.width * 0.06),
    y: Math.round(first.height * 0.06),
    width: Math.max(32, Math.round(first.width * 0.06)),
    height: Math.max(32, Math.round(first.height * 0.06)),
  };
  const control = hashPixelRect(first, controlBounds);
  const repeatControl = hashPixelRect(repeated, controlBounds);
  control.overlapsMfd = rectanglesOverlap(control.bounds, mfdPixels.bounds);
  repeatControl.overlapsMfd = rectanglesOverlap(repeatControl.bounds, repeatMfdPixels.bounds);
  const maxRawScreenDelta = Math.max(...mfd.labelProjectedNdcCorners.flatMap((corner, index) =>
    corner.map((value, axis) => Math.abs(value - mfd.labelScreenNdcCorners[index][axis]))));
  return {
    locale: mfd.locale,
    renderedLocale: mfd.renderedLocale,
    fontReady: mfd.fontReady,
    sourceCanvasHash: mfd.labelRoi.hash,
    image: { width: first.width, height: first.height, channels: first.channels },
    insetPixels,
    mfd: mfdPixels,
    repeat: { mfd: repeatMfdPixels, control: repeatControl },
    control,
    overlay,
    postFx: {
      motionBlur: settings.motionBlur,
      filmGrain: settings.filmGrain,
      chromaticAberration: settings.chromaticAberration,
      boosting: telemetry.boosting,
      maxRawScreenDelta,
      allowedRawScreenDelta: MFD_SCREEN_SETTLE_EPSILON,
      warpSettled: maxRawScreenDelta <= MFD_SCREEN_SETTLE_EPSILON,
    },
  };
}

function hashProjectedQuad(image, ndcCorners, insetPixels) {
  verify(Array.isArray(ndcCorners) && ndcCorners.length === 4,
    'Projected MFD quad does not contain four corners.', { ndcCorners });
  const corners = ndcCorners.map(([x, y]) => ({
    x: (x + 1) * 0.5 * image.width,
    y: (1 - y) * 0.5 * image.height,
  }));
  const centre = corners.reduce((sum, point) => ({
    x: sum.x + point.x / corners.length,
    y: sum.y + point.y / corners.length,
  }), { x: 0, y: 0 });
  const insetCorners = corners.map((point) => {
    const dx = centre.x - point.x;
    const dy = centre.y - point.y;
    const distance = Math.hypot(dx, dy);
    const scale = distance > 0 ? Math.min(0.45, insetPixels / distance) : 0;
    return { x: point.x + dx * scale, y: point.y + dy * scale };
  });
  const bounds = polygonBounds(insetCorners, image.width, image.height);
  let hash = 0x811c9dc5;
  let pixelCount = 0;
  const sample = [];
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      if (!pointInConvexPolygon(x + 0.5, y + 0.5, insetCorners)) continue;
      const offset = (y * image.width + x) * image.channels;
      for (let channel = 0; channel < image.channels; channel += 1) {
        const byte = image.pixels[offset + channel];
        hash = fnv1aByte(hash, byte);
        sample.push(byte);
      }
      if (image.channels === 3) hash = fnv1aByte(hash, 255);
      pixelCount += 1;
    }
  }
  verify(pixelCount > 0, 'Projected MFD quad contains no physical PNG pixels.', {
    corners,
    insetCorners,
    bounds,
  });
  const result = {
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    pixelCount,
    bounds,
    corners: corners.map(({ x, y }) => [roundPixel(x), roundPixel(y)]),
    insetCorners: insetCorners.map(({ x, y }) => [roundPixel(x), roundPixel(y)]),
  };
  Object.defineProperty(result, 'sample', {
    value: Uint8Array.from(sample),
    enumerable: false,
  });
  Object.defineProperty(result, 'sampleChannels', {
    value: image.channels,
    enumerable: false,
  });
  return result;
}

function hashPixelRect(image, requestedBounds) {
  const x = Math.max(0, Math.min(image.width - 1, requestedBounds.x));
  const y = Math.max(0, Math.min(image.height - 1, requestedBounds.y));
  const width = Math.max(1, Math.min(image.width - x, requestedBounds.width));
  const height = Math.max(1, Math.min(image.height - y, requestedBounds.height));
  let hash = 0x811c9dc5;
  let pixelCount = 0;
  const sample = [];
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      const offset = (py * image.width + px) * image.channels;
      for (let channel = 0; channel < image.channels; channel += 1) {
        const byte = image.pixels[offset + channel];
        hash = fnv1aByte(hash, byte);
        sample.push(byte);
      }
      if (image.channels === 3) hash = fnv1aByte(hash, 255);
      pixelCount += 1;
    }
  }
  const result = {
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    pixelCount,
    bounds: { x, y, width, height },
  };
  Object.defineProperty(result, 'sample', {
    value: Uint8Array.from(sample),
    enumerable: false,
  });
  Object.defineProperty(result, 'sampleChannels', {
    value: image.channels,
    enumerable: false,
  });
  return result;
}

function comparePixelSamples(left, right) {
  verify(left.pixelCount === right.pixelCount
    && left.sampleChannels === right.sampleChannels
    && left.sample?.length === right.sample?.length,
  'Pixel-difference samples do not have identical physical shapes.', {
    left: { pixelCount: left.pixelCount, channels: left.sampleChannels, bytes: left.sample?.length },
    right: { pixelCount: right.pixelCount, channels: right.sampleChannels, bytes: right.sample?.length },
  });
  let totalAbs = 0;
  let maxChannelDelta = 0;
  let changedChannels = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < left.sample.length; offset += left.sampleChannels) {
    let pixelChanged = false;
    for (let channel = 0; channel < left.sampleChannels; channel += 1) {
      const delta = Math.abs(left.sample[offset + channel] - right.sample[offset + channel]);
      totalAbs += delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (delta > 0) {
        changedChannels += 1;
        pixelChanged = true;
      }
    }
    if (pixelChanged) changedPixels += 1;
  }
  const channelCount = left.sample.length;
  const meanAbs = channelCount > 0 ? totalAbs / channelCount : 0;
  return {
    pixels: left.pixelCount,
    channels: left.sampleChannels,
    totalAbs,
    meanAbs,
    normalizedMeanAbs: meanAbs / 255,
    maxChannelDelta,
    normalizedMaxChannelDelta: maxChannelDelta / 255,
    changedChannels,
    changedPixels,
    changedFraction: left.pixelCount > 0 ? changedPixels / left.pixelCount : 0,
  };
}

function polygonBounds(points, imageWidth, imageHeight) {
  const minX = Math.max(0, Math.floor(Math.min(...points.map(({ x }) => x))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map(({ y }) => y))));
  const maxX = Math.min(imageWidth, Math.ceil(Math.max(...points.map(({ x }) => x))));
  const maxY = Math.min(imageHeight, Math.ceil(Math.max(...points.map(({ y }) => y))));
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

function pointInConvexPolygon(x, y, points) {
  let sign = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = (next.x - current.x) * (y - current.y)
      - (next.y - current.y) * (x - current.x);
    if (Math.abs(cross) <= 1e-7) continue;
    const nextSign = Math.sign(cross);
    if (sign !== 0 && nextSign !== sign) return false;
    sign = nextSign;
  }
  return true;
}

function fnv1aByte(hash, byte) {
  return Math.imul(hash ^ byte, 0x01000193) >>> 0;
}

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

function roundPixel(value) {
  return Math.round(value * 1_000) / 1_000;
}

function vectorDistance(left, right) {
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

function isNanumFontUrl(value) {
  return /NanumSquareNeo[^?#]*\.woff2(?:$|[?#])/u.test(value);
}

async function fontLoadCalls(page) {
  return page.evaluate(() => window.__LV_FONT_LOAD_CALLS ?? []);
}

async function overlayFontEvidence(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.lv-root');
    if (!(root instanceof HTMLElement)) throw new Error('Overlay root is missing.');
    const style = getComputedStyle(root);
    return {
      display: style.getPropertyValue('--f-display').trim(),
      mono: style.getPropertyValue('--f-mono').trim(),
      wordmark: document.querySelector('.lv-wordmark') instanceof HTMLElement
        ? getComputedStyle(document.querySelector('.lv-wordmark')).fontFamily
        : '',
    };
  });
}

function fontEvidenceContainsAlias(boot, overlay) {
  const bootValues = (boot ?? []).flatMap((entry) => [
    entry.fontFamily,
    entry.bodyFontFamily,
    entry.display,
    entry.mono,
  ]);
  const overlayValues = overlay ? [overlay.display, overlay.mono, overlay.wordmark] : [];
  return [...bootValues, ...overlayValues]
    .filter((value) => typeof value === 'string')
    .some((value) => value.includes(HANGUL_FONT_ALIAS));
}

async function fontControlSnapshot(page) {
  return page.evaluate(() => {
    if (!window.__LV_FONT_CONTROL) throw new Error('Font load controller is missing.');
    return window.__LV_FONT_CONTROL.snapshot();
  });
}

async function releaseHeldFonts(page) {
  await page.evaluate(async () => {
    if (!window.__LV_FONT_CONTROL) throw new Error('Font load controller is missing.');
    await window.__LV_FONT_CONTROL.releaseAll();
  });
}

async function rejectHeldFonts(page, message) {
  await page.evaluate(async (controlledMessage) => {
    if (!window.__LV_FONT_CONTROL) throw new Error('Font load controller is missing.');
    await window.__LV_FONT_CONTROL.rejectAll(controlledMessage);
  }, message);
}

async function hudEventSnapshot(page) {
  const telemetry = await callHarness(page, 'telemetry');
  const dom = await page.evaluate(() => {
    const englishTokens = (node) => Array.from(node?.querySelectorAll(':scope > span[lang="en"]') ?? [],
      (token) => token.textContent ?? '');
    const callout = document.querySelector('.lv-callout');
    const hud = document.querySelector('.lv-hud');
    const title = document.querySelector('.lv-callout-t');
    const sub = document.querySelector('.lv-callout-s');
    const logNodes = Array.from(document.querySelectorAll('.lv-log-line'));
    return {
      calloutTitle: title?.textContent ?? '',
      calloutSub: sub?.textContent ?? '',
      calloutTitleTokens: englishTokens(title),
      calloutSubTokens: englishTokens(sub),
      calloutOn: callout?.getAttribute('data-on') ?? null,
      calloutAriaHidden: callout?.getAttribute('aria-hidden') ?? null,
      hudActive: hud?.getAttribute('data-active') ?? null,
      countdownActive: hud?.getAttribute('data-countdown') ?? null,
      logs: logNodes.map((node) => node.textContent ?? ''),
      logTokens: logNodes.map((node) => englishTokens(node)),
      calloutKeys: window.__LV?.telemetry().callout
        ? Object.keys(window.__LV.telemetry().callout)
        : [],
      logKeys: window.__LV?.telemetry().log.map((line) => Object.keys(line)) ?? [],
      splitFeed: Array.from(document.querySelectorAll('.lv-splitfeed-row'), (row) => {
        const field = (selector) => {
          const node = row.querySelector(selector);
          return {
            text: node?.textContent ?? '',
            lang: node?.getAttribute('lang') ?? null,
          };
        };
        return {
          index: field('.lv-splitfeed-i'),
          time: field('.lv-splitfeed-t'),
          duration: field('.lv-splitfeed-d'),
        };
      }),
    };
  });
  return { telemetry, dom };
}

function captureAssertionFailure(operation) {
  try {
    operation();
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return null;
}

function independentRunTime(seconds) {
  const totalCentiseconds = Math.floor(seconds * 100);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const wholeSeconds = Math.floor(totalCentiseconds / 100) % 60;
  const centiseconds = totalCentiseconds % 100;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

async function pageTextSnapshot(page) {
  return page.evaluate(() => {
    const snapshot = (node) => ({
      textContent: node?.textContent ?? '',
      childElementCount: node?.childElementCount ?? null,
      lang: node?.getAttribute('lang') ?? null,
    });
    const calloutTitleNode = snapshot(document.querySelector('.lv-callout-t'));
    const calloutSubNode = snapshot(document.querySelector('.lv-callout-s'));
    const logNodes = Array.from(document.querySelectorAll('.lv-log-line'), snapshot);
    return {
      calloutTitle: calloutTitleNode.textContent,
      calloutSub: calloutSubNode.textContent,
      calloutTitleNode,
      calloutSubNode,
      logs: logNodes.map((node) => node.textContent),
      logNodes,
      gateName: document.querySelector('.lv-gatename')?.textContent ?? '',
      gateLang: document.querySelector('.lv-gatename')?.getAttribute('lang') ?? null,
    };
  });
}

function assertCalloutEvent(locale, snapshot, expected) {
  const callout = snapshot.telemetry.callout;
  const evidence = { locale, snapshot, expected };
  verify(callout !== null, `${locale} event did not produce a callout.`, evidence);
  verify(callout.title === expected.legacyTitle && callout.sub === expected.legacySub,
    `${locale} event changed an independent legacy English callout fixture.`, evidence);
  verify(JSON.stringify(callout.titleMessage) === JSON.stringify(expected.titleMessage)
    && JSON.stringify(callout.subMessage) === JSON.stringify(expected.subMessage),
  `${locale} event attached the wrong descriptor.`, evidence);
  const expectedAriaHidden = snapshot.dom.hudActive === '1'
    && snapshot.dom.countdownActive !== '1' && snapshot.dom.calloutOn === '1'
    ? null
    : 'true';
  verify(snapshot.dom.calloutTitle === expected.dom[0]
    && snapshot.dom.calloutSub === expected.dom[1] && snapshot.dom.calloutOn === '1'
    && snapshot.dom.calloutAriaHidden === expectedAriaHidden,
  `${locale} event rendered the wrong localized callout DOM.`, evidence);
  const expectedTokens = expected.domTokens ?? [[], []];
  verify(JSON.stringify([snapshot.dom.calloutTitleTokens, snapshot.dom.calloutSubTokens])
    === JSON.stringify(expectedTokens),
  `${locale} callout embedded-English token structure differs.`, evidence);
  verify(JSON.stringify(snapshot.dom.calloutKeys)
    === JSON.stringify(['id', 'title', 'titleMessage', 'sub', 'subMessage', 'tone', 'ttl', 'ttlMax']),
  `${locale} callout does not use the stable explicit optional-field shape.`, evidence);
}

function assertPointerEvent(locale, snapshot, reason) {
  assertCalloutEvent(locale, snapshot, {
    legacyTitle: 'MOUSE CAPTURE UNAVAILABLE',
    legacySub: 'W A S D / ARROWS STILL FLY',
    titleMessage: { type: 'callout-title.pointer-lock-unavailable' },
    subMessage: { type: 'callout-sub.keyboard-flight-available' },
    dom: EVENT_COPY[locale].pointer,
    domTokens: locale === 'ko' ? [[], ['W A S D']] : [[], []],
  });
  const line = snapshot.telemetry.log.find(({ message }) => message?.type === 'log.pointer-lock-refused');
  const index = snapshot.telemetry.log.indexOf(line);
  const expectedLegacy = `mouse capture refused · ${reason}`;
  const expectedDom = locale === 'ko'
    ? `마우스 고정 거부 · ${reason}`
    : expectedLegacy;
  verify(line?.text === expectedLegacy
    && JSON.stringify(line?.message) === JSON.stringify({ type: 'log.pointer-lock-refused', reason })
    && snapshot.dom.logs[index] === expectedDom
    && snapshot.dom.logTokens[index]?.length === 0,
  `${locale} pointer-refusal log descriptor, legacy field, or DOM differs.`, { snapshot, reason });
  verify(JSON.stringify(snapshot.dom.logKeys[index])
    === JSON.stringify(['id', 'text', 'message', 'tone', 'age']),
  `${locale} pointer log does not use the stable explicit optional-field shape.`, snapshot);
}

function assertImpactEvent(locale, snapshot, before, staged) {
  const callout = snapshot.telemetry.callout;
  const line = [...snapshot.telemetry.log].reverse()
    .find(({ message }) => message?.type === 'log.hull-contact');
  const index = snapshot.telemetry.log.indexOf(line);
  const hullDamage = before.hull - snapshot.telemetry.hull;
  const expectedSeverity = hullDamage / STAGED_FULL_SEVERITY_HULL_DAMAGE;
  const expectedPercent = Math.round(expectedSeverity * 100);
  const priorHullContacts = before.log
    .filter(({ message }) => message?.type === 'log.hull-contact').length;
  const currentHullContacts = snapshot.telemetry.log
    .filter(({ message }) => message?.type === 'log.hull-contact').length;
  const evidence = {
    locale,
    snapshot,
    before,
    staged,
    line,
    hullDamage,
    expectedSeverity,
    expectedPercent,
    priorHullContacts,
    currentHullContacts,
  };
  verify(priorHullContacts === 0 && currentHullContacts === 1
    && hullDamage > 0 && hullDamage <= STAGED_FULL_SEVERITY_HULL_DAMAGE
    && expectedSeverity > 0 && expectedSeverity <= 1 && staged.closingSpeed > 0,
  `${locale} staged collision did not produce the independent single-impact hull delta.`, evidence);
  assertCalloutEvent(locale, snapshot, {
    legacyTitle: 'HULL IMPACT',
    legacySub: undefined,
    titleMessage: { type: 'callout-title.hull-impact' },
    subMessage: undefined,
    dom: [EVENT_COPY[locale].hullTitle, ''],
  });
  verify(JSON.stringify(line?.message)
    === JSON.stringify({ type: 'log.hull-contact', percent: expectedPercent }),
  `${locale} hull-contact descriptor percent differs from physical hull-delta evidence.`, evidence);
  const legacy = `hull contact · ${expectedPercent}%`;
  const localized = legacy;
  verify(line?.text === legacy && snapshot.dom.logs[index] === localized,
    `${locale} hull-contact legacy bytes or localized DOM differ.`, evidence);
  return { hullDamage, expectedSeverity, expectedPercent };
}

function assertBoostEvent(locale, snapshot) {
  assertCalloutEvent(locale, snapshot, {
    legacyTitle: 'DRIVE DRY',
    legacySub: 'RESERVE RECHARGING',
    titleMessage: { type: 'callout-title.boost-depleted' },
    subMessage: { type: 'callout-sub.boost-recharging' },
    dom: EVENT_COPY[locale].boost,
  });
  const line = [...snapshot.telemetry.log].reverse()
    .find(({ message }) => message?.type === 'log.boost-depleted');
  const index = snapshot.telemetry.log.indexOf(line);
  verify(line?.text === 'overdrive reserve depleted'
    && JSON.stringify(line?.message) === JSON.stringify({ type: 'log.boost-depleted' })
    && snapshot.dom.logs[index] === 'overdrive reserve depleted',
  `${locale} boost-depletion log descriptor, legacy field, or DOM differs.`, snapshot);
}

async function collectGateEventFlow(page, options) {
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
  const callouts = [];
  const logs = [];
  const seenCallouts = new Set();
  const seenLogs = new Set();
  const maxFrames = Math.ceil((options.maxSimSeconds ?? 300) * 60);
  let frames = 0;
  try {
    while (frames < maxFrames) {
      const phase = await callHarness(page, 'phase');
      if (phase === 'finished') break;
      verify(phase !== 'failed', 'Autopilot failed during gate descriptor collection.', { phase, frames });
      await callHarness(page, 'step', [60, 1 / 60], options.timeoutMs);
      frames += 60;
      const snapshot = await hudEventSnapshot(page);
      const callout = snapshot.telemetry.callout;
      if (callout?.titleMessage?.type === 'callout-title.gate-cleared'
        && !seenCallouts.has(callout.id)) {
        seenCallouts.add(callout.id);
        const historyAtCallout = await callHarness(page, 'gateHistory');
        callouts.push({
          callout,
          dom: [snapshot.dom.calloutTitle, snapshot.dom.calloutSub],
          domTokens: [snapshot.dom.calloutTitleTokens, snapshot.dom.calloutSubTokens],
          courseTotal: snapshot.telemetry.gate.total,
          observedNextIndex: snapshot.telemetry.gate.index,
          pass: historyAtCallout.at(-1),
          source: 'course-run',
          splitFeed: snapshot.dom.splitFeed,
        });
      }
      for (let index = 0; index < snapshot.telemetry.log.length; index++) {
        const line = snapshot.telemetry.log[index];
        if (!line.message || seenLogs.has(line.id)) continue;
        if (line.message.type === 'log.gate-cleared' || line.message.type === 'log.gate-missed') {
          seenLogs.add(line.id);
          logs.push({
            line,
            dom: snapshot.dom.logs[index],
            tokens: snapshot.dom.logTokens[index],
          });
        }
      }
    }
  } finally {
    await callHarness(page, 'setAutopilot', [false]);
  }
  const phase = await callHarness(page, 'phase');
  verify(phase === 'finished', 'Gate descriptor collection did not complete the production course.', {
    phase,
    frames,
  });
  const history = await callHarness(page, 'gateHistory');
  const finalSplits = (await callHarness(page, 'telemetry')).splits;

  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'seekCourse', [0.599]);
  await callHarness(page, 'setInput', [{ throttle: 1 }]);
  let deadCentre = null;
  try {
    for (let attemptFrames = 0; attemptFrames < 120 && deadCentre === null; attemptFrames += 1) {
      await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
      const snapshot = await hudEventSnapshot(page);
      if (snapshot.telemetry.callout?.titleMessage?.type === 'callout-title.gate-cleared'
        && snapshot.telemetry.callout.titleMessage.accuracy === 'dead-centre') {
        const history = await callHarness(page, 'gateHistory');
        deadCentre = {
          callout: snapshot.telemetry.callout,
          dom: [snapshot.dom.calloutTitle, snapshot.dom.calloutSub],
          domTokens: [snapshot.dom.calloutTitleTokens, snapshot.dom.calloutSubTokens],
          courseTotal: snapshot.telemetry.gate.total,
          observedNextIndex: snapshot.telemetry.gate.index,
          pass: history.at(-1),
          seek: 0.599,
          source: 'gate-six-centreline',
          splitFeed: snapshot.dom.splitFeed,
        };
      }
    }
  } finally {
    await callHarness(page, 'setInput', [null]);
  }
  verify(deadCentre !== null && deadCentre.pass?.index === 5
    && deadCentre.pass.radialDistance < 1,
  'The deterministic gate-six centreline flight did not exercise a sub-metre dead-centre pass.', {
    deadCentre,
  });
  callouts.push(deadCentre);

  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
  const missTargetTelemetry = await callHarness(page, 'telemetry');
  const missTarget = {
    index: missTargetTelemetry.gate.index,
    total: missTargetTelemetry.gate.total,
    name: missTargetTelemetry.gate.name,
  };
  await callHarness(page, 'setInput', [{ throttle: 1, strafeX: 1 }]);
  let missed = null;
  try {
    for (let attemptFrames = 0; attemptFrames < 3600 && missed === null; attemptFrames += 30) {
      await callHarness(page, 'step', [30, 1 / 60], options.timeoutMs);
      const snapshot = await hudEventSnapshot(page);
      if (snapshot.telemetry.callout?.titleMessage?.type === 'callout-title.gate-missed') {
        missed = snapshot;
      }
    }
  } finally {
    await callHarness(page, 'setInput', [null]);
  }
  verify(missed !== null, 'A laterally offset production flight did not exercise the gate-miss boundary.');
  return { frames, callouts, logs, history, finalSplits, deadCentre, missTarget, missed };
}

function assertGateEventFlow(locale, flow) {
  const evidence = { locale, flow };
  const accuracies = new Set();
  const remaining = new Set();
  const splitRowsVerified = [];
  for (const {
    callout,
    dom,
    domTokens,
    courseTotal,
    observedNextIndex,
    pass,
    source,
    splitFeed,
  } of flow.callouts) {
    const accuracy = callout.titleMessage?.accuracy;
    verify(pass?.cleared === true && observedNextIndex === pass.index + 1,
      `${locale} gate callout does not correlate to the independently observed physical pass.`, {
        callout,
        courseTotal,
        observedNextIndex,
        pass,
        source,
      });
    const expectedRemaining = courseTotal - (pass.index + 1);
    accuracies.add(accuracy);
    if (expectedRemaining === 0 || expectedRemaining === 1 || expectedRemaining === 2) {
      remaining.add(expectedRemaining);
    }
    const expectedLegacyTitle = EVENT_COPY.en.accuracies[accuracy];
    const expectedLegacySub = expectedRemaining > 0
      ? `${expectedRemaining} CAIRN${expectedRemaining === 1 ? '' : 'S'} REMAINING`
      : 'TERMINUS AHEAD';
    const expectedLocalizedSub = expectedLegacySub;
    verify(JSON.stringify(callout.subMessage) === JSON.stringify({
      type: 'callout-sub.gate-progress',
      remaining: expectedRemaining,
    }), `${locale} remaining descriptor differs from course-total/pass-index evidence.`, {
      callout,
      courseTotal,
      observedNextIndex,
      pass,
      expectedRemaining,
    });
    verify(callout.title === expectedLegacyTitle && callout.sub === expectedLegacySub,
      `${locale} gate pass changed an independent legacy English fixture.`, { callout, dom });
    verify(dom[0] === EVENT_COPY[locale].accuracies[accuracy] && dom[1] === expectedLocalizedSub,
      `${locale} gate accuracy DOM does not match its exact localized fixture.`, { callout, dom });
    const expectedSubTokens = locale === 'ko'
      ? [expectedRemaining > 0 ? 'CAIRN' : 'TERMINUS']
      : [];
    verify(JSON.stringify(domTokens) === JSON.stringify([[], expectedSubTokens]),
      `${locale} gate callout embedded-English token structure differs.`, {
        callout,
        dom,
        domTokens,
        expectedSubTokens,
      });
    if (expectedRemaining === 0 || expectedRemaining === 1 || expectedRemaining === 2) {
      verify(dom[1] === EVENT_COPY[locale].progress[expectedRemaining],
        `${locale} remaining ${expectedRemaining} DOM does not match its exact localized fixture.`, {
          callout,
          dom,
          expectedRemaining,
        });
    }

    if (source === 'course-run') {
      const row = splitFeed.at(-1);
      const previousPass = flow.history.find(({ index }) => index === pass.index - 1);
      const expectedSplit = {
        index: String(pass.index + 1).padStart(2, '0'),
        time: independentRunTime(pass.time),
        duration: (pass.time - (previousPass?.time ?? 0)).toFixed(2),
      };
      verify(row !== undefined
        && row.index.text === expectedSplit.index
        && row.time.text === expectedSplit.time
        && row.duration.text === expectedSplit.duration,
      `${locale} split-feed content does not match independent gate-history evidence.`, {
        row,
        expectedSplit,
        pass,
        previousPass,
      });
      verify(row.index.lang === 'en' && row.time.lang === 'en' && row.duration.lang === 'en',
        `${locale} split-feed numeric/time nodes are missing lang=en.`, { row, expectedSplit });
      splitRowsVerified.push({ pass, previousPass, row, expectedSplit });
    }
  }
  verify(JSON.stringify([...accuracies].sort())
    === JSON.stringify(['clean', 'cleared', 'dead-centre']),
  `${locale} production paths did not exercise all three gate accuracy descriptors.`, evidence);
  verify(JSON.stringify([...remaining].sort()) === JSON.stringify([0, 1, 2]),
    `${locale} production paths did not exercise remaining 0/1/2.`, evidence);
  const clearLogs = flow.logs.filter(({ line }) => line.message?.type === 'log.gate-cleared');
  verify(clearLogs.length === 9 && flow.history.length === 9 && flow.finalSplits.length === 9,
    `${locale} did not retain nine independently correlatable gate-clear events.`, evidence);
  for (let index = 0; index < clearLogs.length; index++) {
    const { line, dom, tokens } = clearLogs[index];
    const pass = flow.history[index];
    const expectedGate = pass.index + 1;
    const expectedSeconds = pass.time;
    const padded = String(expectedGate).padStart(2, '0');
    verify(flow.finalSplits[index] === expectedSeconds,
      `${locale} split telemetry diverged from gate-history time.`, { index, pass, finalSplits: flow.finalSplits });
    verify(JSON.stringify(line.message) === JSON.stringify({
      type: 'log.gate-cleared',
      gate: expectedGate,
      seconds: expectedSeconds,
    }), `${locale} gate-clear log parameters differ from gate-history evidence.`, {
      index,
      line,
      pass,
      expectedGate,
      expectedSeconds,
    });
    verify(line.text === `cairn ${padded} · ${expectedSeconds.toFixed(2)}s`,
      `${locale} gate log changed padding or seconds.toFixed(2) legacy bytes.`, { line, dom, pass });
    verify(dom === line.text, `${locale} gate-clear log DOM differs.`, { line, dom, pass });
    verify(JSON.stringify(tokens ?? []) === JSON.stringify([]),
    `${locale} gate-clear log embedded-English token structure differs.`, {
      line,
      dom,
      tokens,
    });
  }
  assertCalloutEvent(locale, flow.missed, {
    legacyTitle: 'MISSED',
    legacySub: 'REALIGN AND RE-ENTER',
    titleMessage: { type: 'callout-title.gate-missed' },
    subMessage: { type: 'callout-sub.gate-realign' },
    dom: EVENT_COPY[locale].missed,
  });
  const missLine = flow.missed.telemetry.log.find(({ message }) => message?.type === 'log.gate-missed');
  const missIndex = flow.missed.telemetry.log.indexOf(missLine);
  const expectedMissGate = flow.missTarget.index + 1;
  const padded = String(expectedMissGate).padStart(2, '0');
  verify(flow.missed.telemetry.gate.index === flow.missTarget.index
    && flow.missed.telemetry.gate.total === flow.missTarget.total,
  `${locale} miss did not remain on the independently staged target gate.`, evidence);
  verify(JSON.stringify(missLine?.message)
    === JSON.stringify({ type: 'log.gate-missed', gate: expectedMissGate }),
  `${locale} gate-miss log parameter differs from the independently staged gate.`, evidence);
  verify(missLine?.text === `cairn ${padded} missed`
    && flow.missed.dom.logs[missIndex] === missLine.text,
  `${locale} gate-miss log descriptor or exact formatting differs.`, evidence);
  verify(JSON.stringify(flow.missed.dom.logTokens[missIndex] ?? [])
    === JSON.stringify([]),
  `${locale} gate-miss log embedded-English token structure differs.`, evidence);
  verify(splitRowsVerified.length > 0,
    `${locale} no real gate pass exposed an independently checked split-feed row.`, evidence);
  return { splitRowsVerified };
}

async function gateNameSnapshot(page) {
  return page.evaluate(() => {
    const gate = window.__LV?.telemetry().gate;
    const node = document.querySelector('.lv-gatename');
    return {
      index: gate?.index,
      name: gate?.name,
      nameMessage: gate?.nameMessage,
      domText: node?.textContent ?? '',
      domLang: node?.getAttribute('lang') ?? null,
      domTokens: Array.from(node?.querySelectorAll(':scope > span[lang="en"]') ?? [],
        (token) => token.textContent ?? ''),
    };
  });
}

async function radioSnapshot(page) {
  return page.evaluate(() => {
    const radio = document.querySelector('.lv-radio');
    const text = document.querySelector('.lv-radio-text');
    return {
      on: radio?.getAttribute('data-on') ?? null,
      ariaHidden: radio?.getAttribute('aria-hidden') ?? null,
      speaker: document.querySelector('.lv-radio-who')?.textContent ?? '',
      speakerLang: document.querySelector('.lv-radio-who')?.getAttribute('lang') ?? null,
      text: text?.textContent ?? '',
      textTokens: Array.from(text?.querySelectorAll(':scope > span[lang="en"]') ?? [],
        (token) => token.textContent ?? ''),
    };
  });
}

async function collectRadioFlow(page, options) {
  const lines = [];
  const seen = new Set();
  let calloutLocaleText = null;
  let firstAccuracy = null;
  const capture = async () => {
    const radio = await radioSnapshot(page);
    const key = `${radio.speaker}\n${radio.text}`;
    if (radio.on === '1' && radio.text && !seen.has(key)) {
      seen.add(key);
      lines.push({ speaker: radio.speaker, text: radio.text, tokens: radio.textTokens });
    }
    const event = await hudEventSnapshot(page);
    if (firstAccuracy === null && event.telemetry.callout?.titleMessage?.type === 'callout-title.gate-cleared') {
      firstAccuracy = event.telemetry.callout.titleMessage.accuracy;
      calloutLocaleText = event.dom.calloutTitle;
    }
  };
  await capture();
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
  const maxFrames = Math.ceil((options.maxSimSeconds ?? 300) * 60);
  let frames = 0;
  try {
    while (frames < maxFrames && await callHarness(page, 'phase') !== 'finished') {
      await callHarness(page, 'step', [60, 1 / 60], options.timeoutMs);
      frames += 60;
      await capture();
    }
  } finally {
    await callHarness(page, 'setAutopilot', [false]);
  }
  verify(await callHarness(page, 'phase') === 'finished',
    'Radio collection did not finish the production run.', { frames, lines });
  return { frames, lines, firstAccuracy, calloutLocaleText };
}

async function hudStaticSnapshot(page) {
  return page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent ?? '';
    const meter = (selector) => {
      const node = document.querySelector(selector);
      return {
        role: node?.getAttribute('role') ?? null,
        label: node?.getAttribute('aria-label') ?? null,
        min: node?.getAttribute('aria-valuemin') ?? null,
        max: node?.getAttribute('aria-valuemax') ?? null,
        now: node?.getAttribute('aria-valuenow') ?? null,
        text: node?.getAttribute('aria-valuetext') ?? null,
      };
    };
    const boost = document.querySelector('.lv-bar--boost');
    const caption = boost?.querySelector('.lv-bar-cap');
    const latinSelectors = [
      '.lv-sector', '.lv-fps-k', '.lv-fps-v', '.lv-thr-pct', '.lv-readout--speed',
      '.lv-speed-u', '.lv-gload', '.lv-roll--gate', '.lv-gatecount-s', '.lv-gatecount-t',
      '.lv-time-v', '.lv-rail-dest', '.lv-radio-who', '.lv-gatetag-n', '.lv-gatetag-u',
    ];
    return {
      inputMode: text('.lv-inputmode'),
      labels: [
        text('.lv-thr-k'),
        text('.lv-bar--boost .lv-bar-k'),
        text('.lv-bar--hull .lv-bar-k'),
        ...Array.from(document.querySelectorAll('.lv-time-k'), (node) => node.textContent ?? ''),
        text('.lv-right-k'),
        text('.lv-rail-keys > span:first-child'),
      ],
      boost: {
        title: caption?.getAttribute('title') ?? '',
        caption: caption?.textContent ?? '',
        captionLang: caption?.getAttribute('lang') ?? null,
        aria: boost?.getAttribute('aria-label') ?? '',
        usableSeconds: boost?.getAttribute('data-usable-seconds') ?? null,
        rearmPercent: boost?.getAttribute('data-rearm-percent') ?? null,
        availability: boost?.getAttribute('data-availability') ?? null,
      },
      meters: {
        throttle: meter('.lv-thr'),
        boost: meter('.lv-bar--boost'),
        hull: meter('.lv-bar--hull'),
      },
      accessibility: {
        rootHidden: document.querySelector('.lv-hud')?.getAttribute('aria-hidden') ?? null,
        flightRegions: [
          '.lv-gatetag', '.lv-top', '.lv-left', '.lv-right', '.lv-log', '.lv-rail',
        ].map((selector) => ({
          selector,
          hidden: document.querySelector(selector)?.getAttribute('aria-hidden') ?? null,
        })),
        callout: {
          on: document.querySelector('.lv-callout')?.getAttribute('data-on') ?? null,
          hidden: document.querySelector('.lv-callout')?.getAttribute('aria-hidden') ?? null,
        },
        radio: {
          on: document.querySelector('.lv-radio')?.getAttribute('data-on') ?? null,
          hidden: document.querySelector('.lv-radio')?.getAttribute('aria-hidden') ?? null,
        },
      },
      latin: latinSelectors.map((selector) => ({
        selector,
        values: Array.from(document.querySelectorAll(selector), (node) => ({
          text: node.textContent ?? '',
          lang: node.getAttribute('lang'),
        })),
      })),
      raw: {
        throttle: text('.lv-thr-pct'),
        speed: text('.lv-readout--speed'),
        speedUnit: text('.lv-speed-u'),
        gLoad: text('.lv-gload'),
        gateTotal: text('.lv-gatecount-t'),
        times: Array.from(document.querySelectorAll('.lv-time-v'), (node) => node.textContent ?? ''),
        gateTag: [text('.lv-gatetag-n'), text('.lv-gatetag-u')],
      },
    };
  });
}

function assertHudStatic(locale, hidden, available, locked) {
  const expected = HUD_COPY[locale];
  const evidence = { locale, expected, hidden, available, locked };
  verify(available.inputMode === expected.inputMode
    && JSON.stringify(available.labels) === JSON.stringify(expected.labels),
  `${locale} static HUD labels differ from independent fixtures.`, evidence);
  verify(available.boost.title === expected.capacityTitle
    && available.boost.caption === '3.2S'
    && available.boost.captionLang === 'en'
    && available.boost.aria === expected.usableAria
    && available.boost.usableSeconds === String(92 / 29)
    && available.boost.rearmPercent === '45'
    && available.boost.availability === 'available',
  `${locale} usable boost caption/title/ARIA differs.`, evidence);
  verify(locked.boost.title === expected.capacityTitle
    && locked.boost.caption === expected.lockedCaption
    && locked.boost.captionLang === 'en'
    && locked.boost.aria === expected.lockedAria
    && locked.boost.availability === 'unavailable',
  `${locale} locked boost caption/ARIA or dynamic lang differs.`, evidence);
  for (const entry of available.latin) {
    verify(entry.values.length > 0 && entry.values.every(({ lang }) => lang === 'en'),
      `${locale} Latin-only HUD nodes are missing lang=en.`, { entry, evidence });
  }

  const expectedMeterText = (percent) => locale === 'ko' ? `${percent}%` : `${percent} percent`;
  for (const [name, snapshot] of Object.entries(available.meters)) {
    const percent = Number(snapshot.now);
    const expectedLabel = name === 'throttle' ? expected.meterLabels.throttle
      : name === 'hull' ? expected.meterLabels.hull : expected.usableAria;
    verify(snapshot.role === 'meter' && snapshot.min === '0' && snapshot.max === '100'
      && snapshot.label === expectedLabel && Number.isInteger(percent)
      && percent >= 0 && percent <= 100 && snapshot.text === expectedMeterText(percent),
    `${locale} ${name} meter semantics differ.`, { name, snapshot, evidence });
  }
  const lockedBoostPercent = Number(locked.meters.boost.now);
  verify(locked.meters.boost.role === 'meter'
    && locked.meters.boost.label === expected.lockedAria
    && Number.isInteger(lockedBoostPercent)
    && locked.meters.boost.text === expectedMeterText(lockedBoostPercent),
  `${locale} locked boost meter semantics differ.`, evidence);
  verify(hidden.accessibility.rootHidden === null
    && hidden.accessibility.flightRegions.every(({ hidden: value }) => value === 'true')
    && hidden.accessibility.callout.hidden === 'true'
    && hidden.accessibility.radio.hidden === 'true',
  `${locale} inactive HUD accessibility state exposes stale flight or radio copy.`, evidence);
  verify(available.accessibility.rootHidden === null
    && available.accessibility.flightRegions.every(({ hidden: value }) => value === null)
    && available.accessibility.callout.hidden === 'true'
    && available.accessibility.radio.on === '1'
    && available.accessibility.radio.hidden === null,
  `${locale} active HUD accessibility state does not mirror visible regions.`, evidence);
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
    const actions = () => Object.fromEntries(
      Array.from(view.querySelectorAll('[data-action]'))
        .filter((node) => node.closest('[hidden]') === null)
        .map((node) => [
          node.getAttribute('data-action'),
          node.querySelector('.lv-btn-t')?.textContent ?? '',
        ]),
    );
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
      return: text('[data-action="return"] .lv-btn-t'),
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
      actions: Array.from(view.querySelectorAll('[data-action]'))
        .filter((node) => node.closest('[hidden]') === null)
        .map((node) => node.getAttribute('data-action')),
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
  const boundaries = await page.evaluate(() => {
    const effectiveLang = (selector) => {
      const node = document.querySelector(selector);
      return node instanceof HTMLElement ? node.closest('[lang]')?.getAttribute('lang') ?? '' : null;
    };
    const englishSelectors = {
      titleEyebrow: '.lv-title-eyebrow',
      titleAction: '[data-view="title"] [data-action="begin"] .lv-btn-t',
      titleFooter: '.lv-title-foot',
      settingLabel: '[data-view="settings"] [data-setting="cameraMode"] .lv-set-label',
      settingEnum: '[data-view="settings"] [data-setting="cameraMode"]',
      settingSwitch: '[data-view="settings"] [data-setting="invertY"]',
      settingSlider: '[data-view="settings"] [data-setting="fov"]',
      controlsTitle: '[data-view="controls"] .lv-panel-title',
      briefingKicker: '[data-view="briefing"] .lv-brief-head .lv-kicker',
    };
    const koreanSelectors = {
      tagline: '[data-view="title"] .lv-tagline',
      settingHint: '[data-view="settings"] [data-setting="cameraMode"] .lv-set-hint',
      controlDescription: '[data-view="controls"] [data-control="camera-toggle"] .lv-key-d',
      briefingProse: '[data-view="briefing"] .lv-prose-l:first-child',
    };
    return {
      documentLang: document.documentElement.lang,
      english: Object.entries(englishSelectors)
        .filter(([, selector]) => effectiveLang(selector) === 'en')
        .map(([name]) => name),
      korean: Object.entries(koreanSelectors)
        .filter(([, selector]) => effectiveLang(selector) === 'ko')
        .map(([name]) => name),
      localeButtons: [...document.querySelectorAll('[data-view="title"] [data-locale]')]
        .map((node) => ({
          locale: node.getAttribute('data-locale'),
          text: node.textContent?.trim() ?? '',
          lang: node.getAttribute('lang'),
        })),
    };
  });
  return { tagline, briefingLine1, briefingLine2, cameraHint, pointerNote, boundaries };
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
    && Number.isInteger(state?.settingsSubscribers)
    && ['not-required', 'ready', 'fallback', 'failed'].includes(state?.fontStatus),
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
    for (const [kind, selector] of [
      ['loader', '.lv-loader'],
      ['overlay', '.lv-root'],
      ['fatal', '.lv-fatal'],
    ]) {
      const target = node.matches(selector) ? node : node.querySelector(selector);
      if (!target || seen.has(kind)) continue;
      seen.add(kind);
      const fontTarget = kind === 'loader'
        ? target.querySelector('.lv-loader__label') ?? target
        : target;
      const style = getComputedStyle(target);
      window.__LV_BOOT_PROBE.push({
        kind,
        lang: document.documentElement?.lang ?? '',
        text: target.textContent ?? '',
        fontFamily: getComputedStyle(fontTarget).fontFamily,
        bodyFontFamily: document.body ? getComputedStyle(document.body).fontFamily : '',
        display: style.getPropertyValue('--f-display').trim(),
        mono: style.getPropertyValue('--f-mono').trim(),
      });
    }
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) inspect(node);
  }).observe(document, { childList: true, subtree: true });
}

function installFontLoadObserver() {
  const nativeLoad = FontFaceSet.prototype.load;
  window.__LV_FONT_LOAD_CALLS = [];
  FontFaceSet.prototype.load = function observedFontLoad(font, text) {
    window.__LV_FONT_LOAD_CALLS.push({
      font: String(font),
      text: String(text ?? ''),
      argumentCount: arguments.length,
    });
    return Reflect.apply(nativeLoad, this, arguments);
  };
}

function installHeldFontLoads() {
  const nativeLoad = FontFaceSet.prototype.load;
  const calls = [];
  const pending = [];

  FontFaceSet.prototype.load = function controlledFontLoad(font, text) {
    if (!String(font).includes('NanumSquare Neo Hangul')) {
      return nativeLoad.call(this, font, text);
    }
    const call = {
      font: String(font),
      text: String(text ?? ''),
      status: 'held',
      faceCount: null,
      error: null,
    };
    calls.push(call);
    const fontSet = this;
    let resolveOuter;
    let rejectOuter;
    const outer = new Promise((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    const entry = {
      completion: null,
      release() {
        if (entry.completion) return entry.completion;
        call.status = 'released';
        entry.completion = Promise.resolve()
          .then(() => nativeLoad.call(fontSet, font, text))
          .then(
            (faces) => {
              call.status = 'fulfilled';
              call.faceCount = faces.length;
              resolveOuter(faces);
              return { status: 'fulfilled', faceCount: faces.length };
            },
            (error) => {
              call.status = 'rejected';
              call.error = String(error);
              rejectOuter(error);
              return { status: 'rejected', error: String(error) };
            },
          );
        return entry.completion;
      },
      reject(message) {
        if (entry.completion) return entry.completion;
        const error = new Error(message);
        call.status = 'rejected';
        call.error = error.message;
        entry.completion = Promise.resolve().then(() => {
          rejectOuter(error);
          return { status: 'rejected', error: error.message };
        });
        return entry.completion;
      },
    };
    pending.push(entry);
    return outer;
  };

  window.__LV_FONT_CONTROL = {
    async releaseAll() {
      await Promise.all(pending.map((entry) => entry.release()));
    },
    async rejectAll(message) {
      await Promise.all(pending.map((entry) => entry.reject(message)));
    },
    snapshot() {
      return { calls: calls.map((call) => ({ ...call })) };
    },
  };
}

function installEmptyFontResult() {
  const nativeLoad = FontFaceSet.prototype.load;
  const calls = [];
  FontFaceSet.prototype.load = function controlledEmptyFontLoad(font, text) {
    if (!String(font).includes('NanumSquare Neo Hangul')) {
      return Reflect.apply(nativeLoad, this, arguments);
    }
    const call = {
      font: String(font),
      text: String(text ?? ''),
      status: 'loading',
      faceCount: null,
      error: null,
    };
    calls.push(call);
    if (String(font) === '400 1em "NanumSquare Neo Hangul"') {
      call.status = 'empty';
      call.faceCount = 0;
      return Promise.resolve([]);
    }
    return Reflect.apply(nativeLoad, this, arguments).then(
      (faces) => {
        call.status = 'fulfilled';
        call.faceCount = faces.length;
        return faces;
      },
      (error) => {
        call.status = 'rejected';
        call.error = String(error);
        throw error;
      },
    );
  };
  window.__LV_EMPTY_FONT_CONTROL = {
    snapshot() {
      return { calls: calls.map((call) => ({ ...call })) };
    },
  };
}

function installForcedFontFailure() {
  const nativeLoad = FontFaceSet.prototype.load;
  window.__LV_FONT_FAILURE_CALLS = [];
  FontFaceSet.prototype.load = function rejectedFontLoad(font, text) {
    if (!String(font).includes('NanumSquare Neo Hangul')) {
      return nativeLoad.call(this, font, text);
    }
    window.__LV_FONT_FAILURE_CALLS.push({ font: String(font), text: String(text ?? '') });
    return Promise.reject(new Error('forced Korean font failure'));
  };
}

function installWebGL2Failure() {
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function failedWebGl2Context(type, ...args) {
    if (type === 'webgl2') return null;
    return nativeGetContext.call(this, type, ...args);
  };
}

function installPointerLockSuccess() {
  Element.prototype.requestPointerLock = function requestPointerLock() {
    return Promise.resolve();
  };
}

function installPointerLockRefusal() {
  Element.prototype.requestPointerLock = function requestPointerLock() {
    return Promise.reject(new Error('ordinary refusal'));
  };
}

function installHostilePointerLock() {
  Element.prototype.requestPointerLock = function requestPointerLock() {
    return Promise.reject(new Error('<img src=x onerror=window.__LV_INJECTED=1>'));
  };
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
