import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FLIGHT } from '../../src/core/art.ts';
import { FlightPath } from '../../src/game/FlightPath.ts';
import {
  RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
  RELAY_HARVEST_BOOST_REWARD,
  RELAY_HARVEST_CAPTURE_RADIUS,
  RELAY_HARVEST_CELL_LIFETIME,
  RELAY_HARVEST_CHARGE_REQUIRED,
  RELAY_HARVEST_PICKUP_RADIUS,
  RELAY_HARVEST_PREGENERATED_POSITION_COUNT,
  RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
  RELAY_HARVEST_RETURN_MINIMUM_SECONDS,
  RELAY_HARVEST_RETURN_PACE,
  RELAY_HARVEST_SHIP_RADIUS,
} from '../../src/game/missions/RelayHarvestLayout.ts';
import {
  RelayHarvestObjective,
  relayHarvestSegmentSphereEntry,
} from '../../src/game/missions/RelayHarvestObjective.ts';
import { RelayHarvestState } from '../../src/game/missions/RelayHarvestState.ts';

const PATH_DEFINITION = Object.freeze({
  legs: Object.freeze([
    Object.freeze({ turn: 0.10, climb: 0.03, length: 1.0, bank: 0.1, clearance: 540, label: 'A' }),
    Object.freeze({ turn: -0.14, climb: -0.04, length: 1.1, bank: -0.1, clearance: 500, label: 'B' }),
    Object.freeze({ turn: 0.18, climb: 0.06, length: 1.05, bank: 0.1, clearance: 460, label: 'C' }),
    Object.freeze({ turn: -0.12, climb: -0.02, length: 1.2, bank: -0.1, clearance: 520, label: 'D' }),
    Object.freeze({ turn: 0.16, climb: 0.04, length: 1.15, bank: 0.1, clearance: 480, label: 'E' }),
    Object.freeze({ turn: -0.11, climb: -0.05, length: 1.0, bank: -0.1, clearance: 550, label: 'F' }),
  ]),
  gateSpacing: 4_200,
  gateRadius: 105,
  finalGateRadiusScale: 1.1,
  leadInControlMetres: 1_000,
  startOffsetMetres: 260,
  runOutSteps: 3,
  runOutStepMetres: 800,
  terminusStandoff: 900,
  sampleCount: 160,
});

function createPath() {
  return new FlightPath(PATH_DEFINITION, 0x5031);
}

function createRocks(path) {
  // Only position and radius participate in Harvest placement. These deterministic rocks sit
  // around the route so the contract exercises the real AsteroidInstance clearance branch.
  return path.spine.filter((_, index) => index % 8 === 0).map((point, index) => ({
    id: index,
    position: point.clone().add(new THREE.Vector3((index % 2 ? -1 : 1) * 780, 0, 0)),
    radius: 110 + (index % 3) * 20,
    gameplay: true,
    scale: 1,
    spinAxis: new THREE.Vector3(0, 1, 0),
    spinRate: 0,
    quaternion: new THREE.Quaternion(),
  }));
}

function createState(seed = 0x5245_4c59) {
  const path = createPath();
  return new RelayHarvestState(path, seed, createRocks(path));
}

function snapshotPositions(state) {
  return state.sources.map((source) => source.position.toArray());
}

function verifyTuningAndDeterminism() {
  assert.equal(RELAY_HARVEST_ACTIVE_SOURCE_COUNT, 10);
  assert.equal(RELAY_HARVEST_REQUIRED_SOURCE_COUNT, 10);
  assert.equal(RELAY_HARVEST_CHARGE_REQUIRED, 100);
  assert.equal(RELAY_HARVEST_CELL_LIFETIME, 38);
  assert.equal(RELAY_HARVEST_PICKUP_RADIUS, 70);
  assert.equal(RELAY_HARVEST_SHIP_RADIUS, 9);
  assert.equal(RELAY_HARVEST_CAPTURE_RADIUS, 79);
  assert.equal(RELAY_HARVEST_BOOST_REWARD, 100);
  assert.equal(RELAY_HARVEST_PREGENERATED_POSITION_COUNT, 24);

  const first = createState();
  const mirror = createState();
  const different = createState(0x5245_4c5a);
  assert.deepEqual(snapshotPositions(first), snapshotPositions(mirror));
  assert.notDeepEqual(snapshotPositions(first), snapshotPositions(different));
  assert.equal(first.sources.length, 10);
  assert.equal(first.activeCount(), 10);
  assert.deepEqual(first.sources.map((source) => source.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  for (let left = 0; left < first.sources.length; left++) {
    for (let right = left + 1; right < first.sources.length; right++) {
      assert.ok(first.sources[left].position.distanceTo(first.sources[right].position) >= 900);
    }
  }
  assert.equal(first.sources[0].charge, 1);
  assert.ok(first.sources.at(-1).charge > 0.5 && first.sources.at(-1).charge < 0.51);
  return { pathLength: Math.round(first.path.totalLength), openingCells: first.activeCount() };
}

function verifySweptPickupAndImmediateRespawn() {
  const state = createState();
  const objective = new RelayHarvestObjective(state);
  const source = state.sources[0];
  const oldId = source.id;
  const oldGeneration = source.generation;
  const oldPosition = source.position.clone();
  const start = oldPosition.clone().add(new THREE.Vector3(-RELAY_HARVEST_CAPTURE_RADIUS - 10, 0, 0));
  const end = oldPosition.clone().add(new THREE.Vector3(RELAY_HARVEST_CAPTURE_RADIUS + 10, 0, 0));
  assert.ok(relayHarvestSegmentSphereEntry(start, end, oldPosition) !== null);

  const terminal = objective.update({
    previousPosition: start,
    position: end,
    speed: 2_000,
    elapsed: 0.1,
  });
  assert.equal(terminal.status, 'running');
  assert.equal(state.collected, 1);
  assert.equal(state.activeCount(), 10);
  assert.ok(source.id > oldId);
  assert.equal(source.generation, oldGeneration + 1);
  assert.notDeepEqual(source.position.toArray(), oldPosition.toArray());
  const rewards = [];
  assert.equal(objective.drainRewardEvents(rewards), 1);
  assert.equal(rewards[0].amount, 100);
  assert.equal(objective.guidance(end).label, 'ENERGY CELL');
  return { reward: rewards[0].amount, activeAfterPickup: state.activeCount() };
}

function verifyExpiryPrecedesPickup() {
  const state = createState();
  const objective = new RelayHarvestObjective(state);
  const source = state.sources[0];
  const oldId = source.id;
  const oldPosition = source.position.clone();
  source.charge = 0.0001;
  source.expiresAt = 0.0001 * RELAY_HARVEST_CELL_LIFETIME;
  const start = oldPosition.clone().add(new THREE.Vector3(-RELAY_HARVEST_CAPTURE_RADIUS - 5, 0, 0));
  const end = oldPosition.clone().add(new THREE.Vector3(RELAY_HARVEST_CAPTURE_RADIUS + 5, 0, 0));

  objective.update({ previousPosition: start, position: end, speed: 2_000, elapsed: 0.1 });
  assert.equal(state.collected, 0);
  assert.ok(source.id > oldId);
  assert.equal(state.activeCount(), 10);
  assert.notDeepEqual(source.position.toArray(), oldPosition.toArray());
  return { expiredCell: oldId, replacementCell: source.id };
}

function collectTen(objective, state) {
  const rewards = [];
  let elapsed = 0;
  let lastEnd = state.relayPosition.clone();
  let lastContact = state.relayPosition.clone();
  for (let pickup = 0; pickup < 10; pickup++) {
    const source = state.sources[0];
    const centre = source.position.clone();
    const start = centre.clone().add(new THREE.Vector3(-RELAY_HARVEST_CAPTURE_RADIUS - 10, 0, 0));
    const end = centre.clone().add(new THREE.Vector3(RELAY_HARVEST_CAPTURE_RADIUS + 10, 0, 0));
    elapsed += 0.1;
    const terminal = objective.update({ previousPosition: start, position: end, speed: 2_000, elapsed });
    assert.equal(terminal.status, 'running');
    objective.drainRewardEvents(rewards);
    lastEnd = end;
    lastContact = centre.clone().add(new THREE.Vector3(-RELAY_HARVEST_CAPTURE_RADIUS, 0, 0));
  }
  return { rewards, elapsed, lastEnd, lastContact };
}

function verifyQuotaReturnAndResult() {
  const state = createState();
  const objective = new RelayHarvestObjective(state);
  const run = collectTen(objective, state);
  assert.equal(state.collected, 10);
  assert.equal(state.charge, 100);
  assert.equal(state.phase, 'returning');
  assert.equal(state.activeCount(), 0);
  assert.ok(state.sources.every((source) => !source.alive && source.charge === 0));
  assert.equal(objective.bestRunSplits().length, 10);
  assert.equal(run.rewards.length, 10);
  assert.ok(run.rewards.every((reward) => reward.amount === RELAY_HARVEST_BOOST_REWARD));
  assert.equal(objective.guidance(run.lastEnd).label, 'RELAY');

  const expectedWindow = Math.max(
    RELAY_HARVEST_RETURN_MINIMUM_SECONDS,
    run.lastContact.distanceTo(state.relayPosition) / (FLIGHT.cruiseSpeed * RELAY_HARVEST_RETURN_PACE),
  );
  assert.ok(Math.abs(state.relayWindow - expectedWindow) < 1e-7);
  assert.equal(state.returnStartedAt, objective.bestRunSplits().at(-1));

  const success = objective.update({
    previousPosition: run.lastEnd,
    position: state.relayPosition,
    speed: 20_000,
    elapsed: run.elapsed + 1,
  });
  assert.equal(success.status, 'succeeded');
  assert.equal(state.extracted, true);

  const par = (state.path.totalLength * 1.45) / FLIGHT.cruiseSpeed;
  const result = objective.buildResult({
    totalTime: par * 0.7,
    hullRemaining: 100,
    topSpeed: 1_000,
    cleanRun: true,
    bestTime: null,
    bestSplits: [],
    isNewBest: true,
    cruiseSpeed: FLIGHT.cruiseSpeed,
  });
  assert.equal(result.rulesetVersion, 3);
  assert.equal(result.rank, 'S');
  assert.equal(result.collected, 10);
  assert.equal(objective.recordId('relay-harvest-v3-seed'), 'relay-harvest-v3-seed');
  return { rewards: run.rewards.length, relayWindow: state.relayWindow, rank: result.rank };
}

function verifyRelayTimeout() {
  const state = createState();
  for (let pickup = 0; pickup < 10; pickup++) assert.ok(state.collect(0, pickup * 0.1));
  const home = state.sources[0].position.distanceTo(state.relayPosition);
  state.beginReturn(1, home, FLIGHT.cruiseSpeed);
  const objective = new RelayHarvestObjective(state);
  // Objective construction resets state, so repeat the compact state-only setup intentionally.
  for (let pickup = 0; pickup < 10; pickup++) assert.ok(state.collect(0, pickup * 0.1));
  state.beginReturn(1, home, FLIGHT.cruiseSpeed);
  const deadline = state.relayDeadline;
  const far = state.relayPosition.clone().add(new THREE.Vector3(10_000, 0, 0));
  const failed = objective.update({
    previousPosition: far,
    position: far,
    speed: 0,
    elapsed: deadline + 0.01,
  });
  assert.deepEqual(failed, { status: 'failed', reason: 'relay-window-closed' });
  assert.ok(state.relayWindow >= RELAY_HARVEST_RETURN_MINIMUM_SECONDS);
  return { timeout: state.failureReason };
}

const evidence = {
  deterministic: verifyTuningAndDeterminism(),
  pickup: verifySweptPickupAndImmediateRespawn(),
  expiryOrder: verifyExpiryPrecedesPickup(),
  extraction: verifyQuotaReturnAndResult(),
  timeout: verifyRelayTimeout(),
};
process.stdout.write(`PASS relay-harvest-contract ${JSON.stringify(evidence)}\n`);
