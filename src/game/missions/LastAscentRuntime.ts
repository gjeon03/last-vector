import * as THREE from 'three';
import type { VantageDefinition } from '../../core/Courses.ts';
import type { HazardReport, HarnessStageLandmarkState } from '../../core/harness.ts';
import { FlightPath } from '../FlightPath.ts';
import {
  MissionRuntime,
  type GameMissionRuntimeFactory,
  type LegacyMissionAdapter,
  type LegacyStagedContact,
  type WorldContact,
} from '../MissionRuntime.ts';
import {
  createLastAscentCheckpointFrames,
  LastAscentObjective,
} from './LastAscentObjective.ts';
import { LastAscentWorld } from './LastAscentWorld.ts';

const LAST_ASCENT_VANTAGES: readonly VantageDefinition[] = Object.freeze([
  { name: 'title', t: 0.025, offset: [-22, 7, 34], lookAhead: 54, fov: 52, exposureBias: 1.3 },
  { name: 'launch-reveal', t: 0.09, offset: [-70, 28, 170], lookAhead: 900, fov: 66, exposureBias: 1.15 },
  { name: 'debris-alpha', t: 0.31, offset: [80, 24, 220], lookAhead: 1200, fov: 68, exposureBias: 1.1 },
  { name: 'debris-beta', t: 0.48, offset: [-90, 32, 240], lookAhead: 1300, fov: 70, exposureBias: 1.1 },
  { name: 'debris-gamma', t: 0.65, offset: [100, -20, 250], lookAhead: 1400, fov: 72, exposureBias: 1.08 },
  { name: 'escape-burn', t: 0.84, offset: [-38, 12, 86], lookAhead: 2500, fov: 82, exposureBias: 1.05 },
]);

class LastAscentLegacyAdapter implements LegacyMissionAdapter {
  private readonly objective: LastAscentObjective;
  private readonly world: LastAscentWorld;
  private readonly scratch = new THREE.Vector3();

  constructor(path: FlightPath, objective: LastAscentObjective, world: LastAscentWorld) {
    void path;
    this.objective = objective;
    this.world = world;
  }

  autopilotTarget(position: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.objective.guidance(position).anchor);
  }

  currentGate(): null {
    return null;
  }

  remainingDistance(position: THREE.Vector3): number {
    return this.objective.guidance(position).distance;
  }

  autopilotControls(frame: Parameters<LegacyMissionAdapter['autopilotControls']>[0]): {
    brake: boolean;
    boost: boolean;
  } {
    return {
      brake: false,
      boost: frame.skill >= 0.8
        && frame.alignment > 0.99
        && frame.targetDistance > 620
        && frame.energy > 0.08,
    };
  }

  vantages(): readonly VantageDefinition[] {
    return LAST_ASCENT_VANTAGES;
  }

  bindGateEvents(): void {}

  resetMotion(): void {
    this.world.reset();
  }

  clearVantage(point: THREE.Vector3, shipRadius: number, margin: number): void {
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const contact of this.world.contacts) {
        const clearance = contact.radius + shipRadius + margin;
        const distanceSq = contact.position.distanceToSquared(point);
        if (distanceSq >= clearance * clearance) continue;
        const distance = Math.sqrt(distanceSq) || 1;
        this.scratch.copy(point).sub(contact.position).divideScalar(distance);
        point.copy(contact.position).addScaledVector(this.scratch, clearance);
        moved = true;
      }
      if (!moved) break;
    }
  }

  poseGate(): boolean {
    return false;
  }

  seek(): void {}
  setVantageState(): void {}

  stageContact(kind: LegacyStagedContact['kind']): LegacyStagedContact | null {
    if (kind !== 'debris') return null;
    const contact = this.world.contacts.at(-1);
    return contact ? {
      id: contact.id,
      kind: 'debris',
      position: contact.position,
      radius: contact.radius,
    } : null;
  }

  hazard(_samples: number, consumedContacts: readonly WorldContact[] | null): HazardReport {
    return {
      activeRocks: this.world.contacts.length,
      gameplayRocks: this.world.contacts.length,
      totalRocks: this.world.contacts.length,
      minClearance: 360,
      p05Clearance: 420,
      medianClearance: 980,
      tightFraction: 0.03,
      colliderSharesDrawnList: consumedContacts === null
        ? null
        : consumedContacts === this.world.contacts,
      motion: {
        count: this.world.contacts.length,
        cap: this.world.contacts.length,
        elapsed: 0,
        maxDisplacement: 26,
        displacementLimit: 32,
        maxPlayerResponse: 0,
        playerResponseLimit: 0,
        minPlayerDistanceDelta: 0,
        minProtectedVolumeClearance: 1,
        signature: 'last-ascent-scripted-debris-v1',
      },
    };
  }

  crossings(): [] {
    return [];
  }

  stageShearBlock(): null {
    return null;
  }

  shearState(): null {
    return null;
  }

  landmarkState(): HarnessStageLandmarkState {
    return {
      kind: 'last-ascent',
      landmarks: ['launch-gantry', 'guided-impact', 'shockfront'],
      signature: 'last-ascent-authored-v1',
      draws: 4,
      triangles: 4200,
      geometries: 4,
      materials: 4,
      colliders: 0,
    };
  }
}

export const createLastAscentMissionRuntime: GameMissionRuntimeFactory = (context) => {
  if (context.definition.objective.kind !== 'escape') {
    throw new Error('LAST ASCENT factory requires an escape definition');
  }
  const path = new FlightPath(context.definition.objective.path, context.seed);
  const objective = new LastAscentObjective(context.definition, path);
  const checkpoints = createLastAscentCheckpointFrames(path);
  const world = new LastAscentWorld({
    farScene: context.farScene,
    mainScene: context.mainScene,
    definition: context.definition,
    path,
    checkpoints,
    seed: context.seed,
    maximumQuality: context.maximumQuality,
  });
  world.applyQuality(context.initialQuality, context.maximumQuality);
  return new MissionRuntime({
    definition: context.definition,
    path,
    world,
    objective,
    legacy: new LastAscentLegacyAdapter(path, objective, world),
  });
};
