import {
  COURSE_ORDER,
  courseRecordId,
  getCourseDefinition,
  getNextCourse,
} from '../../src/core/Courses.ts';
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

const options = parseOptions('campaign-contract', process.argv.slice(2));
const report = new Report('campaign-contract', options);

await report.check({
  id: 'CAMPAIGN.catalog-contract',
  name: 'The two-route catalog has stable identities and authored boundaries',
  assertion: 'CAIRN remains first with nine gates and its historical record prefix; NEEDLE follows with six gates, four SHEAR gates, NADIR identity, and bounded source distances (the browser arm measures the final curve at 24–26 km).',
}, () => {
  verify(JSON.stringify(COURSE_ORDER) === JSON.stringify(['cairn-drift', 'needle-grave']),
    'Catalog order changed.', { order: COURSE_ORDER });
  const cairn = getCourseDefinition('cairn-drift');
  const needle = getCourseDefinition('needle-grave');
  const authoredNeedleLength = needle.geometry.legs.reduce(
    (sum, leg) => sum + leg.length * needle.geometry.gateSpacing,
    needle.geometry.startOffsetMetres
      + needle.geometry.runOutSteps * needle.geometry.runOutStepMetres
      + needle.geometry.terminusStandoff,
  );
  verify(cairn.geometry.legs.length === 9, 'CAIRN gate count changed.', { gateCount: cairn.geometry.legs.length });
  verify(courseRecordId(cairn, 1337) === 'cairn-drift-1337', 'CAIRN PB identity changed.');
  verify(getNextCourse('cairn-drift') === 'needle-grave' && getNextCourse('needle-grave') === null,
    'Sequential route order is not stable.');
  verify(needle.geometry.legs.length === 6, 'NEEDLE must contain six gates.');
  verify(JSON.stringify(needle.shear?.gates) === JSON.stringify([2, 3, 4, 5]),
    'NEEDLE SHEAR indices changed.', { gates: needle.shear?.gates ?? null });
  verify(needle.text.canonicalDestination === 'NADIR RELAY', 'NEEDLE destination identity changed.');
  verify(authoredNeedleLength >= 24_000 && authoredNeedleLength <= 30_000,
    'NEEDLE authored distances are outside the safe construction envelope.', { authoredNeedleLength });
  return {
    order: COURSE_ORDER,
    cairn: { gates: cairn.geometry.legs.length, recordId: courseRecordId(cairn, 1337) },
    needle: {
      gates: needle.geometry.legs.length,
      shearGates: needle.shear?.gates,
      authoredNeedleLength,
      destination: needle.text.canonicalDestination,
    },
  };
});

await report.check({
  id: 'CAMPAIGN.route-resolution',
  name: 'Route URLs authorize only known unlocked courses',
  assertion: 'Explicit unknown and locked URLs fall directly to CAIRN, unlocked NEEDLE is accepted, absent URLs honor an unlocked selection, and generated URLs preserve unrelated state while dropping debug seeds.',
}, () => {
  const locked = progress({ selectedCourse: 'cairn-drift' });
  const unlocked = progress({
    selectedCourse: 'needle-grave',
    courses: { 'cairn-drift': courseProgress({ cleared: true }) },
  });
  const cases = {
    unknown: resolveCourseSelection('not-a-route', unlocked),
    locked: resolveCourseSelection('needle-grave', locked),
    explicit: resolveCourseSelection('needle-grave', unlocked),
    persisted: resolveCourseSelection(null, unlocked),
  };
  verify(cases.unknown.courseId === 'cairn-drift' && cases.unknown.source === 'invalid-url',
    'Unknown URL did not fail closed.', cases);
  verify(cases.locked.courseId === 'cairn-drift' && cases.locked.source === 'locked-url',
    'Locked URL did not fail closed.', cases);
  verify(cases.explicit.courseId === 'needle-grave' && cases.explicit.source === 'url',
    'Authorized explicit NEEDLE URL was rejected.', cases);
  verify(cases.persisted.courseId === 'needle-grave' && cases.persisted.source === 'persisted',
    'Unlocked persisted selection was not honored.', cases);

  const source = 'http://127.0.0.1:4173/?seed=1337&briefing=1&ref=contract#route';
  const built = new URL(buildCourseUrl(source, 'needle-grave'));
  verify(built.searchParams.get('course') === 'needle-grave', 'Route URL omitted the course ID.');
  verify(!built.searchParams.has('seed'), 'Normal route navigation retained a debug seed.');
  verify(built.searchParams.get('briefing') === '1' && built.searchParams.get('ref') === 'contract',
    'Route URL discarded unrelated query state.', { href: built.href });
  verify(built.hash === '#route', 'Route URL discarded the fragment.', { href: built.href });
  return { cases, routeUrl: built.href };
});

await report.check({
  id: 'CAMPAIGN.progress-merge',
  name: 'Session and durable progress merge monotonically and safely',
  assertion: 'Clear/mastery facts OR together, better rank and earlier clear time win, the unlocked session selection wins, corrupt input is tolerated, and migration runs only when campaign records are absent.',
}, () => {
  const local = new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify(progress({
      selectedCourse: 'cairn-drift',
      courses: {
        'cairn-drift': courseProgress({ cleared: true, clearedAt: 400, highestRank: 'B' }),
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
      },
    })),
  });
  const merged = new ProgressStore({ localStorage: local, sessionStorage: session, hasLegacyCairnBest: () => false }).snapshot();
  const cairn = merged.courses['cairn-drift'];
  verify(merged.selectedCourse === 'needle-grave', 'Valid session selection did not win.', merged);
  verify(cairn?.clearedAt === 200 && cairn.highestRank === 'A', 'Earlier clear/better rank did not win.', merged);
  verify(cairn.cleanClear && cairn.precisionClear, 'Monotonic mastery flags were lost.', merged);
  verify(isCourseUnlocked(merged, 'needle-grave'), 'Merged predecessor clear did not unlock NEEDLE.', merged);

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
  name: 'Campaign writes remain useful under partial and total storage failure',
  assertion: 'A CAIRN finish unlocks in memory independent of mastery, strict precision uses <0.4, either storage target is reload-safe, newer schemas are not overwritten, and locked selection is rejected.',
}, () => {
  const durable = new MemoryStorage();
  const failedSession = new MemoryStorage({}, { failSet: true });
  const store = new ProgressStore({
    localStorage: durable,
    sessionStorage: failedSession,
    hasLegacyCairnBest: () => false,
    now: () => 1234,
  });
  const rejected = store.selectCourse('needle-grave');
  verify(!rejected.accepted, 'Locked NEEDLE selection was accepted.', rejected);
  const first = store.recordSuccessfulFinish('cairn-drift', runResult({ rank: 'D', maxGateOffset: 0.4 }));
  verify(first.newlyUnlocked === 'needle-grave' && first.persistence.reloadSafe,
    'First clear did not unlock with one surviving storage target.', first);
  verify(first.progress.courses['cairn-drift']?.precisionClear === false,
    'Precision boundary 0.4 must be excluded.', first.progress);
  const second = store.recordSuccessfulFinish('cairn-drift', runResult({ rank: 'A', maxGateOffset: 0.399 }));
  verify(second.newlyUnlocked === null, 'Unlock badge repeated after the first clear.', second);
  verify(second.progress.courses['cairn-drift']?.highestRank === 'A'
    && second.progress.courses['cairn-drift']?.precisionClear === true,
  'Subsequent non-PB mastery did not aggregate.', second.progress);

  const futureRaw = JSON.stringify(progress({ version: 2, courses: {
    'cairn-drift': courseProgress({ cleared: true }),
  } }));
  const future = new MemoryStorage({ [PROGRESS_KEY]: futureRaw });
  const futureStore = new ProgressStore({
    localStorage: future,
    sessionStorage: new MemoryStorage({}, { failSet: true }),
    hasLegacyCairnBest: () => false,
  });
  const futureWrite = futureStore.selectCourse('needle-grave');
  verify(futureWrite.accepted && !futureWrite.persistence.localWritten,
    'Understood future progress could not be used or was reported writable.', futureWrite);
  verify(future.getItem(PROGRESS_KEY) === futureRaw && future.writes === 0,
    'A newer durable schema was overwritten.', { stored: future.getItem(PROGRESS_KEY), writes: future.writes });

  const nowhere = new ProgressStore({
    localStorage: new MemoryStorage({}, { failSet: true }),
    sessionStorage: new MemoryStorage({}, { failSet: true }),
    hasLegacyCairnBest: () => false,
  });
  const inMemory = nowhere.recordSuccessfulFinish('cairn-drift', runResult({ rank: 'C', maxGateOffset: 0.9 }));
  verify(!inMemory.persistence.reloadSafe && isCourseUnlocked(inMemory.progress, 'needle-grave'),
    'Dual write failure lost the in-memory unlock or claimed reload safety.', inMemory);

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
  reloadedInstallStore.selectCourse('needle-grave');
  verify(installLocal.writes === 0,
    'A later write or reload leaked harness-installed progress into durable storage.', {
      sessionWrites: installSession.writes,
      localWrites: installLocal.writes,
      reloaded: reloadedInstallStore.snapshot(),
    });
  return { first, second, futureWrite, inMemory, installed, installLocalWrites: installLocal.writes };
});

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
