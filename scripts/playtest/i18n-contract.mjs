import { readFile, readdir } from 'node:fs/promises';

import { Report, parseOptions, verify } from './runtime.mjs';

const EXPECTED_MODULES = [
  'Locale.ts',
  'domain.ts',
  'en.ts',
  'index.ts',
  'ko.ts',
  'messages.ts',
  'typeFixtures.ts',
];

const TOP_LEVEL_SECTIONS = [
  'meta',
  'loader',
  'screens',
  'controls',
  'settings',
  'hud',
  'events',
  'results',
  'cockpit',
  'a11y',
];

const DYNAMIC_ARITIES = new Map([
  ['hud.boostUsable', 1],
  ['hud.boostRecharging', 1],
  ['results.splitDelta', 1],
  ['events.hullContact', 1],
  ['events.gateProgress', 1],
  ['events.gateClearedLog', 2],
  ['events.gateMissedLog', 1],
]);

const options = parseOptions('i18n-contract', process.argv.slice(2));
const report = new Report('i18n-contract', options);
const loaded = new Map();

await report.check(
  {
    id: 'I18N.module-load',
    name: 'Every dependency-free i18n module loads under Node type stripping',
    assertion: 'All expected TypeScript modules exist and import without a browser or build output.',
  },
  async () => {
    const directory = new URL('../../src/i18n/', import.meta.url);
    let names = [];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith('.ts')).sort();
    } catch (error) {
      verify(false, 'src/i18n is unavailable', { error: String(error) });
    }
    verify(
      JSON.stringify(names) === JSON.stringify(EXPECTED_MODULES),
      'src/i18n module set differs from the contract',
      { expected: EXPECTED_MODULES, actual: names },
    );

    const failures = [];
    for (const name of names) {
      try {
        loaded.set(name, await import(new URL(`../../src/i18n/${name}`, import.meta.url)));
      } catch (error) {
        failures.push({ name, error: String(error) });
      }
    }
    verify(failures.length === 0, 'One or more i18n modules failed to import', { failures });
    return { modules: names };
  },
);

await report.check(
  {
    id: 'I18N.catalog-parity',
    name: 'Korean and English catalogs have the same typed shape',
    assertion: 'Keys, leaf types, function arities, marker interpolation, and safe string content match.',
  },
  () => {
    const ko = requireExport('ko.ts', 'ko');
    const en = requireExport('en.ts', 'en');
    verify(
      JSON.stringify(Object.keys(ko)) === JSON.stringify(TOP_LEVEL_SECTIONS),
      'Korean catalog top-level sections are not canonical',
      { actual: Object.keys(ko) },
    );
    verify(
      JSON.stringify(Object.keys(en)) === JSON.stringify(TOP_LEVEL_SECTIONS),
      'English catalog top-level sections are not canonical',
      { actual: Object.keys(en) },
    );

    const leaves = [];
    compareCatalogs(ko, en, '', leaves);
    for (const [path, arity] of DYNAMIC_ARITIES) {
      const koFunction = getPath(ko, path);
      const enFunction = getPath(en, path);
      verify(typeof koFunction === 'function' && typeof enFunction === 'function', `${path} must be dynamic`);
      verify(koFunction.length === arity && enFunction.length === arity, `${path} has the wrong arity`, {
        expected: arity,
        ko: koFunction.length,
        en: enFunction.length,
      });
      const markers = arity === 2 ? [78123, 45.67] : [path.endsWith('splitDelta') ? 'DELTA_MARKER' : 78123];
      for (const [locale, fn] of [['ko', koFunction], ['en', enFunction]]) {
        const rendered = fn(...markers);
        verify(rendered.trim().length > 0, `${locale} ${path} rendered an empty string`);
        verify(!/<\/?[a-z][^>]*>/iu.test(rendered), `${locale} ${path} rendered HTML`);
        for (const marker of markers) {
          verify(rendered.includes(String(marker)), `${locale} ${path} dropped an interpolation marker`, {
            marker,
            rendered,
          });
        }
      }
    }
    return { leafCount: leaves.length, dynamicArities: Object.fromEntries(DYNAMIC_ARITIES) };
  },
);

await report.check(
  {
    id: 'I18N.compile-time-arguments',
    name: 'Dynamic message arguments are guarded by source-owned type fixtures',
    assertion: 'The TypeScript fixture contains the required @ts-expect-error calls and is exported.',
  },
  async () => {
    const source = await readFile(new URL('../../src/i18n/typeFixtures.ts', import.meta.url), 'utf8');
    const directives = source.match(/@ts-expect-error/g) ?? [];
    verify(directives.length >= 3, 'At least three @ts-expect-error fixtures are required', {
      count: directives.length,
    });
    verify(/boostUsable\(\s*\)/.test(source), 'Missing boostUsable omitted-argument fixture');
    verify(/boostUsable\(\s*['"]/.test(source), 'Missing boostUsable string-argument fixture');
    verify(/gateClearedLog\(\s*\)/.test(source), 'Missing gateClearedLog omitted-arguments fixture');
    verify(/export\s+const\s+typeFixtures/.test(source), 'The fixture array must be exported');
    return { expectErrorDirectives: directives.length };
  },
);

await report.check(
  {
    id: 'I18N.preserved-tokens',
    name: 'Locale-independent tokens remain byte-identical',
    assertion: 'Proper nouns, bindings, units, and rank codes are unchanged in both catalogs.',
  },
  () => {
    const ko = requireExport('ko.ts', 'ko');
    const en = requireExport('en.ts', 'en');
    const paths = {
      'meta.gameTitle': 'LAST VECTOR',
      'meta.starName': 'ACHRA',
      'meta.shipName': 'KESTREL-C7',
      'meta.sectorName': 'THE CAIRN DRIFT',
      'meta.destinationName': 'VESPER TERMINUS',
      'controls.mouse': 'MOUSE',
      'controls.flightKeys': 'W / S / A / D / SHIFT / LMB / SPACE / RMB / Q / E / R / F / C / ESC / N',
      'hud.metresUnit': 'M',
      'hud.kilometresUnit': 'KM',
      'hud.speedUnit': 'M/S',
      'hud.gravityUnit': 'G',
      'hud.fps': 'FPS',
      'hud.terminus': 'TERMINUS',
      'cockpit.velocityUnit': 'm/s',
      'results.rankCodes': 'S / A / B / C / D',
      'results.speedUnit': 'M/S',
      'results.terminus': 'TERMINUS',
    };
    for (const [path, expected] of Object.entries(paths)) {
      verify(getPath(ko, path) === expected, `Korean ${path} changed a preserved token`);
      verify(getPath(en, path) === expected, `English ${path} changed a preserved token`);
    }

    const canonicalKorean = {
      'screens.beginRun': '비행 시작',
      'screens.settings': '설정',
      'screens.controls': '조작법',
      'screens.runBriefing': '비행 브리핑',
      'screens.destination': '목적지',
      'screens.markers': '표식',
      'screens.corridor': '항로',
      'screens.drift': '드리프트',
      'screens.closing': '수축 중',
      'screens.coreControls': '핵심 조작',
      'screens.engage': '출격',
      'screens.back': '뒤로',
      'screens.flightHeld': '비행 정지',
      'screens.paused': '일시정지',
      'screens.resume': '계속',
      'screens.restart': '재시작',
      'screens.abortRun': '비행 중단',
      'screens.briefingLine1': 'ACHRA가 꺼져 가고 있다. 매시간 선반 얼음과 회전하는 철편이 마지막 생존 항로로 쏟아진다.',
      'screens.briefingLine2': '응답하는 CAIRN은 아홉 기. 오래전에 사라진 손들이 남긴 표식이 곧 항로다.',
      'screens.briefingLine3': '순서대로 통과하라. 좁은 구간에서는 암석이 바짝 파고들며, 제동만이 선회 공간을 만든다.',
      'hud.keyboardFlight': '키보드 비행',
      'hud.throttle': '추력',
      'hud.hull': '선체',
      'hud.boost': '부스터',
      'hud.segment': '구간',
      'hud.elapsed': '경과',
      'hud.best': '최고',
      'hud.nextMarker': '다음 표식',
      'hud.departure': '출발',
      'hud.charging': '충전',
      'results.arrivalConfirmed': '도착 확인',
      'results.newRecord': '신기록',
      'results.runAgain': '다시 비행',
      'results.hullBreach': '선체 파손',
      'results.retry': '재도전',
      'cockpit.attitude': '자세',
      'cockpit.vectorRange': '벡터 / 거리',
      'cockpit.shipSystems': '기체 계통',
      'cockpit.energy': '동력',
      'cockpit.retroBrake': '역추진 제동',
      'cockpit.hullWarning': '선체 경고',
      'cockpit.proximityWarning': '근접 경고',
    };
    for (const [path, expected] of Object.entries(canonicalKorean)) {
      verify(getPath(ko, path) === expected, `Korean ${path} differs from canonical copy`);
    }
    verify(ko.screens.korean === '한국어' && ko.screens.english === '영어', 'Korean selector labels must be locale-native');
    verify(en.screens.korean === 'Korean' && en.screens.english === 'English', 'English selector labels must be locale-native');
    return { preserved: paths, canonicalKoreanCount: Object.keys(canonicalKorean).length };
  },
);

await report.check(
  {
    id: 'I18N.locale-store',
    name: 'Locale storage is safe, isolated, and Korean-default',
    assertion: 'Only raw ko/en values load; storage failures never corrupt the current in-memory locale.',
  },
  () => {
    const { LocaleStore, LOCALE_STORAGE_KEY } = requireModule('Locale.ts');
    const memoryStorage = (initial = null, { throwRead = false, throwWrite = false } = {}) => {
      let value = initial;
      return {
        getItem(key) {
          verify(key === LOCALE_STORAGE_KEY, 'LocaleStore read the wrong key', { key });
          if (throwRead) throw new Error('read denied');
          return value;
        },
        setItem(key, next) {
          verify(key === LOCALE_STORAGE_KEY, 'LocaleStore wrote the wrong key', { key });
          if (throwWrite) throw new Error('write denied');
          value = next;
        },
        value: () => value,
      };
    };

    verify(new LocaleStore(null).get() === 'ko', 'Null storage must default to ko');
    verify(new LocaleStore(memoryStorage()).get() === 'ko', 'Missing storage must default to ko');
    verify(new LocaleStore(memoryStorage('')).get() === 'ko', 'Empty storage must default to ko');
    verify(new LocaleStore(memoryStorage('jp')).get() === 'ko', 'Unknown locale must default to ko');
    verify(new LocaleStore(memoryStorage('{"locale":"en"}')).get() === 'ko', 'JSON-like storage must be rejected');
    verify(new LocaleStore(memoryStorage('en')).get() === 'en', 'Raw en storage must load');
    verify(new LocaleStore(memoryStorage('ko')).get() === 'ko', 'Raw ko storage must load');
    verify(new LocaleStore(memoryStorage('en', { throwRead: true })).get() === 'ko', 'Read errors must default safely');

    const persistent = memoryStorage();
    const persistedStore = new LocaleStore(persistent);
    persistedStore.set('en');
    verify(persistedStore.get() === 'en', 'set(en) must update memory');
    verify(persistent.value() === 'en', 'set(en) must persist the raw locale');
    verify(persistedStore.reload() === 'en', 'reload must retain valid persisted en');

    const failedWrite = memoryStorage(null, { throwWrite: true });
    const memoryFirstStore = new LocaleStore(failedWrite);
    memoryFirstStore.set('en');
    verify(memoryFirstStore.get() === 'en', 'A failed write must retain the selected en locale');
    verify(memoryFirstStore.reload() === 'en', 'A missing reload after failed write must retain en');

    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('getter denied');
        },
      });
      verify(new LocaleStore().get() === 'ko', 'A throwing localStorage getter must default safely');
    } finally {
      if (previousDescriptor) Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
      else delete globalThis.localStorage;
    }

    return {
      key: LOCALE_STORAGE_KEY,
      cases: ['null', 'missing', 'empty', 'jp', 'json-like', 'ko', 'en', 'throwing getter', 'throwing read', 'throwing write'],
    };
  },
);

const descriptors = [
  { type: 'gate-name.terminus-approach' },
  { type: 'callout-title.pointer-lock-unavailable' },
  { type: 'callout-title.camera-view', mode: 'cockpit' },
  { type: 'callout-title.camera-view', mode: 'chase' },
  { type: 'callout-title.engage' },
  { type: 'callout-title.hull-impact' },
  { type: 'callout-title.boost-depleted' },
  { type: 'callout-title.gate-cleared', accuracy: 'dead-centre' },
  { type: 'callout-title.gate-cleared', accuracy: 'clean' },
  { type: 'callout-title.gate-cleared', accuracy: 'cleared' },
  { type: 'callout-title.gate-missed' },
  { type: 'callout-sub.keyboard-flight-available' },
  { type: 'callout-sub.camera-active', mode: 'cockpit' },
  { type: 'callout-sub.camera-active', mode: 'chase' },
  { type: 'callout-sub.boost-recharging' },
  { type: 'callout-sub.gate-progress', remaining: 2 },
  { type: 'callout-sub.gate-progress', remaining: 1 },
  { type: 'callout-sub.gate-progress', remaining: 0 },
  { type: 'callout-sub.gate-realign' },
  { type: 'log.pointer-lock-refused', reason: '<img src=x onerror=globalThis.__LV_INJECTED=1>' },
  { type: 'log.hull-contact', percent: 37 },
  { type: 'log.boost-depleted' },
  { type: 'log.gate-cleared', gate: 7, seconds: 12.34 },
  { type: 'log.gate-missed', gate: 7 },
];

await report.check(
  {
    id: 'I18N.descriptor-roundtrip',
    name: 'Every domain descriptor is lossless JSON data',
    assertion: 'Exact key sets, values, and localized rendering survive JSON serialization.',
  },
  () => {
    const { createTranslator } = requireModule('index.ts');
    const translators = [createTranslator('ko'), createTranslator('en')];
    for (const descriptor of descriptors) {
      const roundTrip = JSON.parse(JSON.stringify(descriptor));
      verify(
        JSON.stringify(Object.keys(roundTrip)) === JSON.stringify(Object.keys(descriptor)),
        'Descriptor key set changed during JSON round-trip',
        { descriptor, roundTrip },
      );
      verify(JSON.stringify(roundTrip) === JSON.stringify(descriptor), 'Descriptor values changed during JSON round-trip', {
        descriptor,
        roundTrip,
      });
      for (const translator of translators) {
        verify(
          translator.domain(roundTrip) === translator.domain(descriptor),
          'Descriptor rendering changed during JSON round-trip',
          { locale: translator.locale, descriptor },
        );
      }
    }
    return { descriptorCount: descriptors.length, locales: translators.map(({ locale }) => locale) };
  },
);

await report.check(
  {
    id: 'I18N.legacy-english',
    name: 'English descriptor rendering preserves legacy telemetry bytes',
    assertion: 'Every canonical descriptor renders to its independent handwritten English fixture.',
  },
  () => {
    const { createTranslator } = requireModule('index.ts');
    const translator = createTranslator('en');
    const fixtures = [
      [{ type: 'gate-name.terminus-approach' }, 'TERMINUS APPROACH'],
      [{ type: 'callout-title.pointer-lock-unavailable' }, 'MOUSE CAPTURE UNAVAILABLE'],
      [{ type: 'callout-sub.keyboard-flight-available' }, 'W A S D / ARROWS STILL FLY'],
      [{ type: 'callout-title.camera-view', mode: 'cockpit' }, 'COCKPIT VIEW'],
      [{ type: 'callout-title.camera-view', mode: 'chase' }, 'CHASE VIEW'],
      [{ type: 'callout-sub.camera-active', mode: 'cockpit' }, 'PILOT CAMERA ACTIVE'],
      [{ type: 'callout-sub.camera-active', mode: 'chase' }, 'EXTERIOR CAMERA ACTIVE'],
      [{ type: 'callout-title.engage' }, 'ENGAGE'],
      [{ type: 'callout-title.hull-impact' }, 'HULL IMPACT'],
      [{ type: 'callout-title.boost-depleted' }, 'DRIVE DRY'],
      [{ type: 'callout-sub.boost-recharging' }, 'RESERVE RECHARGING'],
      [{ type: 'log.boost-depleted' }, 'overdrive reserve depleted'],
      [{ type: 'callout-title.gate-cleared', accuracy: 'dead-centre' }, 'DEAD CENTRE'],
      [{ type: 'callout-title.gate-cleared', accuracy: 'clean' }, 'CLEAN'],
      [{ type: 'callout-title.gate-cleared', accuracy: 'cleared' }, 'CLEARED'],
      [{ type: 'callout-sub.gate-progress', remaining: 2 }, '2 CAIRNS REMAINING'],
      [{ type: 'callout-sub.gate-progress', remaining: 1 }, '1 CAIRN REMAINING'],
      [{ type: 'callout-sub.gate-progress', remaining: 0 }, 'TERMINUS AHEAD'],
      [{ type: 'callout-title.gate-missed' }, 'MISSED'],
      [{ type: 'callout-sub.gate-realign' }, 'REALIGN AND RE-ENTER'],
      [{ type: 'log.pointer-lock-refused', reason: 'unsafe reason' }, 'mouse capture refused \u00B7 unsafe reason'],
      [{ type: 'log.hull-contact', percent: 37 }, 'hull contact \u00B7 37%'],
      [{ type: 'log.gate-cleared', gate: 7, seconds: 12.34 }, 'cairn 07 \u00B7 12.34s'],
      [{ type: 'log.gate-missed', gate: 7 }, 'cairn 07 missed'],
    ];
    for (const [descriptor, expected] of fixtures) {
      const actual = translator.domain(descriptor);
      verify(actual === expected, 'English descriptor rendering changed', { descriptor, expected, actual });
    }
    return { fixtureCount: fixtures.length };
  },
);

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;

function requireModule(name) {
  const module = loaded.get(name);
  verify(module, `${name} did not load`);
  return module;
}

function requireExport(name, exportName) {
  const module = requireModule(name);
  verify(exportName in module, `${name} does not export ${exportName}`);
  return module[exportName];
}

function compareCatalogs(ko, en, path, leaves) {
  verify(isRecord(ko) && isRecord(en), `${path || 'catalog'} must be an object`);
  const koKeys = Object.keys(ko);
  const enKeys = Object.keys(en);
  verify(JSON.stringify(koKeys) === JSON.stringify(enKeys), `${path || 'catalog'} keys differ`, { koKeys, enKeys });
  for (const key of koKeys) {
    const nextPath = path ? `${path}.${key}` : key;
    const koValue = ko[key];
    const enValue = en[key];
    verify(typeof koValue === typeof enValue, `${nextPath} leaf types differ`);
    if (isRecord(koValue) || isRecord(enValue)) {
      compareCatalogs(koValue, enValue, nextPath, leaves);
      continue;
    }
    verify(typeof koValue === 'string' || typeof koValue === 'function', `${nextPath} is not a catalog leaf`);
    if (typeof koValue === 'string') {
      verify(koValue.trim().length > 0 && enValue.trim().length > 0, `${nextPath} contains an empty string`);
      verify(!/<\/?[a-z][^>]*>/iu.test(koValue) && !/<\/?[a-z][^>]*>/iu.test(enValue), `${nextPath} contains HTML`);
    }
    leaves.push(nextPath);
  }
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
