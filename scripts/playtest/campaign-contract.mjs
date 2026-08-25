import { createHash } from 'node:crypto';
import * as THREE from 'three';
import {
  CAIRN_DRIFT,
  CHAPTER_ONE_STAGE_ORDER,
  KNOWN_COURSE_ORDER,
  isCourseAvailable,
} from '../../src/core/Courses.ts';
import {
  ACTIVE_MISSION_ORDER,
  CAIRN_MISSION,
  DORMANT_COURSE_ORDER,
  LAST_ASCENT_MISSION,
  getNextMission,
  missionRecordId,
} from '../../src/core/Missions.ts';
import {
  buildMissionUrl,
  resolveMissionSelection,
} from '../../src/core/MissionSelection.ts';
import {
  LEGACY_PROGRESS_KEY,
  PROGRESS_KEY,
  ProgressStore,
} from '../../src/core/Progress.ts';
import { Course } from '../../src/game/Course.ts';
import { FlightPath } from '../../src/game/FlightPath.ts';
import { GateRaceObjective } from '../../src/game/GateRaceObjective.ts';
import {
  createGameMissionRuntime,
  MissionRuntime,
} from '../../src/game/MissionRuntime.ts';
import { createLightingUniforms } from '../../src/render/lighting.ts';
import { Report, parseOptions, verify } from './runtime.mjs';

const PATH_SIGNATURE = 'cf64cc23e6accbd750712bb2a2140d5a0ac3dc55dbdce4851166846f24f7f605';
const GATE_SIGNATURE = '22ff40ffc12de5522e8cf83f6c8f0407201d2462d9b5e064d628c5c511c7cefc';

class MemoryStorage {
  constructor(initial = {}, failures = {}) {
    this.values = new Map(Object.entries(initial));
    this.failSet = failures.failSet === true;
    this.writes = 0;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failSet) throw new Error('write denied');
    this.writes += 1;
    this.values.set(key, String(value));
  }
}

const missionFacts = (patch = {}) => ({
  cleared: false,
  clearedAt: null,
  highestRank: null,
  cleanClear: false,
  mastery: {},
  ...patch,
});

const dormantFacts = (patch = {}) => ({
  cleared: false,
  clearedAt: null,
  highestRank: null,
  cleanClear: false,
  precisionClear: false,
  ...patch,
});

const result = (patch = {}) => ({
  kind: 'gate-race',
  missionId: 'cairn-drift',
  rulesetVersion: 2,
  totalTime: 90,
  hullRemaining: 1,
  objectiveSummary: '9 / 9',
  splits: [],
  bestTime: null,
  bestSplits: [],
  isNewBest: false,
  gatesCleared: 9,
  gatesTotal: 9,
  topSpeed: 1000,
  cleanRun: true,
  rank: 'A',
  destinationName: 'VESPER TERMINUS',
  maxGateOffset: 0.2,
  newlyUnlockedMissionId: null,
  ...patch,
});

const escapeResult = (patch = {}) => ({
  kind: 'escape',
  missionId: 'last-ascent',
  rulesetVersion: 1,
  totalTime: 103,
  hullRemaining: 1,
  objectiveSummary: '3 / 3 SAFE',
  topSpeed: 898,
  cleanRun: true,
  rank: 'S',
  destinationName: 'ORBITAL EXTRACTION',
  newlyUnlockedMissionId: null,
  checkpointsCleared: 3,
  checkpointsTotal: 3,
  secondsAhead: 5,
  ...patch,
});

const round = (value) => Number(value.toFixed(6));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function courseSignatures(course) {
  const path = {
    start: [...course.startPosition].map(round),
    startQ: [...course.startQuaternion].map(round),
    terminus: [...course.terminusPosition].map(round),
    normal: [...course.terminusNormal].map(round),
    total: round(course.totalLength),
    spine: course.spine.map((point) => [...point].map(round)),
    channel: course.clearChannel.map((segment) => ({
      a: [...segment.a].map(round),
      b: [...segment.b].map(round),
      r: round(segment.radius),
    })),
  };
  const gates = course.gates.map((gate) => ({
    p: [...gate.position].map(round),
    n: [...gate.normal].map(round),
    r: round(gate.radius),
  }));
  return { path: hash(path), gates: hash(gates) };
}

const options = parseOptions('campaign-contract', process.argv.slice(2));
const report = new Report('campaign-contract', options);

await report.check({
  id: 'MISSION.catalog-path',
  name: 'CAIRN and LAST ASCENT are active while the CAIRN path/gates stay unchanged',
  assertion: 'The two mission catalog is ordered, dormant courses stay quarantined, and PB identities partition by ruleset.',
}, () => {
  verify(JSON.stringify(ACTIVE_MISSION_ORDER) === JSON.stringify(['cairn-drift', 'last-ascent']),
    'The active campaign is not ordered CAIRN then LAST ASCENT.', ACTIVE_MISSION_ORDER);
  verify(JSON.stringify(CHAPTER_ONE_STAGE_ORDER) === JSON.stringify(['cairn-drift']),
    'The legacy availability projection did not collapse with the active campaign.');
  verify(JSON.stringify(KNOWN_COURSE_ORDER)
    === JSON.stringify(['cairn-drift', 'needle-grave', 'wreckline', 'ringfall']),
  'Dormant recognized definitions were lost.', KNOWN_COURSE_ORDER);
  verify(JSON.stringify(DORMANT_COURSE_ORDER)
    === JSON.stringify(['needle-grave', 'wreckline', 'ringfall']),
  'Dormant recognized definitions are not partitioned from missions.', DORMANT_COURSE_ORDER);
  verify(isCourseAvailable('cairn-drift')
    && !isCourseAvailable('needle-grave')
    && !isCourseAvailable('wreckline')
    && !isCourseAvailable('ringfall'),
  'A retired course remains release-active.');
  verify(CAIRN_MISSION.chapter === 1
    && CAIRN_MISSION.objective.kind === 'gate-race'
    && CAIRN_MISSION.world.sourceCourse === CAIRN_DRIFT
    && CAIRN_MISSION.capabilities.length === 0
    && getNextMission('cairn-drift') === 'last-ascent',
  'The Chapter 01 mission definition crossed a foundation boundary.', CAIRN_MISSION);
  verify(LAST_ASCENT_MISSION.chapter === 2
    && LAST_ASCENT_MISSION.objective.kind === 'escape'
    && LAST_ASCENT_MISSION.capabilities.length === 0
    && LAST_ASCENT_MISSION.mastery.includes('precision')
    && getNextMission('last-ascent') === null,
  'The Chapter 02 mission is not a bounded escape definition.', LAST_ASCENT_MISSION);
  verify(missionRecordId(CAIRN_MISSION, 1337) === 'cairn-drift-r2-1337',
    'Ruleset 2 did not partition the current PB identity.');
  verify(missionRecordId(LAST_ASCENT_MISSION, 1337) === 'last-ascent-r1-1337',
    'LAST ASCENT did not receive an independent ruleset PB identity.');

  const course = new Course(
    CAIRN_DRIFT,
    CAIRN_DRIFT.defaultSeed,
    createLightingUniforms(new THREE.Vector3(...CAIRN_DRIFT.world.sunDirection)),
  );
  const signatures = courseSignatures(course);
  course.dispose();
  verify(signatures.path === PATH_SIGNATURE && signatures.gates === GATE_SIGNATURE,
    'FlightPath extraction changed the locked CAIRN route or gate signature.', signatures);
  return {
    active: ACTIVE_MISSION_ORDER,
    dormant: DORMANT_COURSE_ORDER,
    recordId: missionRecordId(CAIRN_MISSION, 1337),
    signatures,
  };
});

await report.check({
  id: 'MISSION.url-resolution',
  name: 'Canonical mission URLs enforce clear-only LAST ASCENT unlocks and fail closed',
  assertion: 'mission takes precedence, locked/retired/unknown IDs fall back, and canonical URLs delete course.',
}, () => {
  const progress = { version: 2, selectedMission: 'cairn-drift', missions: {}, dormantCourses: {} };
  const unlocked = {
    ...progress,
    missions: { 'cairn-drift': missionFacts({ cleared: true }) },
  };
  const cases = {
    canonical: resolveMissionSelection({ mission: 'cairn-drift', legacyCourse: null }, progress),
    lockedAscent: resolveMissionSelection({ mission: 'last-ascent', legacyCourse: null }, progress),
    unlockedAscent: resolveMissionSelection({ mission: 'last-ascent', legacyCourse: null }, unlocked),
    alias: resolveMissionSelection({ mission: null, legacyCourse: 'cairn-drift' }, progress),
    retired: resolveMissionSelection({ mission: null, legacyCourse: 'wreckline' }, progress),
    unknown: resolveMissionSelection({ mission: 'unknown-mission', legacyCourse: 'cairn-drift' }, progress),
  };
  verify(cases.canonical.source === 'mission-url'
    && cases.lockedAscent.source === 'invalid-mission-url'
    && cases.lockedAscent.missionId === 'cairn-drift'
    && cases.unlockedAscent.source === 'mission-url'
    && cases.unlockedAscent.missionId === 'last-ascent'
    && cases.alias.source === 'legacy-course-url'
    && cases.retired.source === 'invalid-course-url'
    && cases.unknown.source === 'invalid-mission-url'
    && Object.entries(cases).every(([name, entry]) =>
      name === 'unlockedAscent' || entry.missionId === 'cairn-drift'),
  'Mission resolution did not fail closed.', cases);
  const built = new URL(buildMissionUrl(
    'https://example.test/game?course=cairn-drift&seed=9&briefing=1',
    'cairn-drift',
  ));
  verify(built.searchParams.get('mission') === 'cairn-drift'
    && !built.searchParams.has('course')
    && !built.searchParams.has('seed')
    && built.searchParams.get('briefing') === '1',
  'Canonical mission navigation retained a legacy or ephemeral parameter.', built.href);
  const ascentBuilt = new URL(buildMissionUrl(built, 'last-ascent'));
  verify(ascentBuilt.searchParams.get('mission') === 'last-ascent'
    && !ascentBuilt.searchParams.has('course')
    && !ascentBuilt.searchParams.has('seed'),
  'LAST ASCENT navigation did not write a canonical mission URL.', ascentBuilt.href);
  return { cases, built: built.href, ascentBuilt: ascentBuilt.href };
});

await report.check({
  id: 'MISSION.progress-v2',
  name: 'Progress v2 migrates CAIRN facts and quarantines retired stage clears',
  assertion: 'Local/session merges are monotonic and a future schema remains read-only.',
}, () => {
  const legacy = new MemoryStorage({
    [LEGACY_PROGRESS_KEY]: JSON.stringify({
      version: 1,
      selectedCourse: 'ringfall',
      courses: {
        'cairn-drift': dormantFacts({
          cleared: true,
          clearedAt: 200,
          highestRank: 'B',
          cleanClear: true,
          precisionClear: true,
        }),
        wreckline: dormantFacts({ cleared: true, highestRank: 'S' }),
        ringfall: dormantFacts({ cleared: true, clearedAt: 300 }),
        'needle-grave': dormantFacts({ precisionClear: true }),
      },
    }),
  });
  const migrated = new ProgressStore({
    localStorage: legacy,
    sessionStorage: new MemoryStorage(),
    hasLegacyCairnBest: () => false,
  }).snapshot();
  verify(migrated.version === 2
    && migrated.selectedMission === 'cairn-drift'
    && migrated.missions['cairn-drift']?.cleared === true
    && migrated.missions['cairn-drift']?.highestRank === 'B'
    && migrated.missions['cairn-drift']?.cleanClear === true
    && migrated.missions['cairn-drift']?.mastery.precision === true,
  'Supported CAIRN facts did not migrate to the mission record.', migrated);
  verify(Object.keys(migrated.missions).length === 1
    && migrated.dormantCourses.wreckline?.cleared === true
    && migrated.dormantCourses.ringfall?.cleared === true
    && migrated.dormantCourses['needle-grave']?.precisionClear === true,
  'Retired stage facts were promoted or discarded.', migrated);

  const durable = new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify({
      version: 2,
      selectedMission: 'cairn-drift',
      missions: {
        'cairn-drift': missionFacts({ cleared: true, clearedAt: 300, highestRank: 'B' }),
      },
      dormantCourses: { wreckline: dormantFacts({ cleared: true }) },
    }),
  });
  const session = new MemoryStorage({
    [PROGRESS_KEY]: JSON.stringify({
      version: 2,
      selectedMission: 'cairn-drift',
      missions: {
        'cairn-drift': missionFacts({ clearedAt: 200, cleanClear: true, mastery: { precision: true } }),
      },
      dormantCourses: { wreckline: dormantFacts({ highestRank: 'A' }) },
    }),
  });
  const store = new ProgressStore({
    localStorage: durable,
    sessionStorage: session,
    hasLegacyCairnBest: () => false,
    now: () => 999,
  });
  const merged = store.snapshot();
  verify(merged.missions['cairn-drift']?.cleared
    && merged.missions['cairn-drift']?.clearedAt === 200
    && merged.missions['cairn-drift']?.highestRank === 'B'
    && merged.missions['cairn-drift']?.cleanClear
    && merged.missions['cairn-drift']?.mastery.precision
    && merged.dormantCourses.wreckline?.cleared
    && merged.dormantCourses.wreckline?.highestRank === 'A',
  'Progress facts did not merge monotonically.', merged);
  const finish = store.recordSuccessfulFinish('cairn-drift', result({ rank: 'S' }));
  verify(finish.newlyUnlocked === null
    && finish.progress.missions['cairn-drift']?.highestRank === 'S',
  'A repeated CAIRN finish re-announced an unlock or lost a better rank.', finish);
  const unlockStore = new ProgressStore({
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    hasLegacyCairnBest: () => false,
    now: () => 1001,
  });
  const firstFinish = unlockStore.recordSuccessfulFinish('cairn-drift', result({ rank: 'A' }));
  verify(firstFinish.firstClear
    && firstFinish.newlyUnlocked === 'last-ascent'
    && firstFinish.progress.missions['cairn-drift']?.cleared,
  'A first CAIRN finish did not clear-only unlock LAST ASCENT.', firstFinish);
  const ascentFinish = store.recordSuccessfulFinish('last-ascent', escapeResult());
  verify(ascentFinish.newlyUnlocked === null
    && ascentFinish.progress.missions['last-ascent']?.cleared
    && ascentFinish.progress.missions['last-ascent']?.mastery.precision,
  'A complete safe-corridor escape did not record LAST ASCENT precision mastery.', ascentFinish);

  const futureRaw = JSON.stringify({
    version: 3,
    selectedMission: 'cairn-drift',
    missions: { 'cairn-drift': missionFacts({ cleared: true }) },
    dormantCourses: {},
  });
  const future = new MemoryStorage({ [PROGRESS_KEY]: futureRaw });
  const futureStore = new ProgressStore({
    localStorage: future,
    sessionStorage: new MemoryStorage({}, { failSet: true }),
    hasLegacyCairnBest: () => false,
  });
  const outcome = futureStore.recordSuccessfulFinish('cairn-drift', result());
  verify(outcome.persistence.localReadOnly
    && !outcome.persistence.localWritten
    && future.getItem(PROGRESS_KEY) === futureRaw
    && future.writes === 0,
  'A future progress schema was overwritten.', { outcome, stored: future.getItem(PROGRESS_KEY) });
  return { migrated, merged, finish, firstFinish, ascentFinish, future: outcome.persistence };
});

await report.check({
  id: 'MISSION.runtime-boundaries',
  name: 'GateRaceObjective and MissionRuntime own bounded objective/world lifecycles',
  assertion: 'Objective state has no UI/storage dependency and runtime disposes one objective/world.',
}, () => {
  const course = new Course(
    CAIRN_DRIFT,
    CAIRN_DRIFT.defaultSeed,
    createLightingUniforms(new THREE.Vector3(...CAIRN_DRIFT.world.sunDirection)),
  );
  const objective = new GateRaceObjective(
    course,
    CAIRN_DRIFT.destination.apertureRadius * 2.4,
    CAIRN_MISSION,
  );
  const calls = { reset: 0, update: 0, dispose: 0 };
  const world = {
    contacts: [],
    contactCapacity: 0,
    targetables: [],
    reset: () => { calls.reset += 1; },
    updateSimulation: () => { calls.update += 1; },
    updatePresentation: () => {},
    applyQuality: () => {},
    dispose: () => { calls.dispose += 1; },
  };
  const runtime = new MissionRuntime({ definition: CAIRN_MISSION, path: course.path, world, objective });
  runtime.reset();
  const guidance = objective.guidance(course.startPosition);
  const telemetry = objective.telemetry();
  verify(guidance.current === 0
    && guidance.total === 9
    && telemetry.kind === 'gate-race'
    && telemetry.gatesTotal === 9
    && runtime.path === course.path
    && calls.reset === 1,
  'Mission runtime did not expose the current objective/path boundary.', { guidance, telemetry, calls });
  runtime.dispose();
  verify(calls.dispose === 1, 'Mission runtime did not dispose its world exactly once.', calls);
  return { guidance: { ...guidance, anchor: [...guidance.anchor] }, telemetry, calls };
});

await report.check({
  id: 'MISSION.objective-neutral-factory',
  name: 'The Game-facing seam runs one escape/strike world through common contacts',
  assertion: 'One selected world constructs/adds/disposes; lethal contact wins before objective success.',
}, () => {
  const observations = [];
  for (const kind of ['escape', 'strike']) {
    const definition = {
      ...CAIRN_MISSION,
      objective: kind === 'escape'
        ? {
          kind,
          path: CAIRN_DRIFT.geometry,
          shockwave: { speed: 1, startProgress: 0, catchProgress: 1 },
        }
        : {
          kind,
          path: CAIRN_DRIFT.geometry,
          targets: [],
          extraction: { startProgress: 0, timeoutSeconds: 1 },
        },
    };
    const calls = {
      factory: 0,
      worldConstructed: 0,
      worldReset: 0,
      worldUpdate: 0,
      mainAdds: 0,
      farAdds: 0,
      objectiveReset: 0,
      objectiveUpdate: 0,
      bodyImpact: 0,
      contactFeedback: 0,
      objectiveDispose: 0,
      worldDispose: 0,
    };
    const path = new FlightPath(CAIRN_DRIFT.geometry, CAIRN_DRIFT.defaultSeed);
    const objective = {
      kind,
      reset: () => { calls.objectiveReset += 1; },
      update: () => {
        calls.objectiveUpdate += 1;
        return { status: 'succeeded' };
      },
      guidance: (position) => ({
        label: 'MOCK OBJECTIVE',
        anchor: path.terminusPosition,
        distance: position.distanceTo(path.terminusPosition),
        progress: 0,
        current: 0,
        total: 1,
      }),
      telemetry: () => kind === 'escape'
        ? {
          kind,
          pathProgress: 0,
          shockwaveProgress: 0,
          checkpoint: 0,
          checkpointTotal: 1,
        }
        : {
          kind,
          targetsDestroyed: 0,
          targetsRequired: 0,
          coreDestroyed: false,
          extracting: false,
        },
      bestRunSplits: () => [],
      buildResult: (input) => ({
        kind,
        missionId: definition.id,
        rulesetVersion: definition.rulesetVersion,
        totalTime: input.totalTime,
        hullRemaining: input.hullRemaining,
        objectiveSummary: 'MOCK COMPLETE',
        topSpeed: input.topSpeed,
        cleanRun: input.cleanRun,
        rank: 'A',
        destinationName: 'MOCK EXTRACTION',
        newlyUnlockedMissionId: null,
        ...(kind === 'escape'
          ? { checkpointsCleared: 1, checkpointsTotal: 1, secondsAhead: 1 }
          : {
            targetsDestroyed: 0,
            targetsRequired: 0,
            shotsFired: 0,
            shotsHit: 0,
            coreDestroyed: true,
          }),
      }),
      dispose: () => { calls.objectiveDispose += 1; },
    };
    const mainScene = {
      add: () => { calls.mainAdds += 1; },
    };
    const farScene = {
      add: () => { calls.farAdds += 1; },
    };
    const runtime = createGameMissionRuntime({
      definition,
      seed: CAIRN_DRIFT.defaultSeed,
      renderer: {},
      mainScene,
      farScene,
      lighting: {},
      initialQuality: {},
      maximumQuality: {},
    }, (context) => {
      calls.factory += 1;
      calls.worldConstructed += 1;
      context.mainScene.add({ kind });
      const world = {
        contacts: [{
          id: `${kind}:contact`,
          kind: 'hazard',
          position: new THREE.Vector3(1.5, 0, 0),
          radius: 1,
        }],
        contactCapacity: 1,
        targetables: [],
        reset: () => { calls.worldReset += 1; },
        updateSimulation: () => { calls.worldUpdate += 1; },
        updatePresentation: () => {},
        applyQuality: () => {},
        dispose: () => { calls.worldDispose += 1; },
      };
      return new MissionRuntime({ definition, path, world, objective });
    });
    runtime.reset();
    const body = {
      position: new THREE.Vector3(0, 0, 0),
      radius: 1,
      speed: 900,
      hull: 0.1,
      applyImpact: () => {
        calls.bodyImpact += 1;
        body.hull = 0;
        return 1;
      },
    };
    const simulation = runtime.simulate({
      dt: 1 / 60,
      elapsed: 12,
      body,
      proximityRange: 40,
      resolveContacts: true,
      resolveObjective: true,
      onContact: () => { calls.contactFeedback += 1; },
    });
    const built = runtime.buildResult({
      totalTime: 12,
      hullRemaining: 0.75,
      topSpeed: 900,
      cleanRun: true,
      bestTime: null,
      bestSplits: [],
      isNewBest: true,
      cruiseSpeed: 720,
    });
    verify(runtime.objective.kind === kind
      && built.kind === kind
      && runtime.recordId(CAIRN_DRIFT.defaultSeed) === missionRecordId(definition, CAIRN_DRIFT.defaultSeed)
      && runtime.bestRunSplits().length === 0
      && calls.factory === 1
      && calls.worldConstructed === 1
      && calls.mainAdds === 1
      && calls.farAdds === 0
      && calls.worldReset === 1
      && calls.objectiveReset === 1
      && calls.worldUpdate === 1
      && calls.bodyImpact === 1
      && calls.contactFeedback === 1
      && body.hull === 0
      && simulation.hullFailed
      && simulation.terminal === null
      && simulation.proximity > 0
      && calls.objectiveUpdate === 0,
    `The ${kind} mock did not cross the common Game world/contact boundary.`, {
      built,
      simulation,
      calls,
    });
    runtime.dispose();
    verify(calls.objectiveDispose === 1 && calls.worldDispose === 1,
      `The ${kind} mock runtime did not dispose one objective and one world.`, calls);
    observations.push({
      kind,
      resultKind: built.kind,
      recordId: runtime.recordId(CAIRN_DRIFT.defaultSeed),
      simulation,
      calls,
    });
  }
  return observations;
});

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
