import { SCALE } from '../../core/art.ts';
import { AsteroidField } from '../../render/Asteroids.ts';
import { FlightPath } from '../FlightPath.ts';
import { MissionRuntime, type GameMissionRuntimeFactory } from '../MissionRuntime.ts';
import { RelayHarvestObjective } from './RelayHarvestObjective.ts';
import { RelayHarvestState } from './RelayHarvestState.ts';
import { RelayHarvestWorld } from './RelayHarvestWorld.ts';

/** HARVEST gameplay laid directly over THE SPLINTER's authored debris field. */
export const createRelayHarvestMissionRuntime: GameMissionRuntimeFactory = (context) => {
  if (context.definition.objective.kind !== 'collection') {
    throw new Error('BLACKOUT RELAY requires a collection objective definition');
  }

  const path = new FlightPath(context.definition.objective.path, context.seed ^ 0x5248_5031);
  const asteroids = new AsteroidField({
    count: Math.round(context.maximumQuality.asteroidCount * 1.15),
    lighting: context.lighting,
    spine: path.spine,
    spread: SCALE.asteroidFieldRadius * 0.42,
    corridor: 62,
    minRadius: 9,
    maxRadius: 160,
    hazardCount: 720,
    hazardBand: 90,
    keepClearSegments: path.clearChannel,
    keepClear: [{ center: path.startPosition.clone(), radius: 1_100 }],
    seed: context.seed ^ 0x2f19,
  });
  const state = new RelayHarvestState(path, context.seed, asteroids.instances);
  const objective = new RelayHarvestObjective(state);
  const world = new RelayHarvestWorld({
    renderer: context.renderer,
    farScene: context.farScene,
    mainScene: context.mainScene,
    path,
    asteroids,
    sources: state.sources,
    seed: context.seed,
    lighting: context.lighting,
    initialQuality: context.initialQuality,
    maximumQuality: context.maximumQuality,
  });

  return new MissionRuntime({
    definition: context.definition,
    path,
    world,
    objective,
  });
};
