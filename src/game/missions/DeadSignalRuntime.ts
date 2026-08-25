import * as THREE from 'three';
import { SCALE } from '../../core/art.ts';
import { DustField } from '../../render/Dust.ts';
import { DeadSignalEffects } from '../../render/DeadSignalEffects.ts';
import { DeadSignalFacility } from '../../render/DeadSignalFacility.ts';
import { bakeNebula } from '../../render/Nebula.ts';
import { Planet } from '../../render/Planet.ts';
import { Star } from '../../render/Star.ts';
import { Starfield } from '../../render/Starfield.ts';
import { FlightPath } from '../FlightPath.ts';
import {
  MissionRuntime,
  type GameMissionRuntimeFactory,
} from '../MissionRuntime.ts';
import type { DeadSignalMissionDefinition } from './DeadSignalMission.ts';
import { DeadSignalObjective } from './DeadSignalObjective.ts';
import { DeadSignalState } from './DeadSignalState.ts';
import { DeadSignalWeapon } from './DeadSignalWeapon.ts';
import { DeadSignalWorld } from './DeadSignalWorld.ts';

/** Chapter03-only construction. One selection creates one world and one set of shaders. */
export const createDeadSignalMissionRuntime: GameMissionRuntimeFactory = (context) => {
  if (context.definition.objective.kind !== 'strike'
    || !context.definition.capabilities.includes('fire')) {
    throw new Error('The DEAD SIGNAL factory requires a fire-capable strike definition');
  }
  const definition = context.definition as DeadSignalMissionDefinition;
  const courseDefinition = definition.world.sourceCourse;
  const sunDirection = context.lighting.uSunDir.value.clone();
  const nebula = bakeNebula(context.renderer, {
    resolution: context.initialQuality.nebulaSteps >= 20
      ? 1024
      : context.initialQuality.nebulaSteps >= 12 ? 768 : 512,
    octaves: context.initialQuality.nebulaSteps >= 20
      ? 6
      : context.initialQuality.nebulaSteps >= 12 ? 5 : 4,
    seed: (context.seed % 97) * 0.37 + 8.3,
    sunDirection,
  });
  context.farScene.background = nebula.texture;

  const starfield = new Starfield(context.maximumQuality.starCount, 90, context.seed ^ 0x3fd2);
  context.farScene.add(starfield.object);
  const star = new Star(60, Math.atan(SCALE.starRadius / SCALE.starDistance), sunDirection);
  star.setIntensity(0.42);
  context.farScene.add(star.object);

  const planetDirection = courseDefinition.world.planetDirection;
  const planet = new Planet({
    distance: 40,
    angularRadius: Math.atan(SCALE.planetRadius / SCALE.planetDistance) * 1.16,
    direction: new THREE.Vector3(...planetDirection).normalize(),
    sunDirection,
    rings: false,
  });
  context.farScene.add(planet.object);

  const path = new FlightPath(definition.objective.path, context.seed);
  const state = new DeadSignalState(path, definition.objective);
  const effects = new DeadSignalEffects();
  const facility = new DeadSignalFacility({ path, state, lighting: context.lighting });
  const dust = new DustField(context.maximumQuality.dustCount, 1_100, context.seed ^ 0xa817);
  context.mainScene.add(facility.object, effects.object, dust.object);

  const objective = new DeadSignalObjective(path, definition, state);
  const weapon = new DeadSignalWeapon({ mission: definition, state, effects });
  const world = new DeadSignalWorld({
    starfield,
    star,
    planet,
    nebulaTarget: nebula.target,
    dust,
    facility,
    effects,
    state,
  });
  return new MissionRuntime({ definition, path, world, objective, weapon });
};
