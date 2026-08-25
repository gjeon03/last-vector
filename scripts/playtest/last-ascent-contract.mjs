import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { LAST_ASCENT_MISSION } from '../../src/core/Missions.ts';
import { FlightPath } from '../../src/game/FlightPath.ts';
import { Ship } from '../../src/game/Ship.ts';
import {
  createLastAscentCheckpointFrames,
  LastAscentObjective,
  lastAscentShockfrontProgressAt,
} from '../../src/game/missions/LastAscentObjective.ts';
import { LAST_ASCENT_SHOCK_EXTRACTION_SECONDS } from '../../src/game/missions/LastAscentDefinition.ts';
import { LastAscentDebris } from '../../src/render/LastAscentDebris.ts';
import { Report, parseOptions, verify } from './runtime.mjs';

const options = parseOptions('last-ascent-contract', process.argv.slice(2));
const report = new Report('last-ascent-contract', options);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function runTrace(hz, strategy) {
  const dt = 1 / hz;
  const path = new FlightPath(
    LAST_ASCENT_MISSION.objective.path,
    LAST_ASCENT_MISSION.defaultSeed,
  );
  const objective = new LastAscentObjective(LAST_ASCENT_MISSION, path);
  const ship = new Ship();
  ship.reset(path.startPosition, path.startQuaternion, 462 * 0.55);
  const inverse = new THREE.Quaternion();
  const targetDirection = new THREE.Vector3();
  const localDirection = new THREE.Vector3();
  const command = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    strafeX: 0,
    strafeY: 0,
    throttle: 1,
    boost: false,
    brake: false,
  };
  const rewards = [];
  let elapsed = 0;
  let terminal = { status: 'running' };
  while (terminal.status === 'running' && elapsed < 220) {
    const guidance = objective.guidance(ship.position);
    targetDirection.copy(guidance.anchor).sub(ship.position);
    const distance = targetDirection.length();
    targetDirection.divideScalar(Math.max(1e-6, distance));
    inverse.copy(ship.quaternion).invert();
    localDirection.copy(targetDirection).applyQuaternion(inverse);
    const alignment = clamp(-localDirection.z, 0, 1);
    command.pitch = clamp(localDirection.y * 2.5, -1, 1);
    command.yaw = clamp(localDirection.x * 2.5, -1, 1);
    command.throttle = 0.45 + 0.55 * alignment * alignment;
    command.boost = strategy !== 'no-boost' && alignment > 0.985;
    // The falsification trace makes the early two-second commitment cost a two-second recovery.
    // It is deliberately harsher than merely holding too soon, and still has to clear.
    command.brake = strategy === 'wasted-early'
      && elapsed >= 2
      && elapsed < 4;
    ship.update(dt, command);
    elapsed += dt;
    terminal = objective.update({ position: ship.position, speed: ship.speed, elapsed });
    for (const reward of objective.drainRewardEvents()) {
      rewards.push({ ...reward, at: elapsed });
      ship.rechargeBoost(reward.amount);
    }
  }
  const telemetry = objective.telemetry();
  const result = terminal.status === 'succeeded'
    ? objective.buildResult({
        totalTime: elapsed,
        hullRemaining: ship.hull,
        topSpeed: ship.speed,
        cleanRun: true,
        bestTime: null,
        bestSplits: [],
        isNewBest: true,
        cruiseSpeed: 462,
      })
    : null;
  objective.dispose();
  return {
    hz,
    strategy,
    status: terminal.status,
    reason: terminal.reason ?? null,
    elapsed,
    progress: telemetry.pathProgress,
    shockwave: telemetry.shockwaveProgress,
    separation: telemetry.pathProgress - telemetry.shockwaveProgress,
    checkpoints: telemetry.checkpoint,
    rewards,
    result,
    pathLength: path.totalLength,
  };
}

await report.check({
  id: 'ASCENT.definition-world-bounds',
  name: 'LAST ASCENT is one bounded deterministic escape definition',
  assertion: 'Twenty visible contacts, one moving batch, three authored openings and no centre spawn.',
}, async () => {
  verify(LAST_ASCENT_MISSION.id === 'last-ascent'
    && LAST_ASCENT_MISSION.chapter === 2
    && LAST_ASCENT_MISSION.objective.kind === 'escape'
    && LAST_ASCENT_MISSION.capabilities.length === 0,
  'The Chapter 02 definition is not a capability-free escape.', LAST_ASCENT_MISSION);
  const path = new FlightPath(
    LAST_ASCENT_MISSION.objective.path,
    LAST_ASCENT_MISSION.defaultSeed,
  );
  const checkpoints = createLastAscentCheckpointFrames(path);
  const debris = new LastAscentDebris(path, checkpoints, LAST_ASCENT_MISSION.defaultSeed);
  const minSpawnDistance = Math.min(
    ...debris.contacts.map((contact) => contact.position.distanceTo(path.startPosition)),
  );
  verify(debris.contacts.length === 20
    && debris.collisionBatchCount === 1
    && checkpoints.length === 3
    && minSpawnDistance > 0.001,
  'Collision debris exceeded its bounds or violated the exact-centre guard.', {
    contacts: debris.contacts.length,
    batches: debris.collisionBatchCount,
    checkpoints: checkpoints.length,
    minSpawnDistance,
  });
  const maximumSpeed = 1188;
  const commitmentWindows = checkpoints.map((checkpoint, index) => {
    const previous = index === 0 ? 0 : checkpoints[index - 1].progress;
    return ((checkpoint.progress - previous) * path.totalLength) / maximumSpeed;
  });
  verify(commitmentWindows.every((seconds) => seconds >= 2.5),
    'An authored debris line appears inside the 2.5 second commitment window.', commitmentWindows);
  const debrisSource = await readFile(
    new URL('../../src/render/LastAscentDebris.ts', import.meta.url),
    'utf8',
  );
  verify(!debrisSource.includes('Math.random')
    && /updateSimulation\(dt: number\)/u.test(debrisSource)
    && !/updateSimulation\([^)]*ship/iu.test(debrisSource),
  'Debris motion gained random or player-reactive behavior.');
  debris.dispose();
  return {
    pathLength: path.totalLength,
    contacts: 20,
    movingCollisionBatches: 1,
    commitmentWindows,
    minSpawnDistance,
  };
});

await report.check({
  id: 'ASCENT.shockfront-script',
  name: 'Shockfront follows elapsed path progress without rubber-banding',
  assertion: 'Five-second grace, monotonic authored curve, fixed extraction arrival and no speed input.',
}, () => {
  const samples = [
    0,
    5,
    30,
    80,
    96,
    LAST_ASCENT_SHOCK_EXTRACTION_SECONDS,
  ].map((elapsed) => ({
    elapsed,
    progress: lastAscentShockfrontProgressAt(elapsed, LAST_ASCENT_MISSION),
  }));
  verify(samples[0].progress === samples[1].progress
    && samples.every((sample, index) => index === 0 || sample.progress >= samples[index - 1].progress)
    && Math.abs(samples.at(-1).progress - 1) < 1e-9
    && lastAscentShockfrontProgressAt.length === 2,
  'Shockfront timing is not the authored elapsed-only curve.', samples);
  return samples;
});

await report.check({
  id: 'ASCENT.trace-matrix-60-120',
  name: 'Escape balance is deterministic at 60 and 120 Hz',
  assertion: 'Cruise is caught at 35–65%; reference/wasted/held clear inside every margin bound.',
}, () => {
  const traces = [];
  for (const hz of [60, 120]) {
    for (const strategy of ['no-boost', 'reference', 'wasted-early', 'always-held']) {
      traces.push(runTrace(hz, strategy));
    }
  }
  for (const hz of [60, 120]) {
    const noBoost = traces.find((trace) => trace.hz === hz && trace.strategy === 'no-boost');
    const reference = traces.find((trace) => trace.hz === hz && trace.strategy === 'reference');
    const wasted = traces.find((trace) => trace.hz === hz && trace.strategy === 'wasted-early');
    const held = traces.find((trace) => trace.hz === hz && trace.strategy === 'always-held');
    verify(noBoost.status === 'failed'
      && noBoost.reason === 'shockfront-catch'
      && noBoost.progress >= 0.35
      && noBoost.progress <= 0.65,
    `${hz} Hz cruise trace was not caught in the authored middle band.`, noBoost);
    verify(reference.status === 'succeeded'
      && reference.elapsed >= 100
      && reference.elapsed <= 120
      && reference.result.secondsAhead >= 3
      && reference.result.secondsAhead <= 8,
    `${hz} Hz reference trace missed the skilled time/margin target.`, reference);
    verify(wasted.status === 'succeeded' && wasted.result.secondsAhead >= 1,
      `${hz} Hz wasted-early trace became unrecoverable.`, wasted);
    verify(held.status === 'succeeded' && held.result.secondsAhead <= 10,
      `${hz} Hz always-held trace escaped too far ahead.`, held);
    for (const trace of [reference, wasted, held]) {
      verify(trace.rewards.length === 3
        && trace.rewards.every((reward, index) => reward.kind === 'checkpoint'
          && reward.amount === 25
          && reward.checkpoint === index + 1),
      `${hz} Hz ${trace.strategy} did not emit exactly one typed +25 reward per checkpoint.`, trace);
    }
  }
  for (const strategy of ['no-boost', 'reference', 'wasted-early', 'always-held']) {
    const at60 = traces.find((trace) => trace.hz === 60 && trace.strategy === strategy);
    const at120 = traces.find((trace) => trace.hz === 120 && trace.strategy === strategy);
    verify(at60.status === at120.status
      && Math.abs(at60.elapsed - at120.elapsed) <= 0.1
      && Math.abs(at60.separation - at120.separation) <= 0.005,
    `${strategy} diverged across fixed-step rates.`, { at60, at120 });
  }
  return traces;
});

await report.write();
