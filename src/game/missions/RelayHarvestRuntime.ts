import * as THREE from 'three';
import { FlightPath } from '../FlightPath.ts';
import { MissionRuntime, type GameMissionRuntimeFactory } from '../MissionRuntime.ts';
import {
  getRelayHarvestLayout,
  selectRelayHarvestLayoutIndex,
} from './RelayHarvestLayout.ts';
import { RelayHarvestObjective } from './RelayHarvestObjective.ts';
import { RelayHarvestState } from './RelayHarvestState.ts';
import { RelayHarvestWorld } from './RelayHarvestWorld.ts';

/** Sole factory for Chapter 02: one validated layout, one shared state, one world. */
export const createRelayHarvestMissionRuntime: GameMissionRuntimeFactory = (context) => {
  if (context.definition.objective.kind !== 'collection') {
    throw new Error('BLACKOUT RELAY requires a collection objective definition');
  }
  const path = new FlightPath(context.definition.objective.path, context.seed ^ 0x5248_5031);
  const layout = getRelayHarvestLayout(
    context.layoutIndex ?? selectRelayHarvestLayoutIndex(context.seed),
  );
  const state = new RelayHarvestState(layout, path.startPosition, path.startQuaternion);
  // Free-flight collection should open on a readable choice, not make the player acquire the
  // first core while the chase camera is still unwinding from the generic path heading. Source
  // positions stay in the authored world frame; only the launch pose faces the fastest validated
  // route's first physical core.
  const firstSourceId = layout.referenceRoutes[0].sourceIds[0];
  const firstSource = state.sources.find((source) => source.id === firstSourceId);
  if (firstSource) {
    const launchDirection = firstSource.position.clone().sub(path.startPosition).normalize();
    path.startQuaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), launchDirection);
  }
  const objective = new RelayHarvestObjective(state);
  const world = new RelayHarvestWorld({
    farScene: context.farScene,
    mainScene: context.mainScene,
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
