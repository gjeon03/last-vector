import * as THREE from 'three';

import { FLIGHT } from '../../src/core/art.ts';
import { ACTIVE_MISSION_ORDER, getMissionDefinition } from '../../src/core/Missions.ts';
import { FlightPath } from '../../src/game/FlightPath.ts';
import { DEAD_SIGNAL_MISSION } from '../../src/game/missions/DeadSignalMission.ts';
import { DeadSignalObjective } from '../../src/game/missions/DeadSignalObjective.ts';
import { DeadSignalState } from '../../src/game/missions/DeadSignalState.ts';
import { DeadSignalEffects } from '../../src/render/DeadSignalEffects.ts';
import { DeadSignalFacility } from '../../src/render/DeadSignalFacility.ts';
import { createLightingUniforms } from '../../src/render/lighting.ts';
import { Report, parseOptions, verify } from './runtime.mjs';

const options = parseOptions('dead-signal-contract', process.argv.slice(2));
const report = new Report('dead-signal-contract', options);

const makeRuntime = () => {
  const path = new FlightPath(DEAD_SIGNAL_MISSION.objective.path, DEAD_SIGNAL_MISSION.defaultSeed);
  const state = new DeadSignalState(path, DEAD_SIGNAL_MISSION.objective);
  const objective = new DeadSignalObjective(path, DEAD_SIGNAL_MISSION, state);
  return { path, state, objective };
};

const destroy = (state, kindOrId, elapsed) => {
  const target = state.targets.find((candidate) =>
    candidate.id === kindOrId || candidate.kind === kindOrId);
  verify(target, `Missing authored target ${kindOrId}`);
  state.damage(target, target.hitPoints, elapsed);
};

await report.check({
  id: 'DEAD-SIGNAL.catalog-and-window',
  name: 'DEAD SIGNAL is a bounded fixed-target strike mission with a viable boosted window',
  assertion:
    'The standalone order, capability, authored targets, tracer/explosion pools and range-derived '
    + 'presentation window stay inside the chapter ceilings.',
}, () => {
  const path = new FlightPath(DEAD_SIGNAL_MISSION.objective.path, DEAD_SIGNAL_MISSION.defaultSeed);
  const corridor = 3_200 * 2;
  const boostedWindowSeconds = 3_200 / FLIGHT.boostSpeed;
  const effects = new DeadSignalEffects();
  const state = new DeadSignalState(path, DEAD_SIGNAL_MISSION.objective);
  const facility = new DeadSignalFacility({
    path,
    state,
    lighting: createLightingUniforms(
      new THREE.Vector3(...DEAD_SIGNAL_MISSION.world.sourceCourse.world.sunDirection),
    ),
  });
  const facilityDebug = facility.getDebugState();
  verify(JSON.stringify(ACTIVE_MISSION_ORDER) === JSON.stringify(['cairn-drift', 'dead-signal'])
    && getMissionDefinition('dead-signal') === DEAD_SIGNAL_MISSION,
  'The standalone mission catalog is not CAIRN then DEAD SIGNAL.');
  verify(DEAD_SIGNAL_MISSION.chapter === 3
    && DEAD_SIGNAL_MISSION.objective.kind === 'strike'
    && DEAD_SIGNAL_MISSION.capabilities.length === 1
    && DEAD_SIGNAL_MISSION.capabilities[0] === 'fire',
  'The Chapter 03 strike/fire capability contract is incomplete.', DEAD_SIGNAL_MISSION);
  verify(state.targets.length === 8 && state.targets.length <= 16,
    'The fixed target set crossed its bounded ceiling.', { targets: state.targets.length });
  verify(corridor >= 2_695 && boostedWindowSeconds >= 2.5,
    'The 3.2 km hitscan reach does not provide the required boosted presentation.', {
      corridor,
      boostedWindowSeconds,
    });
  verify(effects.tracerCapacity >= 32 && effects.tracerCapacity <= 64
    && effects.explosionCapacity <= 8,
  'The fixed pooled effects are outside their required capacities.');
  verify(facilityDebug.drawCalls <= 12
    && facilityDebug.triangles <= 120_000
    && facilityDebug.targetables === state.targets.length,
  'The industrial array crossed its render budget.', facilityDebug);
  facility.dispose();
  effects.dispose();
  return {
    pathLength: path.totalLength,
    targetables: state.targets.length,
    corridor,
    boostedWindowSeconds,
    facility: facilityDebug,
    effects: {
      draws: 2,
      tracerCapacity: effects.tracerCapacity,
      explosionCapacity: effects.explosionCapacity,
    },
  };
});

function successfulTrace(hz) {
  const { path, state, objective } = makeRuntime();
  const pending = [
    [21, 'calibration'],
    [37, 'shield-01'],
    [45, 'shield-02'],
    [53, 'shield-03'],
    [61, 'shield-04'],
    [69, 'shield-05'],
    [77, 'shield-06'],
    [90, 'core'],
  ];
  let eventIndex = 0;
  let terminal = { status: 'running' };
  let elapsed = 0;
  for (let tick = 0; tick <= 112 * hz; tick++) {
    elapsed = tick / hz;
    while (eventIndex < pending.length && elapsed >= pending[eventIndex][0]) {
      destroy(state, pending[eventIndex][1], pending[eventIndex][0]);
      eventIndex++;
    }
    const position = elapsed >= 112
      ? path.terminusPosition
      : path.curve.getPointAt(Math.min(0.995, elapsed / 112));
    terminal = objective.update({ position, speed: 720, elapsed });
    if (terminal.status !== 'running') break;
  }
  return {
    hz,
    terminal,
    elapsed,
    telemetry: objective.telemetry(),
    result: objective.buildResult({
      totalTime: elapsed,
      hullRemaining: 1,
      topSpeed: 1_078,
      cleanRun: true,
      bestTime: null,
      bestSplits: [],
      isNewBest: true,
      cruiseSpeed: FLIGHT.cruiseSpeed,
    }),
  };
}

await report.check({
  id: 'DEAD-SIGNAL.objective-60-120',
  name: 'A clean skilled pass is deterministic at 60 Hz and 120 Hz',
  assertion:
    'Six shield nodes, the core and the two-turn extraction resolve successfully with identical '
    + 'objective facts at both tick rates.',
}, () => {
  const at60 = successfulTrace(60);
  const at120 = successfulTrace(120);
  verify(at60.terminal.status === 'succeeded' && at120.terminal.status === 'succeeded',
    'A deterministic clean pass did not succeed at both tick rates.', { at60, at120 });
  for (const trace of [at60, at120]) {
    verify(trace.telemetry.targetsDestroyed === 6
      && trace.telemetry.targetsRequired === 3
      && trace.telemetry.coreDestroyed
      && trace.result.coreDestroyed
      && trace.result.hullRemaining > 0,
    'The successful trace omitted a success condition.', trace);
  }
  verify(Math.abs(at60.elapsed - at120.elapsed) <= 1 / 60,
    'Tick rates disagreed on successful extraction time.', { at60, at120 });
  return { at60, at120 };
});

await report.check({
  id: 'DEAD-SIGNAL.failure-boundaries',
  name: 'Every objective-specific failure boundary fails closed',
  assertion:
    'Entering the core without three nodes, passing the core window and missing the blast '
    + 'deadline each return their distinct terminal reason.',
}, () => {
  const insufficient = makeRuntime();
  const insufficientPosition = insufficient.path.curve.getPointAt(
    DEAD_SIGNAL_MISSION.objective.coreBoundaryProgress + 0.015,
  );
  const insufficientTerminal = insufficient.objective.update({
    position: insufficientPosition,
    speed: 800,
    elapsed: 84,
  });

  const missed = makeRuntime();
  for (const id of ['shield-01', 'shield-02', 'shield-03']) destroy(missed.state, id, 55);
  const missedPosition = missed.path.curve.getPointAt(
    DEAD_SIGNAL_MISSION.objective.coreWindowEndProgress + 0.015,
  );
  const missedTerminal = missed.objective.update({
    position: missedPosition,
    speed: 800,
    elapsed: 100,
  });

  const blast = makeRuntime();
  for (const id of ['shield-01', 'shield-02', 'shield-03']) destroy(blast.state, id, 55);
  destroy(blast.state, 'core', 86);
  const blastTerminal = blast.objective.update({
    position: blast.path.curve.getPointAt(0.9),
    speed: 800,
    elapsed: 116,
  });

  verify(insufficientTerminal.status === 'failed'
    && insufficientTerminal.reason === 'core-boundary-without-shields',
  'The insufficient-node boundary did not fail distinctly.', insufficientTerminal);
  verify(missedTerminal.status === 'failed' && missedTerminal.reason === 'core-window-missed',
    'The core-window boundary did not fail distinctly.', missedTerminal);
  verify(blastTerminal.status === 'failed' && blastTerminal.reason === 'blast-timeout',
    'The extraction blast boundary did not fail distinctly.', blastTerminal);
  return { insufficientTerminal, missedTerminal, blastTerminal };
});

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
