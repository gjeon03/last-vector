import {
  CHAPTER_ONE_STAGE_ORDER,
  KNOWN_COURSE_ORDER,
  PRECISION_MAX_OFFSET,
  courseRecordId,
  getCourseDefinition,
  getNextCourse,
  isCourseAvailable,
} from '../../src/core/Courses.ts';
import { en } from '../../src/i18n/en.ts';
import { ko } from '../../src/i18n/ko.ts';
import { formatPrecisionOffsetPercent } from '../../src/ui/precision.ts';
import { buildCourseUrl, resolveCourseSelection } from '../../src/core/CourseSelection.ts';
import { PROGRESS_KEY, ProgressStore, isCourseUnlocked } from '../../src/core/Progress.ts';
import { hasBestRunPrefix } from '../../src/core/Settings.ts';
import { Report, parseOptions, verify } from './runtime.mjs';

class MemoryStorage {
  constructor(initial = {}, failures = {}) {
    this.values = new Map(Object.entries(initial));
    this.failGet = failures.failGet === true;
    this.failSet = failures.failSet === true;
    this.writes = 0;
  }

  getItem(key) {
    if (this.failGet) throw new Error('read denied');
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failSet) throw new Error('write denied');
    this.writes += 1;
    this.values.set(key, String(value));
  }
}

function progress({ version = 1, selectedCourse = 'cairn-drift', courses = {} } = {}) {
  return { version, selectedCourse, courses };
}

function courseProgress(patch = {}) {
  return {
    cleared: false,
    clearedAt: null,
    highestRank: null,
    cleanClear: false,
    precisionClear: false,
    ...patch,
  };
}

function runResult(patch = {}) {
  return {
    courseId: 'cairn-drift',
    totalTime: 80,
    splits: [],
    bestTime: null,
    bestSplits: [],
    isNewBest: false,
    gatesCleared: 9,
    gatesTotal: 9,
    topSpeed: 900,
    cleanRun: false,
    rank: 'D',
    destinationName: 'VESPER TERMINUS',
    ...patch,
  };
}

function authoredCourseLength(definition) {
  return definition.geometry.legs.reduce(
    (sum, leg) => sum + leg.length * definition.geometry.gateSpacing,
    definition.geometry.startOffsetMetres
      + definition.geometry.runOutSteps * definition.geometry.runOutStepMetres
      + definition.geometry.terminusStandoff,
  );
}

function requiredRadioWindow(line, englishText) {
  const calloutDelay = line.afterGate === 0 ? 1.6 : 1.15;
  const subtitleTtl = 3.2 + Math.min(englishText.length, 120) * 0.035;
  return calloutDelay + subtitleTtl + 2;
}

const options = parseOptions('campaign-contract', process.argv.slice(2));
const report = new Report('campaign-contract', options);

await report.check({
  id: 'CAMPAIGN.catalog-contract',
  name: 'Chapter 01 owns a three-stage active order beside the retained known catalog',
  assertion: 'CAIRN, WRECKLINE and RINGFALL are the only active linear stages; NEEDLE remains recognized but inactive, and every active stage has a distinct stable PB identity and valid radio authoring.',
}, () => {
  verify(
    JSON.stringify(KNOWN_COURSE_ORDER)
      === JSON.stringify(['cairn-drift', 'needle-grave', 'wreckline', 'ringfall']),
    'Recognized course order changed.', { order: KNOWN_COURSE_ORDER },
  );
  verify(
    JSON.stringify(CHAPTER_ONE_STAGE_ORDER)
      === JSON.stringify(['cairn-drift', 'wreckline', 'ringfall']),
    'Chapter 01 stage order changed.', { order: CHAPTER_ONE_STAGE_ORDER },
  );
  verify(CHAPTER_ONE_STAGE_ORDER.every(isCourseAvailable) && !isCourseAvailable('needle-grave'),
    'Active availability does not match the Chapter 01 order.');
  const cairn = getCourseDefinition('cairn-drift');
  const needle = getCourseDefinition('needle-grave');
  const wreckline = getCourseDefinition('wreckline');
  const ringfall = getCourseDefinition('ringfall');
  const authoredNeedleLength = authoredCourseLength(needle);
  verify(cairn.geometry.legs.length === 9, 'CAIRN gate count changed.', { gateCount: cairn.geometry.legs.length });
  verify(cairn.defaultSeed === 3139019938,
    'CAIRN default seed changed.', { defaultSeed: cairn.defaultSeed });
  verify(courseRecordId(cairn, 1337) === 'cairn-drift-1337', 'CAIRN PB identity changed.');
  verify(courseRecordId(cairn, cairn.defaultSeed) === 'cairn-drift-3139019938',
    'CAIRN default-seed PB identity changed.');
  verify(getNextCourse('cairn-drift') === 'wreckline'
    && getNextCourse('wreckline') === 'ringfall'
    && getNextCourse('ringfall') === null
    && getNextCourse('needle-grave') === null,
  'Next-stage lookup does not follow the active linear chapter.', {
    cairn: getNextCourse('cairn-drift'),
    wreckline: getNextCourse('wreckline'),
    ringfall: getNextCourse('ringfall'),
    needle: getNextCourse('needle-grave'),
  });
  verify(wreckline.geometry.legs.length === 8, 'WRECKLINE must contain eight gates.');
  verify(ringfall.geometry.legs.length === 9, 'RINGFALL must contain nine gates.');
  verify(wreckline.world.landmarkKind === 'wreckline' && ringfall.world.landmarkKind === 'ringfall',
    'New stages lost their definition-owned landmark identity.');
  const pbIds = CHAPTER_ONE_STAGE_ORDER.map((id) => courseRecordId(getCourseDefinition(id), 1337));
  verify(new Set(pbIds).size === 3
    && JSON.stringify(pbIds) === JSON.stringify([
      'cairn-drift-1337',
      'wreckline-1337',
      'ringfall-1337',
    ]),
  'Active stages do not have independent stable PB prefixes.', { pbIds });

  const radio = {};
  for (const definition of [wreckline, ringfall]) {
    verify(definition.radio.length >= 2 && definition.radio.length <= 3,
      `${definition.id} must author two or three radio lines.`, definition.radio);
    let previousGate = -1;
    radio[definition.id] = definition.radio.map((line) => {
      const englishText = en.campaign.routes[definition.id]?.[line.messageKey];
      const koreanText = ko.campaign.routes[definition.id]?.[line.messageKey];
      verify(typeof englishText === 'string' && englishText.trim().length > 0
        && typeof koreanText === 'string' && koreanText.trim().length > 0,
      `${definition.id}.${line.messageKey} is missing bilingual copy.`);
      verify(line.afterGate > previousGate && line.afterGate < definition.geometry.legs.length,
        `${definition.id} radio triggers are unordered or outside the course.`, definition.radio);
      const requiredWindow = requiredRadioWindow(line, englishText);
      verify(line.safeWindowSeconds >= requiredWindow,
        `${definition.id}.${line.messageKey} cannot clear its callout and subtitle safety margin.`, {
          safeWindowSeconds: line.safeWindowSeconds,
          requiredWindow,
          englishLength: englishText.length,
        });
      previousGate = line.afterGate;
      return { ...line, requiredWindow };
    });
  }
  verify(needle.geometry.legs.length === 6, 'NEEDLE must contain six gates.');
  verify(JSON.stringify(needle.shear?.gates) === JSON.stringify([2, 3, 4, 5]),
    'NEEDLE SHEAR indices changed.', { gates: needle.shear?.gates ?? null });
  verify(needle.text.canonicalDestination === 'NADIR RELAY', 'NEEDLE destination identity changed.');
  verify(needle.shear.hubRadiusFraction < PRECISION_MAX_OFFSET
    && PRECISION_MAX_OFFSET < 1 && needle.shear.halfWidthRadians < Math.PI,
  'NEEDLE has no authored open band inside the shared precision target.', {
    hubRadiusFraction: needle.shear.hubRadiusFraction,
    precisionMaxOffset: PRECISION_MAX_OFFSET,
    halfWidthRadians: needle.shear.halfWidthRadians,
  });
  verify(
    formatPrecisionOffsetPercent(PRECISION_MAX_OFFSET - 0.0001) === '39.9%'
      && formatPrecisionOffsetPercent(PRECISION_MAX_OFFSET) === '40.0%'
      && formatPrecisionOffsetPercent(PRECISION_MAX_OFFSET + 0.0001) === '40.1%',
    'Precision result formatting is ambiguous at the strict mastery boundary.',
    {
      pass: formatPrecisionOffsetPercent(PRECISION_MAX_OFFSET - 0.0001),
      boundary: formatPrecisionOffsetPercent(PRECISION_MAX_OFFSET),
      fail: formatPrecisionOffsetPercent(PRECISION_MAX_OFFSET + 0.0001),
    },
  );
  verify(authoredNeedleLength >= 24_000 && authoredNeedleLength <= 30_000,
    'NEEDLE authored distances are outside the safe construction envelope.', { authoredNeedleLength });
  return {
    knownOrder: KNOWN_COURSE_ORDER,
    activeOrder: CHAPTER_ONE_STAGE_ORDER,
    cairn: { gates: cairn.geometry.legs.length, recordId: courseRecordId(cairn, 1337) },
    needle: {
      gates: needle.geometry.legs.length,
      shearGates: needle.shear?.gates,
      authoredNeedleLength,
      destination: needle.text.canonicalDestination,
    },
    wreckline: { gates: wreckline.geometry.legs.length, authoredLength: authoredCourseLength(wreckline) },
    ringfall: { gates: ringfall.geometry.legs.length, authoredLength: authoredCourseLength(ringfall) },
    radio,
  };
});

await report.check({
  id: 'CAMPAIGN.route-resolution',
  name: 'URL and saved selection authorize only active sequentially unlocked stages',
  assertion: 'Unknown, inactive and locked URLs fail closed to CAIRN; valid active URLs win over saved selection without bypassing the ordered clear facts.',
}, () => {
  const locked = progress({ selectedCourse: 'cairn-drift' });
  const wrecklineUnlocked = progress({
    selectedCourse: 'wreckline',
    courses: { 'cairn-drift': courseProgress({ cleared: true }) },
  });
  const ringfallUnlocked = progress({
    selectedCourse: 'ringfall',
    courses: {
      'cairn-drift': courseProgress({ cleared: true }),
      wreckline: courseProgress({ cleared: true }),
    },
  });
  const inactive = progress({
    selectedCourse: 'needle-grave',
    courses: {
      'cairn-drift': courseProgress({ cleared: true }),
      'needle-grave': courseProgress({ cleared: true }),
    },
  });
  const cases = {
    unknown: resolveCourseSelection('not-a-route', ringfallUnlocked),
    lockedWreckline: resolveCourseSelection('wreckline', locked),
    lockedRingfall: resolveCourseSelection('ringfall', wrecklineUnlocked),
    inactiveNeedle: resolveCourseSelection('needle-grave', inactive),
    wreckline: resolveCourseSelection('wreckline', wrecklineUnlocked),
    ringfall: resolveCourseSelection('ringfall', ringfallUnlocked),
    persistedInactive: resolveCourseSelection(null, inactive),
    persistedRingfall: resolveCourseSelection(null, ringfallUnlocked),
  };
  verify(cases.unknown.courseId === 'cairn-drift' && cases.unknown.source === 'invalid-url',
    'Unknown URL did not fail closed.', cases);
  verify(cases.lockedWreckline.courseId === 'cairn-drift'
    && cases.lockedWreckline.source === 'locked-url'
    && cases.lockedRingfall.courseId === 'cairn-drift'
    && cases.lockedRingfall.source === 'locked-url',
  'Locked active URL bypassed sequential progression.', cases);
  verify(cases.inactiveNeedle.courseId === 'cairn-drift'
    && cases.inactiveNeedle.source === 'locked-url'
    && cases.inactiveNeedle.diagnostic?.includes('disabled'),
  'Explicit inactive NEEDLE URL escaped the active catalog.', cases);
  verify(cases.wreckline.courseId === 'wreckline' && cases.wreckline.source === 'url'
    && cases.ringfall.courseId === 'ringfall' && cases.ringfall.source === 'url',
  'Valid unlocked URL selection was rejected.', cases);
  verify(cases.persistedInactive.courseId === 'cairn-drift' && cases.persistedInactive.source === 'default',
    'Legacy persisted NEEDLE selection escaped the release gate.', cases);
  verify(cases.persistedRingfall.courseId === 'ringfall' && cases.persistedRingfall.source === 'persisted',
    'Valid active persisted stage was not restored.', cases);

  const source = 'http://127.0.0.1:4173/?seed=1337&briefing=1&ref=contract#route';
  const inactiveUrl = new URL(buildCourseUrl(source, 'needle-grave'));
  verify(inactiveUrl.searchParams.get('course') === 'cairn-drift',
    'Route URL builder minted a disabled NEEDLE URL.');
  const built = new URL(buildCourseUrl(source, 'ringfall'));
  verify(built.searchParams.get('course') === 'ringfall', 'Route URL builder lost an active stage ID.');
  verify(!built.searchParams.has('seed'), 'Normal route navigation retained a debug seed.');
  verify(built.searchParams.get('briefing') === '1' && built.searchParams.get('ref') === 'contract',
    'Route URL discarded unrelated query state.', { href: built.href });
  verify(built.hash === '#route', 'Route URL discarded the fragment.', { href: built.href });
  const harnessUrl = new URL(buildCourseUrl(source, 'wreckline', { preserveSeed: true }));
  verify(harnessUrl.searchParams.get('seed') === '1337', 'Harness route navigation lost its explicit seed.');
  return { cases, routeUrl: built.href, inactiveUrl: inactiveUrl.href, harnessUrl: harnessUrl.href };
});

await report.check({
  id: 'CAMPAIGN.progress-merge',
  name: 'Progress facts merge monotonically and unlocks derive only from ordered clears',
  assertion: 'All recognized course facts survive merge, dormant NEEDLE stays inactive, and rank/clean/precision facts never substitute for clearing every prior active stage.',
}, () => {
  const local = new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify(progress({
      selectedCourse: 'cairn-drift',
      courses: {
        'cairn-drift': courseProgress({ cleared: true, clearedAt: 400, highestRank: 'B' }),
        'needle-grave': courseProgress({ cleared: true, clearedAt: 500, highestRank: 'C' }),
        wreckline: courseProgress({ cleared: true, clearedAt: 700, highestRank: 'B' }),
        ringfall: courseProgress({ cleared: true, clearedAt: 900, highestRank: 'C' }),
      },
    })),
  });
  const session = new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify(progress({
      selectedCourse: 'needle-grave',
      courses: {
        'cairn-drift': courseProgress({
          cleared: true,
          clearedAt: 200,
          highestRank: 'A',
          cleanClear: true,
          precisionClear: true,
        }),
        wreckline: courseProgress({
          clearedAt: 650,
          highestRank: 'A',
          cleanClear: true,
          precisionClear: true,
        }),
      },
    })),
  });
  const merged = new ProgressStore({ localStorage: local, sessionStorage: session, hasLegacyCairnBest: () => false }).snapshot();
  const cairn = merged.courses['cairn-drift'];
  verify(merged.selectedCourse === 'cairn-drift', 'Legacy disabled selection did not fall back.', merged);
  verify(cairn?.clearedAt === 200 && cairn.highestRank === 'A', 'Earlier clear/better rank did not win.', merged);
  verify(cairn.cleanClear && cairn.precisionClear, 'Monotonic mastery flags were lost.', merged);
  verify(!isCourseUnlocked(merged, 'needle-grave'), 'Dormant NEEDLE became unlocked.', merged);
  verify(merged.courses['needle-grave']?.cleared === true
    && merged.courses['needle-grave']?.highestRank === 'C',
  'Disabling campaign erased dormant NEEDLE progress facts.', merged);
  verify(merged.courses.wreckline?.cleared === true
    && merged.courses.wreckline.clearedAt === 650
    && merged.courses.wreckline.highestRank === 'A'
    && merged.courses.wreckline.cleanClear
    && merged.courses.wreckline.precisionClear,
  'WRECKLINE facts did not merge monotonically.', merged);
  verify(merged.courses.ringfall?.cleared === true,
    'RINGFALL facts were dropped during recognized-course sanitization.', merged);
  verify(isCourseUnlocked(merged, 'wreckline') && isCourseUnlocked(merged, 'ringfall'),
    'Ordered clear facts did not unlock the active chapter.', merged);

  const clearOnly = progress({ courses: {
    'cairn-drift': courseProgress({ cleared: true }),
  } });
  const allPriorClearOnly = progress({ courses: {
    'cairn-drift': courseProgress({ cleared: true }),
    wreckline: courseProgress({ cleared: true }),
  } });
  const masteryWithoutClear = progress({ courses: {
    'cairn-drift': courseProgress({ highestRank: 'S', cleanClear: true, precisionClear: true }),
  } });
  verify(isCourseUnlocked(clearOnly, 'wreckline') && !isCourseUnlocked(clearOnly, 'ringfall'),
    'Clearing CAIRN did not unlock exactly the next stage.', clearOnly);
  verify(isCourseUnlocked(allPriorClearOnly, 'ringfall'),
    'Clear-only facts did not unlock RINGFALL.', allPriorClearOnly);
  verify(!isCourseUnlocked(masteryWithoutClear, 'wreckline'),
    'Mastery facts unlocked a stage without a clear.', masteryWithoutClear);

  const migrated = new ProgressStore({
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    hasLegacyCairnBest: () => true,
  }).snapshot();
  verify(migrated.courses['cairn-drift']?.cleared === true, 'Legacy PB was not migrated to a clear.', migrated);
  verify(migrated.courses['cairn-drift']?.highestRank === null
    && migrated.courses['cairn-drift']?.clearedAt === null,
  'Legacy migration invented unsupported mastery evidence.', migrated);

  const corrupt = new ProgressStore({
    localStorage: new MemoryStorage({ [PROGRESS_KEY]: '{broken' }),
    sessionStorage: new MemoryStorage(),
    hasLegacyCairnBest: () => true,
  }).snapshot();
  verify(corrupt.courses['cairn-drift'] === undefined,
    'A present corrupt campaign record incorrectly triggered legacy migration.', corrupt);

  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let legacyProbe;
  try {
    const legacyStorage = new MemoryStorage({
      'last-vector.best.v1': JSON.stringify({
        'cairn-drift-corrupt': null,
        'cairn-drift-4294967296': 70,
        'cairn-drift-1337': { time: 72.5, splits: [] },
      }),
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: legacyStorage,
    });
    legacyProbe = hasBestRunPrefix('cairn-drift-');
    verify(legacyProbe === true, 'A valid legacy seeded PB was not recognized.', { legacyProbe });
    legacyStorage.setItem('last-vector.best.v1', JSON.stringify({
      'cairn-drift-corrupt': null,
      'cairn-drift-4294967296': 70,
      'cairn-drift-12': -4,
    }));
    verify(hasBestRunPrefix('cairn-drift-') === false,
      'Malformed key/value pairs were accepted as a legacy clear.');
  } finally {
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
  return { merged, migrated, corrupt, legacyProbe };
});

await report.check({
  id: 'CAMPAIGN.progress-persistence',
  name: 'Successful finishes persist mastery and reveal each next stage exactly once',
  assertion: 'CAIRN and WRECKLINE clears reveal the ordered next stage independent of mastery, RINGFALL ends the chain, and inactive NEEDLE remains rejected under every storage condition.',
}, () => {
  const durable = new MemoryStorage();
  const failedSession = new MemoryStorage({}, { failSet: true });
  const store = new ProgressStore({
    localStorage: durable,
    sessionStorage: failedSession,
    hasLegacyCairnBest: () => false,
    now: () => 1234,
  });
  const rejectedNeedle = store.selectCourse('needle-grave');
  const rejectedRingfall = store.selectCourse('ringfall');
  verify(!rejectedNeedle.accepted && !rejectedRingfall.accepted,
    'Inactive or locked stage selection was accepted.', { rejectedNeedle, rejectedRingfall });
  const first = store.recordSuccessfulFinish('cairn-drift', runResult({
    rank: 'D',
    maxGateOffset: PRECISION_MAX_OFFSET,
  }));
  verify(first.newlyUnlocked === 'wreckline' && first.persistence.reloadSafe,
    'CAIRN clear did not reveal and persist WRECKLINE.', first);
  verify(first.progress.courses['cairn-drift']?.precisionClear === false,
    'Precision boundary 0.4 must be excluded.', first.progress);
  const second = store.recordSuccessfulFinish('cairn-drift', runResult({
    rank: 'A',
    maxGateOffset: PRECISION_MAX_OFFSET - 0.001,
  }));
  verify(second.newlyUnlocked === null, 'Unlock badge repeated after the first clear.', second);
  verify(second.progress.courses['cairn-drift']?.highestRank === 'A'
    && second.progress.courses['cairn-drift']?.precisionClear === true,
  'Subsequent non-PB mastery did not aggregate.', second.progress);
  const selectedWreckline = store.selectCourse('wreckline');
  verify(selectedWreckline.accepted, 'Newly unlocked WRECKLINE could not be selected.', selectedWreckline);
  const third = store.recordSuccessfulFinish('wreckline', runResult({
    courseId: 'wreckline',
    gatesCleared: 8,
    gatesTotal: 8,
    destinationName: 'NADIR RELAY',
    rank: 'D',
    maxGateOffset: 0.95,
  }));
  verify(third.newlyUnlocked === 'ringfall' && isCourseUnlocked(third.progress, 'ringfall'),
    'WRECKLINE clear did not reveal RINGFALL.', third);
  const fourth = store.recordSuccessfulFinish('ringfall', runResult({
    courseId: 'ringfall',
    destinationName: 'ORISON ARRAY',
  }));
  verify(fourth.newlyUnlocked === null, 'Chapter-final clear invented another stage.', fourth);
  verify(!store.selectCourse('needle-grave').accepted,
    'Completing Chapter 01 activated dormant NEEDLE.');

  const sharedDurable = new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify(progress({
      courses: {
        'cairn-drift': courseProgress({
          cleared: true,
          clearedAt: 100,
          highestRank: 'B',
        }),
      },
    })),
  });
  const tabA = new ProgressStore({
    localStorage: sharedDurable,
    sessionStorage: new MemoryStorage(),
    hasLegacyCairnBest: () => false,
    now: () => 200,
  });
  const staleTabB = new ProgressStore({
    localStorage: sharedDurable,
    sessionStorage: new MemoryStorage(),
    hasLegacyCairnBest: () => false,
    now: () => 300,
  });
  const tabAWreckline = tabA.recordSuccessfulFinish('wreckline', runResult({
    courseId: 'wreckline',
    gatesCleared: 8,
    gatesTotal: 8,
    destinationName: 'NADIR RELAY',
    rank: 'A',
    cleanRun: true,
    maxGateOffset: 0.2,
  }));
  const staleTabBCairn = staleTabB.recordSuccessfulFinish('cairn-drift', runResult({ rank: 'S' }));
  const afterStaleWrite = new ProgressStore({
    localStorage: sharedDurable,
    sessionStorage: new MemoryStorage(),
    hasLegacyCairnBest: () => false,
  }).snapshot();
  verify(tabAWreckline.progress.courses.wreckline?.cleared === true
    && staleTabBCairn.progress.courses.wreckline?.cleared === true
    && afterStaleWrite.courses.wreckline?.cleared === true
    && afterStaleWrite.courses.wreckline.clearedAt === 200
    && afterStaleWrite.courses.wreckline.highestRank === 'A'
    && afterStaleWrite.courses.wreckline.cleanClear
    && afterStaleWrite.courses.wreckline.precisionClear
    && isCourseUnlocked(afterStaleWrite, 'ringfall'),
  'A stale tab finish erased a later-stage clear written by another tab.', {
    tabAWreckline,
    staleTabBCairn,
    afterStaleWrite,
    stored: sharedDurable.getItem(PROGRESS_KEY),
  });

  const futureRaw = JSON.stringify(progress({ version: 2, courses: {
    'cairn-drift': courseProgress({ cleared: true }),
  } }));
  const future = new MemoryStorage({ [PROGRESS_KEY]: futureRaw });
  const futureStore = new ProgressStore({
    localStorage: future,
    sessionStorage: new MemoryStorage({}, { failSet: true }),
    hasLegacyCairnBest: () => false,
  });
  const futureWrite = futureStore.selectCourse('wreckline');
  verify(futureWrite.accepted && !futureWrite.persistence.localWritten,
    'A valid selection did not respect the newer read-only durable schema.', futureWrite);
  verify(future.getItem(PROGRESS_KEY) === futureRaw && future.writes === 0,
    'A newer durable schema was overwritten.', { stored: future.getItem(PROGRESS_KEY), writes: future.writes });

  const lateFuture = new MemoryStorage();
  const lateFutureStore = new ProgressStore({
    localStorage: lateFuture,
    sessionStorage: new MemoryStorage({}, { failSet: true }),
    hasLegacyCairnBest: () => false,
  });
  const lateFutureRaw = JSON.stringify(progress({ version: 2, courses: {
    'cairn-drift': courseProgress({ cleared: true, highestRank: 'A' }),
  } }));
  lateFuture.setItem(PROGRESS_KEY, lateFutureRaw);
  const lateFutureFinish = lateFutureStore.recordSuccessfulFinish(
    'cairn-drift',
    runResult({ rank: 'S' }),
  );
  verify(lateFutureFinish.persistence.localReadOnly
    && !lateFutureFinish.persistence.localWritten
    && !lateFutureFinish.persistence.reloadSafe
    && lateFuture.getItem(PROGRESS_KEY) === lateFutureRaw
    && lateFuture.writes === 1,
  'A future durable schema arriving after construction was overwritten during a stale write.', {
    lateFutureFinish,
    stored: lateFuture.getItem(PROGRESS_KEY),
    writes: lateFuture.writes,
  });

  const nowhere = new ProgressStore({
    localStorage: new MemoryStorage({}, { failSet: true }),
    sessionStorage: new MemoryStorage({}, { failSet: true }),
    hasLegacyCairnBest: () => false,
  });
  const inMemory = nowhere.recordSuccessfulFinish('cairn-drift', runResult({ rank: 'C', maxGateOffset: 0.9 }));
  verify(!inMemory.persistence.reloadSafe && isCourseUnlocked(inMemory.progress, 'wreckline')
    && !isCourseUnlocked(inMemory.progress, 'needle-grave')
    && inMemory.newlyUnlocked === 'wreckline',
  'Dual write failure corrupted in-memory unlock truth or claimed reload safety.', inMemory);

  const installLocal = new MemoryStorage();
  const installSession = new MemoryStorage();
  const installStore = new ProgressStore({
    localStorage: installLocal,
    sessionStorage: installSession,
    hasLegacyCairnBest: () => false,
  });
  const installed = installStore.install(progress({ courses: {
    'cairn-drift': courseProgress({ cleared: true }),
  } }));
  verify(installed.sessionWritten && !installed.localWritten
    && installSession.writes === 2 && installLocal.writes === 0,
  'Test installation was not isolated to ephemeral session storage.', {
    installed,
    sessionWrites: installSession.writes,
    localWrites: installLocal.writes,
  });
  installStore.recordSuccessfulFinish('cairn-drift', runResult({ rank: 'A' }));
  const reloadedInstallStore = new ProgressStore({
    localStorage: installLocal,
    sessionStorage: installSession,
    hasLegacyCairnBest: () => false,
  });
  const installedSelection = reloadedInstallStore.selectCourse('wreckline');
  verify(installedSelection.accepted, 'Session-installed CAIRN clear did not authorize WRECKLINE.');
  verify(installLocal.writes === 0,
    'A later write or reload leaked harness-installed progress into durable storage.', {
      sessionWrites: installSession.writes,
      localWrites: installLocal.writes,
      reloaded: reloadedInstallStore.snapshot(),
    });
  return {
    first,
    second,
    third,
    fourth,
    futureWrite,
    tabAWreckline,
    staleTabBCairn,
    afterStaleWrite,
    lateFutureFinish,
    inMemory,
    installed,
    installLocalWrites: installLocal.writes,
  };
});

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
