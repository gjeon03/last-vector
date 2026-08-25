import * as THREE from 'three';
import type {
  GateNameMessage,
  GateRaceMissionResult,
  MissionResult,
  ObjectiveTelemetry,
} from '../core/contracts.ts';
import type { MissionDefinition } from '../core/Missions.ts';
import type { FlightPath } from './FlightPath.ts';

export type ObjectiveTerminalState =
  | { readonly status: 'running' }
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly reason: string };

export interface ObjectiveUpdateFrame {
  readonly position: THREE.Vector3;
  readonly speed: number;
  readonly elapsed: number;
}

export interface ObjectiveGuidance {
  readonly label: string;
  readonly labelMessage?: GateNameMessage;
  readonly anchor: THREE.Vector3;
  readonly distance: number;
  readonly progress: number;
  readonly current: number;
  readonly total: number;
}

export interface GateRaceResultInput {
  readonly missionId: GateRaceMissionResult['missionId'];
  readonly rulesetVersion: number;
  readonly totalTime: number;
  readonly hullRemaining: number;
  readonly topSpeed: number;
  readonly cleanRun: boolean;
  readonly rank: string;
  readonly destinationName: string;
  readonly bestTime: number | null;
  readonly bestSplits: readonly number[];
  readonly isNewBest: boolean;
}

export interface MissionObjectiveRuntime {
  readonly kind: MissionDefinition['objective']['kind'];
  reset(): void;
  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState;
  guidance(position: THREE.Vector3): ObjectiveGuidance;
  telemetry(): ObjectiveTelemetry;
  /** Concrete objective runtimes expose their typed builder; the common boundary cannot call it. */
  buildResult(input: never): MissionResult;
  dispose(): void;
}

export interface MissionWorldRuntime {
  /** Stable source arrays; quality may change contents, never their identities. */
  readonly colliderSets: readonly (readonly unknown[])[];
  readonly targetables: readonly unknown[];
  reset(): void;
  updateSimulation(dt: number, shipPosition: THREE.Vector3): void;
  dispose(): void;
}

/** One page-load runtime: one definition, one path, one world and one objective. */
export class MissionRuntime {
  readonly definition: MissionDefinition;
  readonly path: FlightPath;
  readonly world: MissionWorldRuntime;
  readonly objective: MissionObjectiveRuntime;

  constructor(options: {
    definition: MissionDefinition;
    path: FlightPath;
    world: MissionWorldRuntime;
    objective: MissionObjectiveRuntime;
  }) {
    this.definition = options.definition;
    this.path = options.path;
    this.world = options.world;
    this.objective = options.objective;
  }

  reset(): void {
    this.world.reset();
    this.objective.reset();
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    return this.objective.update(frame);
  }

  dispose(): void {
    this.objective.dispose();
    this.world.dispose();
  }
}
