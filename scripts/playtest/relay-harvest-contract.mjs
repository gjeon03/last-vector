import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  getRelayHarvestLayout,
  nextRelayHarvestLayoutIndex,
  RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
  RELAY_HARVEST_AUTHORED_SOCKET_COUNT,
  RELAY_HARVEST_BOOST_REWARD,
  RELAY_HARVEST_CAPTURE_RADIUS,
  RELAY_HARVEST_CHARGE_REQUIRED,
  RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
  RELAY_HARVEST_SOCKETS,
  relayHarvestLayoutDebug,
  selectRelayHarvestLayoutIndex,
  VALIDATED_RELAY_HARVEST_LAYOUTS,
} from '../../src/game/missions/RelayHarvestLayout.ts';
import { RelayHarvestObjective } from '../../src/game/missions/RelayHarvestObjective.ts';
import { RelayHarvestState } from '../../src/game/missions/RelayHarvestState.ts';
import { consumeMissionFrameEvents } from '../../src/game/GameContracts.ts';

function verifyCatalogue() {
  assert.equal(RELAY_HARVEST_SOCKETS.length, RELAY_HARVEST_AUTHORED_SOCKET_COUNT);
  assert.equal(RELAY_HARVEST_ACTIVE_SOURCE_COUNT, 10);
  assert.equal(RELAY_HARVEST_REQUIRED_SOURCE_COUNT, 10);
  assert.equal(RELAY_HARVEST_CHARGE_REQUIRED, 100);
  assert.equal(VALIDATED_RELAY_HARVEST_LAYOUTS.length, 66);

  const signatures = new Set();
  for (const [index, layout] of VALIDATED_RELAY_HARVEST_LAYOUTS.entries()) {
    assert.equal(layout.index, index);
    assert.equal(layout.sockets.length, RELAY_HARVEST_ACTIVE_SOURCE_COUNT);
    assert.equal(RELAY_HARVEST_AUTHORED_SOCKET_COUNT - layout.sockets.length, 2);
    assert.equal(getRelayHarvestLayout(index), layout);
    assert.match(layout.signature, /^rh2-/);
    assert.equal(signatures.has(layout.signature), false);
    signatures.add(layout.signature);
    const debug = relayHarvestLayoutDebug(layout);
    assert.equal(new Set(debug.sourceIds).size, RELAY_HARVEST_ACTIVE_SOURCE_COUNT);
    assert.equal(Object.values(debug.bandCounts).reduce((sum, count) => sum + count, 0), 10);
    assert.ok(Object.values(debug.bandCounts).every((count) => count >= 2 && count <= 4));
    assert.equal(debug.referenceRoutes.length, 2);
    assert.ok(debug.referenceRoutes.every((route) => route.sourceIds.length === 10));
    assert.ok(debug.referenceRoutes.every((route) => route.referenceSeconds < 220));
    assert.ok(debug.referenceRoutes.every((route) => route.noBoostSeconds < 310));
    assert.ok(debug.referenceRoutes[1].referenceSeconds
      - debug.referenceRoutes[0].referenceSeconds <= 24);
  }
  for (const seed of [0, 1, 0xffff_ffff, 0x8000_0000]) {
    const selected = selectRelayHarvestLayoutIndex(seed);
    assert.equal(selected, selectRelayHarvestLayoutIndex(seed));
    assert.ok(selected >= 0 && selected < VALIDATED_RELAY_HARVEST_LAYOUTS.length);
    assert.notEqual(nextRelayHarvestLayoutIndex(selected, seed), selected);
  }
  assert.throws(() => getRelayHarvestLayout(-1), RangeError);
  assert.throws(() => getRelayHarvestLayout(VALIDATED_RELAY_HARVEST_LAYOUTS.length), RangeError);
  return { layouts: VALIDATED_RELAY_HARVEST_LAYOUTS.length, signatures: signatures.size };
}

function verifyStableDeterministicRelocation() {
  const origin = new THREE.Vector3(10, 20, 30);
  const create = () => new RelayHarvestState(
    getRelayHarvestLayout(0),
    origin,
    new THREE.Quaternion(),
    1,
  );
  const state = create();
  const mirror = create();
  const defaultState = new RelayHarvestState(getRelayHarvestLayout(0));
  const defaultLifetimes = defaultState.sources.map((source) => source.expiresAt);
  assert.ok(defaultLifetimes.every((lifetime) => lifetime >= 55 && lifetime <= 65));
  assert.ok(new Set(defaultLifetimes).size >= 4);
  const arrayIdentity = state.sources;
  const authoredIdentity = state.authoredPositions;
  const vectorIdentities = state.sources.map((source) => source.position);
  const initialCoordinates = state.sources.map((source) => source.position.toArray());
  const sourceIds = state.sources.map((source) => source.id);
  assert.ok(state.collect(0, 0.5));
  assert.ok(mirror.collect(0, 0.5));
  assert.equal(state.relocateExpired(1), 9);
  assert.equal(mirror.relocateExpired(1), 9);
  assert.equal(state.sources[0].generation, 0);
  assert.equal(state.sources[0].expiresAt, null);
  assert.equal(new Set(state.sources.map((source) => source.socket.index)).size, 10);
  assert.deepEqual(
    state.sources.map((source) => [source.socket.index, ...source.position.toArray(), source.generation]),
    mirror.sources.map((source) => [source.socket.index, ...source.position.toArray(), source.generation]),
  );
  assert.equal(state.relocateExpired(2), 9);
  assert.equal(state.sources, arrayIdentity);
  assert.equal(state.authoredPositions, authoredIdentity);
  assert.deepEqual(state.sources.map((source) => source.id), sourceIds);
  for (const [index, source] of state.sources.entries()) {
    assert.equal(source.position, vectorIdentities[index]);
    assert.deepEqual(source.position.toArray(), state.authoredPositions[source.socket.index].toArray());
  }
  state.reset();
  assert.equal(state.collected, 0);
  assert.equal(state.charge, 0);
  assert.equal(state.phase, 'collecting');
  for (const [index, source] of state.sources.entries()) {
    assert.equal(source.position, vectorIdentities[index]);
    assert.deepEqual(source.position.toArray(), initialCoordinates[index]);
    assert.equal(source.generation, 0);
    assert.equal(source.collected, false);
    assert.ok(source.expiresAt > 0);
  }
  const relocationTrace = (hz) => {
    const traced = new RelayHarvestState(getRelayHarvestLayout(3));
    const generations = new Uint16Array(traced.sources.length);
    const events = [];
    for (let frame = 1; frame <= hz * 190; frame++) {
      traced.relocateExpired(frame / hz);
      for (const source of traced.sources) {
        if (generations[source.index] === source.generation) continue;
        generations[source.index] = source.generation;
        events.push(`${source.index}:${source.generation}:${source.socket.index}`);
      }
    }
    return events;
  };
  assert.deepEqual(relocationTrace(120), relocationTrace(60));
  return {
    sourceCount: state.sources.length,
    authoredSockets: state.authoredPositions.length,
    staggeredLifetimes: new Set(defaultLifetimes).size,
  };
}

function collectAllAtCrossing() {
  const state = new RelayHarvestState(getRelayHarvestLayout(0));
  const crossingCentre = new THREE.Vector3(0, 0, -1_000);
  const objective = new RelayHarvestObjective(state);
  for (const source of state.sources) source.position.copy(crossingCentre);
  const start = new THREE.Vector3(0, 0, -1_000 - RELAY_HARVEST_CAPTURE_RADIUS - 10);
  const end = new THREE.Vector3(0, 0, -1_000 + RELAY_HARVEST_CAPTURE_RADIUS + 10);
  const terminal = objective.update({
    previousPosition: start,
    position: end,
    forward: new THREE.Vector3(0, 0, -1),
    speed: 9_000,
    elapsed: 0.1,
  });
  assert.equal(terminal.status, 'running');
  assert.equal(state.phase, 'returning');
  assert.equal(state.collected, RELAY_HARVEST_REQUIRED_SOURCE_COUNT);
  assert.equal(state.charge, RELAY_HARVEST_CHARGE_REQUIRED);
  assert.equal(objective.bestRunSplits().length, 10);
  const rewards = [];
  assert.equal(objective.drainRewardEvents(rewards), 10);
  assert.ok(rewards.every((reward) => reward.amount === RELAY_HARVEST_BOOST_REWARD));
  const telemetry = objective.telemetry();
  assert.equal(telemetry.phase, 'returning');
  assert.equal(telemetry.sources.length, 10);
  assert.ok(telemetry.sources.every((source) => source.expiresIn === null));
  assert.ok(telemetry.relayRemaining > 0);
  const guidance = objective.guidance(end);
  assert.equal(guidance.label, 'LAUNCH RELAY');
  assert.equal(guidance.anchor, state.relayPosition);
  return { state, objective, end, rewards };
}

function verifyReturnSuccessAndTimeout() {
  const success = collectAllAtCrossing();
  const successTerminal = success.objective.update({
    previousPosition: success.end,
    position: success.state.relayPosition,
    forward: new THREE.Vector3(0, 0, 1),
    speed: 1_000,
    elapsed: 1.2,
  });
  assert.equal(successTerminal.status, 'succeeded');
  assert.equal(success.state.extracted, true);
  const result = success.objective.buildResult({
    totalTime: 1.2,
    hullRemaining: 100,
    topSpeed: 1_000,
    cleanRun: true,
    bestTime: null,
    bestSplits: [],
    isNewBest: true,
    cruiseSpeed: 462,
  });
  assert.equal(result.rulesetVersion, 2);
  assert.match(result.objectiveSummary, /RELAY RETURN/);

  const timeout = collectAllAtCrossing();
  const deadline = timeout.state.relayDeadline;
  assert.ok(deadline !== null);
  const failure = timeout.objective.update({
    previousPosition: timeout.end,
    position: timeout.end,
    forward: new THREE.Vector3(0, 0, -1),
    speed: 0,
    elapsed: deadline + 0.01,
  });
  assert.deepEqual(failure, { status: 'failed', reason: 'relay-window-closed' });
  return { rewardCount: success.rewards.length, relayWindow: success.state.relayWindow };
}

function runLinearTrace(hz) {
  const state = new RelayHarvestState(getRelayHarvestLayout(0));
  const objective = new RelayHarvestObjective(state);
  for (let index = 0; index < state.sources.length; index++) {
    state.sources[index].position.set(0, 0, -(index + 1) * 1_000);
  }
  const speed = 1_200;
  const dt = 1 / hz;
  const previous = new THREE.Vector3();
  const current = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, -1);
  const rewards = [];
  let elapsed = 0;
  let terminal = { status: 'running' };
  let returning = false;
  while (terminal.status === 'running' && elapsed < 30) {
    previous.copy(current);
    elapsed += dt;
    if (!returning) current.set(0, 0, -speed * elapsed);
    else current.z = Math.min(0, current.z + speed * dt);
    terminal = objective.update({ previousPosition: previous, position: current, forward, speed, elapsed });
    objective.drainRewardEvents(rewards);
    returning = state.phase === 'returning';
  }
  return {
    status: terminal.status,
    ids: rewards.map((reward) => reward.sourceId),
    times: [...objective.bestRunSplits()],
    charge: state.charge,
  };
}

function verifyRateIndependence() {
  const at60 = runLinearTrace(60);
  const at120 = runLinearTrace(120);
  assert.equal(at60.status, 'succeeded');
  assert.equal(at120.status, at60.status);
  assert.equal(at60.ids.length, 10);
  assert.deepEqual(at120.ids, at60.ids);
  assert.equal(at120.charge, at60.charge);
  for (let index = 0; index < at60.times.length; index++) {
    assert.ok(Math.abs(at60.times[index] - at120.times[index]) < 1e-8);
  }
  return { ids: at60.ids, charge: at60.charge };
}

function verifyImmediateRuntimeReward() {
  const pending = [{ kind: 'boost-recharge', amount: RELAY_HARVEST_BOOST_REWARD, sourceId: 'CORE-N1' }];
  const mission = {
    drainRewardEvents(out) {
      out.push(...pending);
      const count = pending.length;
      pending.length = 0;
      return count;
    },
  };
  let recharge = 0;
  const ship = { rechargeBoost(amount) { recharge += amount; return { before: 0, after: amount }; } };
  const out = [];
  consumeMissionFrameEvents(mission, { hullFailed: false, terminal: null }, ship, out);
  assert.equal(recharge, RELAY_HARVEST_BOOST_REWARD);
  assert.equal(out.length, 1);
  return { recharge };
}

const evidence = {
  catalogue: verifyCatalogue(),
  relocation: verifyStableDeterministicRelocation(),
  extraction: verifyReturnSuccessAndTimeout(),
  rate: verifyRateIndependence(),
  immediateReward: verifyImmediateRuntimeReward(),
};
process.stdout.write(`PASS relay-harvest-contract ${JSON.stringify(evidence)}\n`);
