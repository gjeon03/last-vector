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
  assert.deepEqual(
    Object.fromEntries(['near', 'mid', 'far'].map((band) => [
      band,
      RELAY_HARVEST_SOCKETS.filter((source) => source.band === band).length,
    ])),
    { near: 4, mid: 4, far: 4 },
  );
  assert.ok(VALIDATED_RELAY_HARVEST_LAYOUTS.length >= 2);
  assert.ok(VALIDATED_RELAY_HARVEST_LAYOUTS.length <= 144);

  const signatures = new Set();
  for (const [index, layout] of VALIDATED_RELAY_HARVEST_LAYOUTS.entries()) {
    assert.equal(layout.index, index);
    assert.equal(layout.sockets.length, RELAY_HARVEST_ACTIVE_SOURCE_COUNT);
    assert.equal(getRelayHarvestLayout(index), layout);
    assert.equal(signatures.has(layout.signature), false);
    signatures.add(layout.signature);
    const debug = relayHarvestLayoutDebug(layout);
    assert.deepEqual(debug.bandCounts, { near: 2, mid: 2, far: 1 });
    assert.equal(new Set(debug.sourceIds).size, RELAY_HARVEST_ACTIVE_SOURCE_COUNT);
    assert.equal(debug.referenceRoutes.length, 2);
    assert.ok(debug.referenceRoutes[0].referenceSeconds < 60);
    assert.ok(debug.referenceRoutes[1].referenceSeconds < 60);
    assert.ok(debug.referenceRoutes[0].noBoostSeconds < 85);
    assert.ok(debug.referenceRoutes[1].noBoostSeconds < 85);
    assert.ok(debug.referenceRoutes[1].referenceSeconds
      - debug.referenceRoutes[0].referenceSeconds <= 6);
    assert.ok(debug.referenceRoutes.some((route) => route.maximumTurnDegrees <= 55));
    assert.ok(debug.referenceRoutes.every((route) => Number.isFinite(route.maximumTurnDegrees)));
  }
  // Regression: this layout previously hid a 30.87 s 81° shortcut and claimed two balanced
  // 43–44 s routes. It must not survive unless that actual shortcut is represented and balanced.
  assert.equal(signatures.has('rh1-N1.N3.M1.M4.F1'), false);
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

function verifyStateReset() {
  const state = new RelayHarvestState(
    getRelayHarvestLayout(0),
    new THREE.Vector3(10, 20, 30),
    new THREE.Quaternion(),
  );
  const arrayIdentity = state.sources;
  const vectorIdentities = state.sources.map((source) => source.position);
  const coordinates = state.sources.map((source) => source.position.toArray());
  const signature = state.layoutSignature;
  assert.ok(state.collect(0, 1));
  assert.equal(state.collect(0, 2), null);
  state.reset();
  assert.equal(state.sources, arrayIdentity);
  assert.equal(state.layoutSignature, signature);
  assert.equal(state.collected, 0);
  assert.equal(state.charge, 0);
  for (const [index, source] of state.sources.entries()) {
    assert.equal(source.position, vectorIdentities[index]);
    assert.deepEqual(source.position.toArray(), coordinates[index]);
    assert.equal(source.collected, false);
    assert.equal(source.collectedAt, null);
  }
  return { signature, sourceCount: state.sources.length };
}

function verifySweptPickupAndOrdering() {
  const state = new RelayHarvestState(getRelayHarvestLayout(0));
  const crossingCentre = new THREE.Vector3(0, 0, -1_000);
  for (let index = 0; index < 3; index++) state.sources[index].position.copy(crossingCentre);
  state.sources[3].position.set(5_000, 0, -1_000);
  state.sources[4].position.set(-5_000, 0, -1_000);
  const objective = new RelayHarvestObjective(state);
  const start = new THREE.Vector3(0, 0, -1_000 - RELAY_HARVEST_CAPTURE_RADIUS - 10);
  const end = new THREE.Vector3(0, 0, -1_000 + RELAY_HARVEST_CAPTURE_RADIUS + 10);
  assert.ok(start.distanceTo(crossingCentre) > RELAY_HARVEST_CAPTURE_RADIUS);
  assert.ok(end.distanceTo(crossingCentre) > RELAY_HARVEST_CAPTURE_RADIUS);
  const terminal = objective.update({
    previousPosition: start,
    position: end,
    forward: new THREE.Vector3(0, 0, -1),
    speed: 9_000,
    elapsed: 0.1,
  });
  assert.equal(terminal.status, 'succeeded');
  assert.equal(state.collected, RELAY_HARVEST_REQUIRED_SOURCE_COUNT);
  assert.equal(state.charge, RELAY_HARVEST_CHARGE_REQUIRED);
  const rewards = [];
  assert.equal(objective.drainRewardEvents(rewards), RELAY_HARVEST_REQUIRED_SOURCE_COUNT);
  assert.deepEqual(rewards.map((reward) => reward.sourceId), state.sources.slice(0, 3)
    .map((source) => source.id).sort());
  assert.ok(rewards.every((reward) => reward.amount === RELAY_HARVEST_BOOST_REWARD));
  assert.equal(objective.drainRewardEvents([]), 0);
  assert.match(objective.recordId('relay-harvest-r1-7'), /-layout-rh1-/);
  const telemetry = objective.telemetry();
  assert.equal(telemetry.sources.length, RELAY_HARVEST_ACTIVE_SOURCE_COUNT);
  assert.ok(telemetry.sources.every((source) => source.position.length === 3));
  assert.ok(telemetry.sources.every((source) => source.anchor && typeof source.anchor.onScreen === 'boolean'));
  return { rewardOrder: rewards.map((reward) => reward.sourceId), charge: state.charge };
}

function runLinearTrace(hz) {
  const state = new RelayHarvestState(getRelayHarvestLayout(0));
  for (let index = 0; index < state.sources.length; index++) {
    state.sources[index].position.set(index < 3 ? 0 : 5_000, 0, -(index + 1) * 1_000);
  }
  const objective = new RelayHarvestObjective(state);
  const speed = 1_200;
  const dt = 1 / hz;
  const previous = new THREE.Vector3();
  const current = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, -1);
  const rewards = [];
  let elapsed = 0;
  let terminal = { status: 'running' };
  while (terminal.status === 'running' && elapsed < 10) {
    previous.copy(current);
    elapsed += dt;
    current.set(0, 0, -speed * elapsed);
    terminal = objective.update({ previousPosition: previous, position: current, forward, speed, elapsed });
    objective.drainRewardEvents(rewards);
  }
  return {
    status: terminal.status,
    ids: rewards.map((reward) => reward.sourceId),
    times: state.sources.slice(0, 3).map((source) => source.collectedAt),
    charge: state.charge,
  };
}

function verifyRateIndependence() {
  const at60 = runLinearTrace(60);
  const at120 = runLinearTrace(120);
  assert.equal(at60.status, 'succeeded');
  assert.deepEqual(at60.ids, ['CORE-N1', 'CORE-N2', 'CORE-M1']);
  assert.deepEqual(at120.ids, at60.ids);
  assert.equal(at120.charge, at60.charge);
  for (let index = 0; index < at60.times.length; index++) {
    assert.ok(Math.abs(at60.times[index] - at120.times[index]) < 1e-8);
  }
  return { at60, at120 };
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
  assert.equal(pending.length, 0);
  return { terminal: null, recharge };
}

const evidence = {
  catalogue: verifyCatalogue(),
  reset: verifyStateReset(),
  swept: verifySweptPickupAndOrdering(),
  rate: verifyRateIndependence(),
  immediateReward: verifyImmediateRuntimeReward(),
};
process.stdout.write(`PASS relay-harvest-contract ${JSON.stringify(evidence)}\n`);
