import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ACTIVE_MISSION_ORDER,
  CAIRN_MISSION,
  getMissionDefinition,
  getNextMission,
  isMissionId,
  missionRecordId,
} from '../../src/core/Missions.ts';
import {
  buildMissionUrl,
  resolveMissionSelection,
} from '../../src/core/MissionSelection.ts';
import { ProgressStore } from '../../src/core/Progress.ts';

const checks = [];
const started = Date.now();

async function check(id, fn) {
  const begin = performance.now();
  try {
    const evidence = await fn();
    checks.push({ id, status: 'PASS', durationMs: performance.now() - begin, evidence });
  } catch (error) {
    checks.push({
      id,
      status: 'FAIL',
      durationMs: performance.now() - begin,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function gateResult() {
  return {
    kind: 'gate-race',
    missionId: 'cairn-drift',
    rulesetVersion: CAIRN_MISSION.rulesetVersion,
    totalTime: 80,
    hullRemaining: 1,
    objectiveSummary: '9 / 9',
    topSpeed: 900,
    cleanRun: true,
    rank: 'A',
    destinationName: 'VESPER TERMINUS',
    newlyUnlockedMissionId: null,
    splits: [],
    bestTime: null,
    bestSplits: [],
    isNewBest: true,
    gatesCleared: 9,
    gatesTotal: 9,
    maxGateOffset: 0.2,
  };
}

function collectionResult() {
  return {
    kind: 'collection',
    missionId: 'relay-harvest',
    rulesetVersion: 3,
    totalTime: 58,
    hullRemaining: 0.92,
    objectiveSummary: '10 / 10 CELLS + RELAY RETURN',
    topSpeed: 980,
    cleanRun: true,
    rank: 'A',
    destinationName: 'BLACKOUT RELAY',
    newlyUnlockedMissionId: null,
    bestTime: null,
    isNewBest: true,
    collected: 10,
    required: 10,
    activeTotal: 10,
    charge: 100,
    chargeRequired: 100,
  };
}

await check('CAMPAIGN.catalog-contract', () => {
  assert.deepEqual([...ACTIVE_MISSION_ORDER], ['cairn-drift', 'relay-harvest']);
  assert.equal(isMissionId('last-ascent'), false);
  assert.equal(isMissionId('dead-signal'), false);
  assert.equal(getNextMission('cairn-drift'), 'relay-harvest');
  assert.equal(getNextMission('relay-harvest'), null);
  const relay = getMissionDefinition('relay-harvest');
  assert.equal(relay.chapter, 2);
  assert.equal(relay.objective.kind, 'collection');
  assert.equal(relay.objective.activeSources, 10);
  assert.equal(relay.objective.requiredSources, 10);
  assert.deepEqual(relay.capabilities, []);
  return { order: ACTIVE_MISSION_ORDER, objective: relay.objective };
});

await check('CAMPAIGN.route-resolution', () => {
  const progress = new ProgressStore({ localStorage: null, sessionStorage: null, hasLegacyCairnBest: () => false });
  assert.equal(resolveMissionSelection({ mission: 'relay-harvest', legacyCourse: null }, progress.snapshot()).missionId, 'relay-harvest');
  assert.equal(resolveMissionSelection({ mission: 'last-ascent', legacyCourse: null }, progress.snapshot()).missionId, 'cairn-drift');
  const built = new URL(buildMissionUrl(
    'http://localhost/?mission=relay-harvest&layout=4&seed=7&course=ringfall#x',
    'cairn-drift',
  ));
  assert.equal(built.searchParams.get('mission'), 'cairn-drift');
  assert.equal(built.searchParams.has('layout'), false);
  assert.equal(built.searchParams.has('seed'), false);
  assert.equal(built.searchParams.has('course'), false);
  assert.equal(built.hash, '#x');
  return { canonical: built.href };
});

await check('CAMPAIGN.progress-merge', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const store = new ProgressStore({ localStorage: local, sessionStorage: session, hasLegacyCairnBest: () => false, now: () => 10 });
  const first = store.recordSuccessfulFinish('cairn-drift', gateResult());
  assert.equal(first.firstClear, true);
  assert.equal(first.newlyUnlocked, null);
  const second = store.recordSuccessfulFinish('relay-harvest', collectionResult());
  assert.equal(second.firstClear, true);
  assert.equal(second.newlyUnlocked, null);
  assert.equal(second.progress.missions['relay-harvest']?.cleared, true);
  assert.equal(second.progress.missions['relay-harvest']?.cleanClear, true);
  return { progress: second.progress };
});

await check('CAMPAIGN.progress-persistence', () => {
  const local = new MemoryStorage();
  const first = new ProgressStore({ localStorage: local, sessionStorage: null, hasLegacyCairnBest: () => false });
  first.recordSuccessfulFinish('cairn-drift', gateResult());
  assert.equal(first.selectMission('relay-harvest').accepted, true);
  const reloaded = new ProgressStore({ localStorage: local, sessionStorage: null, hasLegacyCairnBest: () => false });
  assert.equal(reloaded.snapshot().selectedMission, 'relay-harvest');
  const seed = 1337;
  const recordId = missionRecordId(getMissionDefinition('relay-harvest'), seed);
  assert.equal(recordId, 'relay-harvest-r3-1337');
  return { selected: reloaded.snapshot().selectedMission, recordId };
});

const status = checks.every((entry) => entry.status === 'PASS') ? 'PASS' : 'FAIL';
const outDir = resolve('playtest-out/campaign-contract');
await mkdir(outDir, { recursive: true });
const report = {
  schemaVersion: 1,
  suite: 'campaign-contract',
  status,
  durationMs: Date.now() - started,
  summary: { passed: checks.filter((entry) => entry.status === 'PASS').length, total: checks.length },
  checks,
};
const reportPath = resolve(outDir, 'report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${status}: ${reportPath}\n`);
process.exitCode = status === 'PASS' ? 0 : 1;
