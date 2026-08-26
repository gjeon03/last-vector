import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { Report, parseOptions, verify } from './runtime.mjs';

const EXPECTED_MODULES = [
  'Locale.ts',
  'domain.ts',
  'en.ts',
  'fonts.ts',
  'index.ts',
  'ko.ts',
  'messages.ts',
  'typeFixtures.ts',
];

const TOP_LEVEL_SECTIONS = [
  'meta',
  'loader',
  'screens',
  'campaign',
  'controls',
  'settings',
  'hud',
  'events',
  'results',
  'cockpit',
  'a11y',
];

const DYNAMIC_ARITIES = new Map([
  ['hud.meterPercent', 1],
  ['hud.boostUsable', 1],
  ['hud.boostRecharging', 1],
  ['hud.coreProgress', 2],
  ['hud.chargeProgress', 2],
  ['results.splitDelta', 1],
  ['results.bestComparison', 2],
  ['events.hullContact', 1],
  ['events.gateProgress', 1],
  ['events.gateClearedLog', 2],
  ['events.gateMissedLog', 1],
  ['campaign.routes.cairn-drift.gateProgress', 1],
  ['campaign.routes.cairn-drift.gateClearedLog', 2],
  ['campaign.routes.cairn-drift.gateMissedLog', 1],
  ['campaign.routes.cairn-drift.gateShearBlockedLog', 1],
  ['campaign.routes.relay-harvest.gateProgress', 1],
  ['campaign.routes.relay-harvest.gateClearedLog', 2],
  ['campaign.routes.relay-harvest.gateMissedLog', 1],
  ['campaign.routes.relay-harvest.gateShearBlockedLog', 1],
  ['campaign.routes.needle-grave.gateProgress', 1],
  ['campaign.routes.needle-grave.gateClearedLog', 2],
  ['campaign.routes.needle-grave.gateMissedLog', 1],
  ['campaign.routes.needle-grave.gateShearBlockedLog', 1],
  ['campaign.routes.wreckline.gateProgress', 1],
  ['campaign.routes.wreckline.gateClearedLog', 2],
  ['campaign.routes.wreckline.gateMissedLog', 1],
  ['campaign.routes.wreckline.gateShearBlockedLog', 1],
  ['campaign.routes.ringfall.gateProgress', 1],
  ['campaign.routes.ringfall.gateClearedLog', 2],
  ['campaign.routes.ringfall.gateMissedLog', 1],
  ['campaign.routes.ringfall.gateShearBlockedLog', 1],
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
    const failures = [];
    for (const name of names) {
      try {
        loaded.set(name, await import(new URL(`../../src/i18n/${name}`, import.meta.url)));
      } catch (error) {
        failures.push({ name, error: String(error) });
      }
    }
    verify(failures.length === 0, 'One or more i18n modules failed to import', { failures });
    verify(
      JSON.stringify(names) === JSON.stringify(EXPECTED_MODULES),
      'src/i18n module set differs from the contract',
      { expected: EXPECTED_MODULES, actual: names },
    );
    return { modules: names };
  },
);

await report.check(
  {
    id: 'I18N.font-assets',
    name: 'Vendored Korean fonts retain exact official bytes and complete provenance',
    assertion:
      'Exactly the three approved WOFF2 files match independent byte/hash fixtures, and NOTICE/OFL '
      + 'record the official archive, mappings, copyright, Reserved Font Name, and complete license.',
  },
  async () => {
    const fontsDirectory = new URL('../../public/fonts/', import.meta.url);
    const expectedFonts = [
      {
        repository: 'NanumSquareNeo-Light.woff2',
        archive: 'NanumSquareNeo/웹폰트/woff2/NanumSquareNeoTTF-aLt.woff2',
        bytes: 339380,
        sha256: 'f0da0f2329935d3f88f7e4162b68fcdc0be393f74398736ea0967594282ca4e2',
      },
      {
        repository: 'NanumSquareNeo-Regular.woff2',
        archive: 'NanumSquareNeo/웹폰트/woff2/NanumSquareNeoTTF-bRg.woff2',
        bytes: 387104,
        sha256: 'd13846b612acc829078aff4f91c272c637c08441b409d46bb1a4c802eb2967c3',
      },
      {
        repository: 'NanumSquareNeo-Bold.woff2',
        archive: 'NanumSquareNeo/웹폰트/woff2/NanumSquareNeoTTF-cBd.woff2',
        bytes: 384992,
        sha256: '97dfe9720fbed813fc988fcedbcf741e97eef9353515b2043717484ec0b90aa1',
      },
    ];
    let names = [];
    try {
      names = (await readdir(fontsDirectory)).filter((name) => name.endsWith('.woff2')).sort();
    } catch (error) {
      verify(false, 'public/fonts is unavailable', { error: String(error) });
    }
    const expectedNames = expectedFonts.map(({ repository }) => repository).sort();
    verify(JSON.stringify(names) === JSON.stringify(expectedNames),
      'public/fonts/*.woff2 differs from the exact approved set.', { expectedNames, names });

    const binaries = [];
    for (const expected of expectedFonts) {
      const bytes = await readFile(new URL(expected.repository, fontsDirectory));
      const actual = {
        repository: expected.repository,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        magic: bytes.subarray(0, 4).toString('ascii'),
      };
      verify(actual.bytes > 0 && actual.magic === 'wOF2',
        `${expected.repository} is not a non-empty WOFF2 binary.`, { expected, actual });
      verify(actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
        `${expected.repository} differs from the official byte fixture.`, { expected, actual });
      binaries.push(actual);
    }

    const notice = await readFile(new URL('NOTICE.md', fontsDirectory), 'utf8');
    const ofl = await readFile(new URL('OFL.txt', fontsDirectory), 'utf8');
    const oflSha256 = createHash('sha256').update(ofl).digest('hex');
    verify(oflSha256 === '975fb7229129ac94d05e9b4b7ae60b904f1c25f8b205d50e1c542507a586e5ea',
      'OFL.txt differs from the exact NAVER declaration plus unmodified official English body.', {
        expected: '975fb7229129ac94d05e9b4b7ae60b904f1c25f8b205d50e1c542507a586e5ea',
        actual: oflSha256,
      });
    const requiredNoticeFacts = [
      'https://campaign.naver.com/nanumsquare_neo/',
      'https://campaign.naver.com/nanumsquare_neo/download/NaverNanumSquareNeo.zip',
      'https://help.naver.com/service/30016/contents/18088?lang=ko&osType=PC',
      'https://software.sil.org/downloads/r/oflt/OFL.txt',
      '26,666,204',
      'aba166203bf7637324f1d923bcf9501eb276cfca044c1ad714ba06b1e61a15cc',
      '2026-08-24',
      'Asia/Seoul',
      'Copyright (c) 2010, NAVER Corporation',
      'Copyright © 2022 NAVER Corp. All rights reserved. Font Designed by Sandoll Inc.',
      'NanumSquare Neo Hangul',
      '350',
      '300',
    ];
    for (const fact of requiredNoticeFacts) {
      verify(notice.includes(fact), `NOTICE.md omits required provenance fact: ${fact}`);
    }
    for (const expected of expectedFonts) {
      for (const fact of [expected.repository, expected.archive, String(expected.bytes), expected.sha256]) {
        verify(notice.normalize('NFC').includes(fact.normalize('NFC')),
          `NOTICE.md omits mapping fact: ${fact}`);
      }
    }
    verify(/archive.{0,80}(contains|included|ships with) no license/isu.test(notice)
      || /no license.{0,80}(archive|ZIP)/isu.test(notice),
    'NOTICE.md does not disclose that the upstream ZIP contains no license file.');
    verify(/(byte|bytes).{0,80}unmodified|unmodified.{0,80}(byte|bytes)/isu.test(notice),
      'NOTICE.md does not state that the font bytes are unmodified.');
    verify(/filenames?.{0,120}(changed|renamed).{0,160}(alias|CSS)/isu.test(notice)
      || /(alias|CSS).{0,120}(changed|renamed).{0,160}filenames?/isu.test(notice),
    'NOTICE.md does not disclose the repository filename and CSS alias changes.');
    verify(/embedded names?.{0,80}(unchanged|not changed)|(?:unchanged|not changed).{0,80}embedded names?/isu.test(notice),
      'NOTICE.md does not state that embedded font names are unchanged.');
    verify(/OS\/2.{0,80}350.{0,80}CSS.{0,80}300/isu.test(notice),
      'NOTICE.md does not disclose the intentional Light OS/2 350 to CSS 300 mapping.');

    const requiredOflFacts = [
      'Copyright (c) 2010, NAVER Corporation',
      'NanumSquareNeo',
      'Reserved Font Name',
      'SIL OPEN FONT LICENSE',
      'Version 1.1 - 26 February 2007',
      '1) Neither the Font Software nor any of its individual components,',
      '2) Original or Modified Versions of the Font Software may be bundled',
      '3) No Modified Version of the Font Software may use the Reserved Font',
      '4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font',
      '5) The Font Software, modified or unmodified, in part or in whole,',
      'TERMINATION',
      'DISCLAIMER',
    ];
    for (const fact of requiredOflFacts) {
      verify(ofl.includes(fact), `OFL.txt omits required official text: ${fact}`);
    }
    verify(!/Copyright \(c\) <dates>, <Copyright Holder>/u.test(ofl)
      && !/<Reserved Font Name>/u.test(ofl),
    'OFL.txt retains a generic copyright or Reserved Font Name placeholder.');

    return {
      files: binaries,
      noticeFacts: requiredNoticeFacts,
      oflSections: requiredOflFacts.slice(3),
      oflSha256,
    };
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
    const bestComparisonFixtures = {
      ko: ko.results.bestComparison('+1.23', '01:02.34'),
      en: en.results.bestComparison('+1.23', '01:02.34'),
    };
    verify(bestComparisonFixtures.ko === '+1.23 vs BEST 01:02.34',
      'Korean-mode bestComparison differs from the English instrument fixture.', bestComparisonFixtures);
    verify(bestComparisonFixtures.en === '+1.23 vs BEST 01:02.34',
      'English bestComparison differs from the canonical exact fixture.', bestComparisonFixtures);
    const campaignRouteFixtures = {
      koCairnProgress: ko.campaign.routes['cairn-drift'].gateProgress(2),
      enCairnProgress: en.campaign.routes['cairn-drift'].gateProgress(2),
      koCairnClear: ko.campaign.routes['cairn-drift'].gateClearedLog(7, 12.34),
      enCairnClear: en.campaign.routes['cairn-drift'].gateClearedLog(7, 12.34),
      koCairnMiss: ko.campaign.routes['cairn-drift'].gateMissedLog(7),
      enCairnMiss: en.campaign.routes['cairn-drift'].gateMissedLog(7),
      koRelayProgress: ko.campaign.routes['relay-harvest'].gateProgress(2),
      enRelayProgress: en.campaign.routes['relay-harvest'].gateProgress(2),
      koRelayClear: ko.campaign.routes['relay-harvest'].gateClearedLog(3, 66.93),
      enRelayClear: en.campaign.routes['relay-harvest'].gateClearedLog(3, 66.93),
      koRelayRadio: ko.campaign.routes['relay-harvest'].radio3,
      enRelayRadio: en.campaign.routes['relay-harvest'].radio3,
      koNeedleProgress: ko.campaign.routes['needle-grave'].gateProgress(2),
      enNeedleProgress: en.campaign.routes['needle-grave'].gateProgress(2),
      koNeedleClear: ko.campaign.routes['needle-grave'].gateClearedLog(4, 9.87),
      enNeedleClear: en.campaign.routes['needle-grave'].gateClearedLog(4, 9.87),
      koNeedleMiss: ko.campaign.routes['needle-grave'].gateMissedLog(4),
      enNeedleMiss: en.campaign.routes['needle-grave'].gateMissedLog(4),
      koNeedleShear: ko.campaign.routes['needle-grave'].gateShearBlockedLog(3),
      enNeedleShear: en.campaign.routes['needle-grave'].gateShearBlockedLog(3),
      koNeedleRadio: ko.campaign.routes['needle-grave'].radio1,
      enNeedleRadio: en.campaign.routes['needle-grave'].radio1,
      koWreckProgress: ko.campaign.routes.wreckline.gateProgress(2),
      enWreckProgress: en.campaign.routes.wreckline.gateProgress(2),
      koWreckRadio: ko.campaign.routes.wreckline.radio2,
      enWreckRadio: en.campaign.routes.wreckline.radio2,
      koRingProgress: ko.campaign.routes.ringfall.gateProgress(2),
      enRingProgress: en.campaign.routes.ringfall.gateProgress(2),
      koRingRadio: ko.campaign.routes.ringfall.radio3,
      enRingRadio: en.campaign.routes.ringfall.radio3,
    };
    const expectedCampaignRouteFixtures = {
      koCairnProgress: '2 CAIRNS REMAINING',
      enCairnProgress: '2 CAIRNS REMAINING',
      koCairnClear: 'cairn 07 · 12.34s',
      enCairnClear: 'cairn 07 · 12.34s',
      koCairnMiss: 'cairn 07 missed',
      enCairnMiss: 'cairn 07 missed',
      koRelayProgress: '2 CORES REQUIRED',
      enRelayProgress: '2 CORES REQUIRED',
      koRelayClear: 'core 03 · 66.93s',
      enRelayClear: 'core 03 · 66.93s',
      koRelayRadio: 'CHARGE 절반 확보. 잔해 사이에서 가장 빠른 경로를 유지해.',
      enRelayRadio: 'Half the charge is aboard. Hold the fastest line through the wreckage.',
      koNeedleProgress: '2 NEEDLES REMAINING',
      enNeedleProgress: '2 NEEDLES REMAINING',
      koNeedleClear: 'needle 04 · 9.87s',
      enNeedleClear: 'needle 04 · 9.87s',
      koNeedleMiss: 'needle 04 missed',
      enNeedleMiss: 'needle 04 missed',
      koNeedleShear: 'needle 03 · shear block',
      enNeedleShear: 'needle 03 · shear block',
      koNeedleRadio: 'Kestrel, NADIR 항로 개방. SHEAR 차폐판이 가동 중이다.',
      enNeedleRadio: 'Kestrel, the NADIR line is open. SHEAR shutters are live.',
      koWreckProgress: '2 MARKERS REMAINING',
      enWreckProgress: '2 MARKERS REMAINING',
      koWreckRadio: 'THE FRACTURE 통과 확인. ENGINE SPINE을 따라가라.',
      enWreckRadio: 'THE FRACTURE is behind you. Follow the ENGINE SPINE.',
      koRingProgress: '2 MARKERS REMAINING',
      enRingProgress: '2 MARKERS REMAINING',
      koRingRadio: 'ORISON이 응답한다. 배열을 깨워라.',
      enRingRadio: 'ORISON is answering. Wake the array.',
    };
    verify(JSON.stringify(campaignRouteFixtures) === JSON.stringify(expectedCampaignRouteFixtures),
      'Route-specific campaign functions or radio copy differ from the canonical fixtures.', {
        expected: expectedCampaignRouteFixtures,
        actual: campaignRouteFixtures,
      });
    return {
      leafCount: leaves.length,
      dynamicArities: Object.fromEntries(DYNAMIC_ARITIES),
      bestComparisonFixtures,
      campaignRouteFixtures,
    };
  },
);

await report.check(
  {
    id: 'I18N.chapter-stage-rail',
    name: 'The active campaign presents CAIRN then BLACKOUT RELAY',
    assertion:
      'Two active missions share one catalog rail, dormant route copy remains recognized, and '
      + 'Korean narrative/English chrome remain explicit.',
  },
  async () => {
    const ko = requireExport('ko.ts', 'ko');
    const en = requireExport('en.ts', 'en');
    const screensSource = await readFile(new URL('../../src/ui/Screens.ts', import.meta.url), 'utf8');
    const missionsSource = await readFile(new URL('../../src/core/Missions.ts', import.meta.url), 'utf8');
    const recognizedIds = [
      'cairn-drift',
      'relay-harvest',
      'needle-grave',
      'wreckline',
      'ringfall',
    ];
    verify(JSON.stringify(Object.keys(ko.campaign.routes)) === JSON.stringify(recognizedIds),
      'Korean campaign catalog does not use the canonical recognized stage IDs.', {
        actual: Object.keys(ko.campaign.routes),
      });
    verify(JSON.stringify(Object.keys(en.campaign.routes)) === JSON.stringify(recognizedIds),
      'English campaign catalog does not use the canonical recognized stage IDs.', {
        actual: Object.keys(en.campaign.routes),
      });

    const railStart = screensSource.indexOf('private buildStageRail()');
    const railEnd = screensSource.indexOf('/* ------------------------------------------------------------------- title */', railStart);
    const railSource = screensSource.slice(railStart, railEnd);
    verify(railStart >= 0 && railEnd > railStart, 'Screens does not define the chapter heading.');
    verify(/ACTIVE_MISSION_ORDER\s*=\s*\[\s*'cairn-drift',\s*'relay-harvest',?\s*\]/u.test(missionsSource),
      'The player-facing order is not CAIRN then BLACKOUT RELAY.', { missionsSource });
    verify(railSource.includes('CHAPTER_STAGE_IDS'),
      'The title rail is not driven by the active mission catalog.', { railSource });
    verify(/if \(Number\(CHAPTER_STAGE_IDS\.length\) === 1\) return section;/u.test(railSource),
      'The title does not suppress its selector for a one-node catalog.', { railSource });
    verify(/if \(CHAPTER_STAGE_IDS\.length > 1\)[\s\S]{0,260}'stage-select'/u.test(screensSource),
      'Result mission selection is not guarded behind a multi-chapter catalog.');
    verify(screensSource.includes("'run-again'")
      && screensSource.includes("'new-layout'")
      && screensSource.includes("'stage-select'")
      && screensSource.includes("'return'"),
    'The campaign result path omits RUN AGAIN, NEW LAYOUT, CHAPTER SELECT, or RETURN.');
    verify(screensSource.includes("complete: route.highestRank === 'S'"),
      'Mission mastery treats a non-S recorded rank as complete.');

    const hybridChrome = {
      chapter: 'FLIGHT CAMPAIGN',
      chapterName: 'THE FALL OF ACHRA',
      stageSelection: 'CHAPTER SELECT',
      stageObjectives: 'MISSION MASTERY',
      stage: 'MISSION',
      nextStage: 'NEXT CHAPTER',
      stageSelect: 'CHAPTER SELECT',
    };
    for (const [key, expected] of Object.entries(hybridChrome)) {
      verify(ko.campaign[key] === expected && en.campaign[key] === expected,
        `Campaign technical chrome changed at ${key}.`, {
          expected,
          ko: ko.campaign[key],
          en: en.campaign[key],
        });
    }
    for (const id of ['relay-harvest', 'wreckline', 'ringfall']) {
      const korean = ko.campaign.routes[id];
      const english = en.campaign.routes[id];
      verify(/[가-힣]/u.test(korean.tagline + korean.briefingLine1 + korean.radio1),
        `${id} Korean narrative layer contains no Korean guidance.`);
      verify(!/[가-힣]/u.test(english.tagline + english.briefingLine1 + english.radio1),
        `${id} English narrative contains Korean text.`);
      verify(korean.name === english.name && korean.destination === english.destination,
        `${id} translated a canonical stage or destination ID.`);
    }
    verify(/[가-힣]/u.test(ko.a11y.stageSelection + ko.a11y.stageLocked + ko.a11y.stageSelected),
      'Korean stage accessibility copy is not Korean.');
    const lockPrerequisites = {
      enRelay: en.campaign.routes['relay-harvest'].lockReason,
      koRelay: ko.campaign.routes['relay-harvest'].lockReason,
    };
    verify(lockPrerequisites.enRelay.includes('CAIRN DRIFT')
      && lockPrerequisites.koRelay.includes('CAIRN DRIFT'),
    'A campaign lock names the wrong prerequisite mission.', lockPrerequisites);

    return {
      recognizedIds,
      activeMissionIds: ['cairn-drift', 'relay-harvest'],
      stableCampaignActions: ['run-again', 'new-layout', 'stage-select', 'return'],
      lockPrerequisites,
      hybridChrome,
    };
  },
);

await report.check(
  {
    id: 'I18N.compile-time-arguments',
    name: 'Dynamic arguments and safe DOM sinks are guarded at source level',
    assertion:
      'The TypeScript fixture contains the required @ts-expect-error calls and Screens/Hud avoid HTML sinks.',
  },
  async () => {
    const source = await readFile(new URL('../../src/i18n/typeFixtures.ts', import.meta.url), 'utf8');
    const htmlSource = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
    const mainSource = await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const screensSource = await readFile(new URL('../../src/ui/Screens.ts', import.meta.url), 'utf8');
    const hudSource = await readFile(new URL('../../src/ui/Hud.ts', import.meta.url), 'utf8');
    const perfSource = await readFile(new URL('./perf-probe.mjs', import.meta.url), 'utf8');
    const directives = source.match(/@ts-expect-error/g) ?? [];
    verify(directives.length >= 3, 'At least three @ts-expect-error fixtures are required', {
      count: directives.length,
    });
    verify(/boostUsable\(\s*\)/.test(source), 'Missing boostUsable omitted-argument fixture');
    verify(/boostUsable\(\s*['"]/.test(source), 'Missing boostUsable string-argument fixture');
    verify(/gateClearedLog\(\s*\)/.test(source), 'Missing gateClearedLog omitted-arguments fixture');
    verify(/bestComparison\(\s*\)/.test(source), 'Missing bestComparison omitted-arguments fixture');
    verify(/bestComparison\(\s*['"][^'"]+['"]\s*\)/.test(source),
      'Missing bestComparison one-argument fixture');
    verify(/export\s+const\s+typeFixtures/.test(source), 'The fixture array must be exported');
    const domSources = [
      ['main.ts', mainSource],
      ['Screens.ts', screensSource],
      ['Hud.ts', hudSource],
    ];
    const unsafeDomSinks = [
      ['innerHTML', /\.innerHTML\b/],
      ['insertAdjacentHTML', /\.insertAdjacentHTML\s*\(/],
      ['document.write', /\bdocument\.write\s*\(/],
    ].flatMap(([name, pattern]) => domSources
      .filter(([, candidate]) => pattern.test(candidate))
      .map(([file]) => `${file}:${name}`));
    verify(unsafeDomSinks.length === 0,
      'main.ts, Screens.ts, or Hud.ts uses a forbidden HTML-parsing DOM sink.', { unsafeDomSinks });

    const staticShell = {
      lang: htmlSource.includes('<html lang="ko">'),
      title: htmlSource.includes('<title>LAST VECTOR — THE CAIRN DRIFT</title>'),
      description: htmlSource.includes(
        '<meta name="description" content="붕괴하는 잔해 항로를 가르는 우주 비행 게임." />',
      ),
      noscriptTokens: [
        '<span lang="en">LAST VECTOR</span>',
        '<span lang="en">JavaScript</span>',
        '<span lang="en">WebGL2</span>',
      ].filter((fixture) => htmlSource.includes(fixture)),
    };
    verify(staticShell.lang && staticShell.title && staticShell.description
      && staticShell.noscriptTokens.length === 3,
    'index.html is not the canonical Korean static shell with English noscript tokens.', staticShell);

    const coldInstrumentationIndex = perfSource.indexOf('capture(() => installColdInstrumentation(page))');
    const coldWindowIndex = perfSource.indexOf('capture(() => collectColdWindow(page, options.timeoutMs))');
    const cadenceIndex = perfSource.indexOf('capture(() => collectMfdUploadCadence(page, options.timeoutMs))');
    const perfOrdering = { coldInstrumentationIndex, coldWindowIndex, cadenceIndex };
    verify(coldInstrumentationIndex >= 0 && coldWindowIndex > coldInstrumentationIndex
      && cadenceIndex > coldWindowIndex,
    'The cold cockpit window is not captured before the MFD cadence arm.', perfOrdering);
    verify(/async function collectProfile\(page, options, coldWindow\)/u.test(perfSource)
      && /collectProfile\(page, options, unwrap\(coldWindowOutcome\)\)/u.test(perfSource),
    'collectProfile does not consume the already-captured cold window.', perfOrdering);

    const cadenceSource = perfSource.slice(
      perfSource.indexOf('async function collectMfdUploadCadence'),
      perfSource.indexOf('async function installColdInstrumentation'),
    );
    const cadenceRestoration = {
      fullSnapshot: cadenceSource.includes('structuredClone(api.settings())'),
      restoreSettings: cadenceSource.includes('api.setSettings(settingsBefore)'),
      disableAutopilot: cadenceSource.includes('api.setAutopilot(false)'),
      releaseDriven: cadenceSource.includes('api.setDriven(false)'),
      finallyBlock: cadenceSource.includes('finally {'),
    };
    verify(Object.values(cadenceRestoration).every(Boolean),
      'The MFD cadence probe does not snapshot and restore all mutable probe state.', cadenceRestoration);
    verify(!/this\.el\.toggleAttribute\(\s*['"]aria-hidden/u.test(hudSource),
      'Hud must not aria-hide its whole root because radio survives briefing.');
    return {
      expectErrorDirectives: directives.length,
      unsafeDomSinks,
      staticShell,
      perfOrdering,
      cadenceRestoration,
    };
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

    // Korean mode deliberately keeps the terse flight/interface spine in English. Korean is the
    // meaning layer for prose, guidance, radio, accessibility and recovery—not a word-for-word
    // reskin of cockpit terminology.
    const hybridEnglishSpine = {
      'screens.sector': 'SECTOR',
      'screens.beginRun': 'START FLIGHT',
      'screens.settings': 'SETTINGS',
      'screens.controls': 'CONTROLS',
      'screens.runBriefing': 'RUN BRIEFING',
      'screens.destination': 'DESTINATION',
      'screens.markers': 'MARKERS',
      'screens.corridor': 'CORRIDOR',
      'screens.drift': 'DRIFT',
      'screens.closing': 'CLOSING',
      'screens.coreControls': 'CORE CONTROLS',
      'screens.engage': 'ENGAGE',
      'screens.back': 'BACK',
      'screens.flightHeld': 'FLIGHT HELD',
      'screens.paused': 'PAUSED',
      'screens.resume': 'RESUME',
      'screens.restart': 'RESTART',
      'screens.abortRun': 'ABORT FLIGHT',
      'settings.sectionFlight': 'FLIGHT',
      'settings.defaultCamera': 'Default camera',
      'settings.renderScale': 'Render scale',
      'hud.throttle': 'THR',
      'hud.hull': 'HULL',
      'hud.boost': 'BOOST',
      'hud.segment': 'SPLIT',
      'hud.elapsed': 'ELAPSED',
      'hud.nextMarker': 'NEXT MARKER',
      'results.arrivalConfirmed': 'ARRIVAL CONFIRMED',
      'results.newRecord': 'NEW BEST',
      'results.runAgain': 'RUN AGAIN',
      'results.newLayout': 'NEW LAYOUT',
      'results.returnToTitle': 'RETURN',
      'results.missionFailed': 'MISSION FAILED',
      'results.hullBreach': 'HULL BREACH',
      'results.retry': 'RETRY',
      'cockpit.attitude': 'ATTITUDE',
      'cockpit.vectorRange': 'VECTOR / RANGE',
      'cockpit.shipSystems': 'SHIP SYSTEMS',
      'cockpit.energy': 'ENG',
      'cockpit.retroBrake': 'RETRO BRAKE',
    };
    for (const [path, expected] of Object.entries(hybridEnglishSpine)) {
      verify(getPath(ko, path) === expected, `Korean-mode ${path} left the English UI spine`);
    }

    const canonicalKoreanGuidance = {
      'screens.briefingLine1': 'ACHRA가 꺼져 가고 있다. 매시간 선반 얼음과 회전하는 철편이 마지막 생존 항로로 쏟아진다.',
      'screens.briefingLine2': '응답하는 CAIRN은 아홉 기. 오래전에 사라진 손들이 남긴 표식이 곧 항로다.',
      'screens.briefingLine3': '순서대로 통과하라. 좁은 구간에서는 암석이 바짝 파고들며, 제동만이 선회 공간을 만든다.',
      'screens.pauseDetail': '드리프트는 계속된다. 항로는 기다려 주지 않는다.',
      'controls.mouseSteer': '조향 — 자동 복귀 가상 스틱',
      'controls.cameraToggle': '추적 / 조종석 / 원거리 추적 순환',
      'controls.pointerLockNote': '출격하면 마우스가 고정됩니다. ESC를 누르면 마우스가 풀리고 비행이 일시정지됩니다.',
      'settings.defaultCameraHint': '비행 중 C를 눌러 시점을 전환합니다.',
      'settings.renderScaleHint': '내부 해상도입니다. 품질보다 먼저 낮추세요.',
      'events.radio1': 'Kestrel, CAIRN 항로 진입을 허가한다. 행운을 빈다.',
      'loader.runtimeFailureDetail': '반복된 실행 오류로 시뮬레이션이 중단되었습니다. 계속하려면 페이지를 새로고침해 주세요.',
      'a11y.mainMenu': '주 메뉴',
    };
    for (const [path, expected] of Object.entries(canonicalKoreanGuidance)) {
      verify(getPath(ko, path) === expected, `Korean ${path} differs from canonical copy`);
    }
    verify(ko.screens.korean === '한국어' && ko.screens.english === 'English',
      'Korean selector labels must use each language\'s native name.');
    verify(en.screens.korean === '한국어' && en.screens.english === 'English',
      'English selector labels must use each language\'s native name.');
    return {
      preserved: paths,
      hybridEnglishSpineCount: Object.keys(hybridEnglishSpine).length,
      canonicalKoreanGuidanceCount: Object.keys(canonicalKoreanGuidance).length,
    };
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
  { type: 'gate-name.nadir-approach' },
  { type: 'gate-name.orison-approach' },
  { type: 'callout-title.pointer-lock-unavailable' },
  { type: 'callout-title.camera-view', mode: 'cockpit' },
  { type: 'callout-title.camera-view', mode: 'chase' },
  { type: 'callout-title.engage' },
  { type: 'callout-title.hull-impact' },
  { type: 'callout-title.boost-depleted' },
  { type: 'callout-title.core-acquired', core: 2 },
  { type: 'callout-title.gate-cleared', accuracy: 'dead-centre' },
  { type: 'callout-title.gate-cleared', accuracy: 'clean' },
  { type: 'callout-title.gate-cleared', accuracy: 'cleared' },
  { type: 'callout-title.gate-missed' },
  { type: 'callout-title.gate-missed', blockedBy: 'shear' },
  { type: 'callout-sub.keyboard-flight-available' },
  { type: 'callout-sub.camera-active', mode: 'cockpit' },
  { type: 'callout-sub.camera-active', mode: 'chase' },
  { type: 'callout-sub.boost-recharging' },
  { type: 'callout-sub.relay-charge', charge: 40, required: 60 },
  { type: 'callout-sub.gate-progress', remaining: 2 },
  { type: 'callout-sub.gate-progress', remaining: 1 },
  { type: 'callout-sub.gate-progress', remaining: 0 },
  { type: 'callout-sub.gate-realign' },
  { type: 'callout-sub.gate-shear-window' },
  { type: 'log.pointer-lock-refused', reason: '<img src=x onerror=globalThis.__LV_INJECTED=1>' },
  { type: 'log.hull-contact', percent: 37 },
  { type: 'log.boost-depleted' },
  { type: 'log.core-acquired', core: 2, seconds: 12.34 },
  { type: 'log.gate-cleared', gate: 7, seconds: 12.34 },
  { type: 'log.gate-missed', gate: 7 },
  { type: 'log.gate-missed', gate: 3, courseId: 'needle-grave', blockedBy: 'shear' },
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
      [{ type: 'gate-name.nadir-approach' }, 'NADIR APPROACH'],
      [{ type: 'gate-name.orison-approach' }, 'ORISON APPROACH'],
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
      [{ type: 'callout-title.core-acquired', core: 2 }, 'CORE 02 ACQUIRED'],
      [{ type: 'callout-sub.relay-charge', charge: 40, required: 60 }, 'RELAY CHARGE 40/60'],
      [{ type: 'log.core-acquired', core: 2, seconds: 12.34 }, 'core 02 \u00B7 12.34s'],
      [{ type: 'callout-title.gate-cleared', accuracy: 'dead-centre' }, 'DEAD CENTRE'],
      [{ type: 'callout-title.gate-cleared', accuracy: 'clean' }, 'CLEAN'],
      [{ type: 'callout-title.gate-cleared', accuracy: 'cleared' }, 'CLEARED'],
      [{ type: 'callout-sub.gate-progress', remaining: 2 }, '2 CAIRNS REMAINING'],
      [{ type: 'callout-sub.gate-progress', remaining: 1 }, '1 CAIRN REMAINING'],
      [{ type: 'callout-sub.gate-progress', remaining: 0 }, 'TERMINUS AHEAD'],
      [{ type: 'callout-title.gate-missed' }, 'MISSED'],
      [{ type: 'callout-title.gate-missed', blockedBy: 'shear' }, 'SHEAR BLOCK'],
      [{ type: 'callout-sub.gate-realign' }, 'REALIGN AND RE-ENTER'],
      [{ type: 'callout-sub.gate-shear-window' }, 'HOLD FOR THE OPEN SECTOR'],
      [{ type: 'log.pointer-lock-refused', reason: 'unsafe reason' }, 'mouse capture refused \u00B7 unsafe reason'],
      [{ type: 'log.hull-contact', percent: 37 }, 'hull contact \u00B7 37%'],
      [{ type: 'log.gate-cleared', gate: 7, seconds: 12.34 }, 'cairn 07 \u00B7 12.34s'],
      [{ type: 'log.gate-missed', gate: 7 }, 'cairn 07 missed'],
      [{ type: 'log.gate-missed', gate: 3, courseId: 'needle-grave', blockedBy: 'shear' }, 'needle 03 · shear block'],
    ];
    for (const [descriptor, expected] of fixtures) {
      const actual = translator.domain(descriptor);
      verify(actual === expected, 'English descriptor rendering changed', { descriptor, expected, actual });
    }
    const ko = requireExport('ko.ts', 'ko');
    const en = requireExport('en.ts', 'en');
    const boostFixtures = {
      koUsable: ko.hud.boostUsable(92 / 20),
      enUsable: en.hud.boostUsable(92 / 20),
      koRecharging: ko.hud.boostRecharging(45),
      enRecharging: en.hud.boostRecharging(45),
    };
    verify(boostFixtures.koUsable === '부스터 4.6초 사용 가능',
      'Korean boost usable copy differs from the exact fixture.', boostFixtures);
    verify(boostFixtures.enUsable === 'Boost reserve, 4.6 seconds usable',
      'English boost usable copy differs from the exact fixture.', boostFixtures);
    verify(boostFixtures.koRecharging === '부스터 잠김 · 45%까지 충전 중',
      'Korean boost recharging copy differs from the exact fixture.', boostFixtures);
    verify(boostFixtures.enRecharging === 'Boost reserve locked; recharging to 45 percent',
      'English boost recharging copy differs from the exact legacy fixture.', boostFixtures);
    return { fixtureCount: fixtures.length, boostFixtures };
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
