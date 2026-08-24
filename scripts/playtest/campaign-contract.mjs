import {
  ACTIVE_COURSE_ORDER,
  CAMPAIGN_MODE_ENABLED,
  COURSE_ORDER,
  PRECISION_MAX_OFFSET,
  courseRecordId,
  getCourseDefinition,
  getNextCourse,
  isCourseAvailable,
} from '../../src/core/Courses.ts';
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

const options = parseOptions('campaign-contract', process.argv.slice(2));
const report = new Report('campaign-contract', options);

await report.check({
  id: 'CAMPAIGN.catalog-contract',
  name: 'The dormant campaign catalog retains its work behind one release gate',
  assertion: 'Campaign mode is disabled and CAIRN is the sole active route, while the authored NEEDLE definition remains intact for a later product decision.',
}, () => {
  verify(CAMPAIGN_MODE_ENABLED === false, 'Campaign mode unexpectedly became player-active.');
  verify(JSON.stringify(COURSE_ORDER) === JSON.stringify(['cairn-drift', 'needle-grave']),
    'Dormant authored catalog order changed.', { order: COURSE_ORDER });
  verify(JSON.stringify(ACTIVE_COURSE_ORDER) === JSON.stringify(['cairn-drift']),
    'Disabled mode exposes more than CAIRN.', { activeOrder: ACTIVE_COURSE_ORDER });
  verify(isCourseAvailable('cairn-drift') && !isCourseAvailable('needle-grave'),
    'Release availability does not match the active catalog.');
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
  verify(getNextCourse('cairn-drift') === null && getNextCourse('needle-grave') === null,
    'Disabled campaign still offers a next route.');
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
    campaignModeEnabled: CAMPAIGN_MODE_ENABLED,
    authoredOrder: COURSE_ORDER,
    activeOrder: ACTIVE_COURSE_ORDER,
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
  name: 'URL and saved selection fail closed while campaign mode is disabled',
  assertion: 'Unknown, explicit NEEDLE and legacy saved NEEDLE selections all resolve to CAIRN, and URL builders cannot mint a NEEDLE route.',
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
  verify(cases.explicit.courseId === 'cairn-drift' && cases.explicit.source === 'locked-url'
    && cases.explicit.diagnostic?.includes('disabled'),
  'Explicit NEEDLE URL escaped the release gate.', cases);
  verify(cases.persisted.courseId === 'cairn-drift' && cases.persisted.source === 'default',
    'Legacy persisted NEEDLE selection escaped the release gate.', cases);

  const source = 'http://127.0.0.1:4173/?seed=1337&briefing=1&ref=contract#route';
  const built = new URL(buildCourseUrl(source, 'needle-grave'));
  verify(built.searchParams.get('course') === 'cairn-drift',
    'Route URL builder minted a disabled NEEDLE URL.');
  verify(!built.searchParams.has('seed'), 'Normal route navigation retained a debug seed.');
  verify(built.searchParams.get('briefing') === '1' && built.searchParams.get('ref') === 'contract',
    'Route URL discarded unrelated query state.', { href: built.href });
  verify(built.hash === '#route', 'Route URL discarded the fragment.', { href: built.href });
  return { cases, routeUrl: built.href };
});

await report.check({
  id: 'CAMPAIGN.progress-merge',
  name: 'Progress facts survive while disabled selections fall back safely',
  assertion: 'Clear/mastery facts still merge monotonically and dormant NEEDLE facts are retained, but a legacy NEEDLE selection never becomes active.',
}, () => {
  const local = new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify(progress({
      selectedCourse: 'cairn-drift',
      courses: {
        'cairn-drift': courseProgress({ cleared: true, clearedAt: 400, highestRank: 'B' }),
        'needle-grave': courseProgress({ cleared: true, clearedAt: 500, highestRank: 'C' }),
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
  verify(merged.selectedCourse === 'cairn-drift', 'Legacy disabled selection did not fall back.', merged);
  verify(cairn?.clearedAt === 200 && cairn.highestRank === 'A', 'Earlier clear/better rank did not win.', merged);
  verify(cairn.cleanClear && cairn.precisionClear, 'Monotonic mastery flags were lost.', merged);
  verify(!isCourseUnlocked(merged, 'needle-grave'), 'Dormant NEEDLE became unlocked.', merged);
  verify(merged.courses['needle-grave']?.cleared === true
    && merged.courses['needle-grave']?.highestRank === 'C',
  'Disabling campaign erased dormant NEEDLE progress facts.', merged);

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
  name: 'CAIRN progress persists without unlocking the dormant campaign',
  assertion: 'CAIRN mastery remains durable and strict at <0.4, while NEEDLE selection and unlock stay rejected under every storage condition.',
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
  const first = store.recordSuccessfulFinish('cairn-drift', runResult({
    rank: 'D',
    maxGateOffset: PRECISION_MAX_OFFSET,
  }));
  verify(first.newlyUnlocked === null && first.persistence.reloadSafe,
    'CAIRN clear either unlocked a dormant route or failed to persist.', first);
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
  verify(!futureWrite.accepted && !futureWrite.persistence.localWritten,
    'Disabled selection was accepted against a newer read-only schema.', futureWrite);
  verify(future.getItem(PROGRESS_KEY) === futureRaw && future.writes === 0,
    'A newer durable schema was overwritten.', { stored: future.getItem(PROGRESS_KEY), writes: future.writes });

  const nowhere = new ProgressStore({
    localStorage: new MemoryStorage({}, { failSet: true }),
    sessionStorage: new MemoryStorage({}, { failSet: true }),
    hasLegacyCairnBest: () => false,
  });
  const inMemory = nowhere.recordSuccessfulFinish('cairn-drift', runResult({ rank: 'C', maxGateOffset: 0.9 }));
  verify(!inMemory.persistence.reloadSafe && !isCourseUnlocked(inMemory.progress, 'needle-grave')
    && inMemory.newlyUnlocked === null,
  'Dual write failure exposed a dormant unlock or claimed reload safety.', inMemory);

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
