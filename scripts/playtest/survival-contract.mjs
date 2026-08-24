import {
  DEFAULT_RUN_MODE_ID,
  SURVIVAL_RUN_MODE_ID,
  buildRunModeUrl,
  resolveRunMode,
} from '../../src/core/GameModes.ts';
import {
  SURVIVAL_RECORDS_KEY,
  SurvivalRecordStore,
} from '../../src/core/SurvivalRecords.ts';
import {
  SURVIVAL_RULESET_V1,
  SurvivalRun,
  deriveSurvivalPattern,
  survivalDifficultyAt,
} from '../../src/game/SurvivalRun.ts';
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

function collectAtRate(seed, hz, seconds) {
  const run = new SurvivalRun({ seed });
  const directives = [];
  for (let frame = 0; frame <= seconds * hz; frame += 1) {
    const advance = run.advanceTo(frame / hz, SURVIVAL_RULESET_V1.maxActiveMeteors);
    for (const pattern of advance.patterns) directives.push(pattern);
  }
  return { run, directives };
}

function compact(patterns) {
  return patterns.map((pattern) => ({
    patternIndex: pattern.patternIndex,
    kind: pattern.kind,
    scheduledAt: pattern.scheduledAt,
    spawns: pattern.spawns.map((spawn) => ({
      spawnId: spawn.spawnId,
      geometryVariant: spawn.geometryVariant,
      entryAzimuthRadians: spawn.entryAzimuthRadians,
      entryElevationRadians: spawn.entryElevationRadians,
      targetOffsetX: spawn.targetOffsetX,
      targetOffsetY: spawn.targetOffsetY,
      speed: spawn.speed,
      reactionSeconds: spawn.reactionSeconds,
      radius: spawn.radius,
      spinAxis: spawn.spinAxis,
      spinRate: spawn.spinRate,
    })),
  }));
}

function result(run, seconds, patch = {}) {
  return {
    ...run.finish(seconds),
    ...patch,
  };
}

const options = parseOptions('survival-contract', process.argv.slice(2));
const report = new Report('survival-contract', options);

await report.check({
  id: 'SURVIVAL.mode-routing',
  name: 'Survival routing is independent and fails closed',
  assertion: 'Only the explicit survival identity activates the mode; invalid URLs return to time trial and survival links discard route/debug state by default.',
}, () => {
  const cases = {
    absent: resolveRunMode(null),
    default: resolveRunMode(DEFAULT_RUN_MODE_ID),
    survival: resolveRunMode(SURVIVAL_RUN_MODE_ID),
    invalid: resolveRunMode('needle-grave'),
  };
  verify(cases.absent.modeId === DEFAULT_RUN_MODE_ID && cases.absent.source === 'default',
    'An absent mode did not select the default.', cases);
  verify(cases.survival.modeId === SURVIVAL_RUN_MODE_ID && cases.survival.source === 'url',
    'The survival identity did not resolve.', cases);
  verify(cases.invalid.modeId === DEFAULT_RUN_MODE_ID && cases.invalid.source === 'invalid-url',
    'An unknown identity did not fail closed.', cases);

  const source = 'http://127.0.0.1:4173/?course=needle-grave&seed=1337&ref=contract#mode';
  const survival = new URL(buildRunModeUrl(source, SURVIVAL_RUN_MODE_ID));
  verify(survival.searchParams.get('mode') === SURVIVAL_RUN_MODE_ID,
    'Survival URL omitted its stable identity.', { href: survival.href });
  verify(!survival.searchParams.has('course') && !survival.searchParams.has('seed'),
    'Survival URL retained route/debug state.', { href: survival.href });
  verify(survival.searchParams.get('ref') === 'contract' && survival.hash === '#mode',
    'Mode URL discarded unrelated state.', { href: survival.href });

  const invalid = new URL(buildRunModeUrl(source, 'unknown-mode'));
  verify(!invalid.searchParams.has('mode'), 'Builder minted an invalid mode URL.', { href: invalid.href });
  const seeded = new URL(buildRunModeUrl(source, SURVIVAL_RUN_MODE_ID, { seed: 0xffff_ffff }));
  verify(seeded.searchParams.get('seed') === '4294967295', 'Valid uint32 seed was not preserved.', {
    href: seeded.href,
  });
  return { cases, survivalUrl: survival.href, invalidUrl: invalid.href, seededUrl: seeded.href };
});

await report.check({
  id: 'SURVIVAL.determinism',
  name: 'Scheduling is deterministic across refresh rates and resets',
  assertion: 'The same ruleset and seed produce byte-identical spawn directives at 60 Hz, 120 Hz and after reset.',
}, () => {
  const seed = 0xc0ff_eec7;
  const at60 = collectAtRate(seed, 60, 300);
  const at120 = collectAtRate(seed, 120, 300);
  const sixty = JSON.stringify(compact(at60.directives));
  const oneTwenty = JSON.stringify(compact(at120.directives));
  verify(sixty === oneTwenty, '60 Hz and 120 Hz produced different schedules.', {
    at60: at60.directives.length,
    at120: at120.directives.length,
  });
  verify(at60.directives.every((pattern) => pattern.scheduledAt >= SURVIVAL_RULESET_V1.graceSeconds),
    'A meteor was scheduled during the grace period.');

  at60.run.reset(seed);
  const resetDirectives = [];
  for (let frame = 0; frame <= 300 * 60; frame += 1) {
    resetDirectives.push(...at60.run.advanceTo(frame / 60).patterns);
  }
  verify(JSON.stringify(compact(resetDirectives)) === sixty,
    'Reset did not restore the original deterministic sequence.');

  const first = deriveSurvivalPattern(seed, 17, 42.5);
  const second = deriveSurvivalPattern(seed, 17, 42.5);
  verify(JSON.stringify(first) === JSON.stringify(second),
    'Stateless pattern derivation changed between calls.');
  return {
    seed,
    patternCount: at60.directives.length,
    meteorCount: at60.directives.reduce((sum, pattern) => sum + pattern.spawns.length, 0),
    firstPatternAt: at60.directives[0]?.scheduledAt ?? null,
    finalPatternAt: at60.directives.at(-1)?.scheduledAt ?? null,
  };
});

await report.check({
  id: 'SURVIVAL.bounds',
  name: 'Difficulty and catch-up work remain bounded',
  assertion: 'The curve stops changing after five minutes, reaction time never crosses its safety floor, directives fit the fixed pool, and a large jump cannot create an unbounded queue.',
}, () => {
  const beforeGrace = survivalDifficultyAt(9.999);
  const ceiling = survivalDifficultyAt(300);
  const muchLater = survivalDifficultyAt(86_400);
  verify(beforeGrace.progress === 0 && beforeGrace.maxPatternSize === 1,
    'Grace difficulty was not neutral.', beforeGrace);
  verify(JSON.stringify({ ...ceiling, elapsedSeconds: 0 }) === JSON.stringify({ ...muchLater, elapsedSeconds: 0 }),
    'Difficulty continued growing beyond five minutes.', { ceiling, muchLater });
  verify(ceiling.reactionSeconds >= SURVIVAL_RULESET_V1.minimumReactionSeconds,
    'Reaction time crossed its configured floor.', ceiling);

  const run = new SurvivalRun({ seed: 7 });
  const jump = run.advanceTo(86_400, SURVIVAL_RULESET_V1.maxActiveMeteors);
  const spawnCount = jump.patterns.reduce((sum, pattern) => sum + pattern.spawns.length, 0);
  verify(jump.patterns.length <= SURVIVAL_RULESET_V1.maxPatternsPerAdvance,
    'Catch-up exceeded the per-advance pattern budget.', jump);
  verify(spawnCount <= SURVIVAL_RULESET_V1.maxSpawnsPerAdvance,
    'Catch-up exceeded the per-advance spawn budget.', { spawnCount, jump });
  verify(spawnCount <= SURVIVAL_RULESET_V1.maxActiveMeteors && jump.nextPatternAt > 86_400,
    'Catch-up overflowed the fixed pool or left stale queued work.', { spawnCount, jump });
  verify(jump.patterns.every((pattern) => pattern.spawns.every((spawn) =>
    spawn.geometryVariant >= 0
      && spawn.geometryVariant < SURVIVAL_RULESET_V1.geometryVariants
      && spawn.reactionSeconds >= SURVIVAL_RULESET_V1.minimumReactionSeconds)),
  'A directive escaped geometry or safety bounds.', jump);
  return { beforeGrace, ceiling, jumpPatterns: jump.patterns.length, jumpSpawns: spawnCount };
});

await report.check({
  id: 'SURVIVAL.records',
  name: 'Personal best storage is versioned, score-only and failure safe',
  assertion: 'Only a longer survival time replaces a PB; corrupt, unavailable and newer storage never throws or overwrites unsupported data.',
}, () => {
  const storage = new MemoryStorage();
  const store = new SurvivalRecordStore({ storage, now: () => 123_456 });
  const run = new SurvivalRun({ seed: 11 });
  run.recordNearMiss(9);
  run.recordMeteorDodged(21);
  const first = store.record(result(run, 42.125));
  verify(first.accepted && first.isNewBest && first.persistence.reloadSafe,
    'First valid result was not persisted.', first);

  run.recordNearMiss(999);
  const tied = store.record(result(run, 42.125));
  verify(!tied.isNewBest && tied.best?.stats.nearMisses === 9,
    'Stats incorrectly broke an equal-time tie.', tied);
  const slower = store.record(result(run, 40));
  verify(!slower.isNewBest && slower.best?.scoreSeconds === 42.125,
    'A shorter run replaced the PB.', slower);
  const faster = store.record(result(run, 43));
  verify(faster.isNewBest && faster.best?.scoreSeconds === 43,
    'A longer run did not replace the PB.', faster);

  const reloaded = new SurvivalRecordStore({ storage }).getBest();
  verify(reloaded?.scoreSeconds === 43 && reloaded.rulesetId === SURVIVAL_RULESET_V1.id,
    'Persisted PB did not survive reload.', reloaded);

  const corrupt = new SurvivalRecordStore({
    storage: new MemoryStorage({ [SURVIVAL_RECORDS_KEY]: '{broken' }),
  });
  verify(corrupt.getBest() === null, 'Corrupt storage invented a PB.', corrupt.snapshot());

  const deniedStorage = new MemoryStorage({}, { failGet: true, failSet: true });
  const denied = new SurvivalRecordStore({ storage: deniedStorage });
  const deniedOutcome = denied.record(result(run, 12));
  verify(deniedOutcome.isNewBest && !deniedOutcome.persistence.reloadSafe,
    'Unavailable storage either threw or hid the in-memory PB.', deniedOutcome);

  const newerStorage = new MemoryStorage({
    [SURVIVAL_RECORDS_KEY]: JSON.stringify({
      version: 2,
      bests: {
        [SURVIVAL_RULESET_V1.id]: faster.best,
      },
    }),
  });
  const newer = new SurvivalRecordStore({ storage: newerStorage });
  const newerOutcome = newer.record(result(run, 99));
  verify(newerOutcome.isNewBest && newerOutcome.persistence.readOnly
    && !newerOutcome.persistence.written && newerStorage.writes === 0,
  'A newer schema was overwritten.', newerOutcome);

  const invalid = store.record({ ...result(run, 12), scoreSeconds: Number.NaN });
  verify(!invalid.accepted && !invalid.isNewBest,
    'A non-finite score entered the record store.', invalid);
  return {
    writes: storage.writes,
    best: store.getBest(),
    denied: deniedOutcome.persistence,
    newer: newerOutcome.persistence,
  };
});

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
