import * as THREE from 'three';
import type {
  GateNameMessage,
  MissionResult,
  ObjectiveTelemetry,
} from '../core/contracts.ts';
import { missionRecordId, type MissionDefinition } from '../core/Missions.ts';
import type { QualityProfile } from '../core/Settings.ts';
import type { Course } from './Course.ts';
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

/** Common finish facts owned by Game; objectives add only their exhaustive kind-specific facts. */
export interface MissionResultInput {
  readonly totalTime: number;
  readonly hullRemaining: number;
  readonly topSpeed: number;
  readonly cleanRun: boolean;
  readonly bestTime: number | null;
  readonly bestSplits: readonly number[];
  readonly isNewBest: boolean;
  readonly cruiseSpeed: number;
}

export interface MissionObjectiveRuntime {
  readonly kind: MissionDefinition['objective']['kind'];
  reset(): void;
  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState;
  guidance(position: THREE.Vector3): ObjectiveGuidance;
  telemetry(): ObjectiveTelemetry;
  bestRunSplits(): readonly number[];
  buildResult(input: MissionResultInput): MissionResult;
  dispose(): void;
}

export interface WorldPresentationFrame {
  readonly dt: number;
  readonly clock: number;
  readonly runTime: number;
  readonly camera: THREE.PerspectiveCamera;
  readonly farCamera: THREE.PerspectiveCamera;
  readonly pixelScale: number;
  readonly viewportHeight: number;
  readonly shipPosition: THREE.Vector3;
  readonly shipVelocity: THREE.Vector3;
  readonly speed01: number;
  readonly boostBlend: number;
}

export interface MissionWorldRuntime {
  /** Stable source arrays; quality may change contents, never their identities. */
  readonly colliderSets: readonly (readonly unknown[])[];
  readonly targetables: readonly unknown[];
  reset(): void;
  updateSimulation(dt: number, shipPosition: THREE.Vector3): void;
  updatePresentation(frame: WorldPresentationFrame): void;
  applyQuality(profile: QualityProfile, maximum: QualityProfile): void;
  dispose(): void;
}

/** One page-load runtime: one definition, one path, one world and one objective. */
export class MissionRuntime {
  readonly definition: MissionDefinition;
  readonly path: FlightPath;
  readonly world: MissionWorldRuntime;
  readonly objective: MissionObjectiveRuntime;
  /** CAIRN-only compatibility surface for legacy harness/visual adapters; absent on new runtimes. */
  readonly legacyCourse: Course | null;

  constructor(options: {
    definition: MissionDefinition;
    path: FlightPath;
    world: MissionWorldRuntime;
    objective: MissionObjectiveRuntime;
    legacyCourse?: Course | null;
  }) {
    this.definition = options.definition;
    this.path = options.path;
    this.world = options.world;
    this.objective = options.objective;
    this.legacyCourse = options.legacyCourse ?? null;
  }

  reset(): void {
    this.world.reset();
    this.objective.reset();
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    return this.objective.update(frame);
  }

  recordId(seed: number): string {
    return missionRecordId(this.definition, seed);
  }

  bestRunSplits(): readonly number[] {
    return this.objective.bestRunSplits();
  }

  buildResult(input: MissionResultInput): MissionResult {
    return this.objective.buildResult(input);
  }

  dispose(): void {
    this.objective.dispose();
    this.world.dispose();
  }
}

export interface GameMissionRuntimeFactoryContext {
  readonly definition: MissionDefinition;
  readonly seed: number;
  /** Current CAIRN adapter. A chapter factory may ignore it and return an isolated runtime. */
  readonly fallback: MissionRuntime;
}

export type GameMissionRuntimeFactory = (
  context: GameMissionRuntimeFactoryContext,
) => MissionRuntime;

/** The only Game-facing construction seam; validation is objective-kind neutral. */
export function createGameMissionRuntime(
  context: GameMissionRuntimeFactoryContext,
  factory: GameMissionRuntimeFactory = ({ fallback }) => fallback,
): MissionRuntime {
  const runtime = factory(context);
  if (runtime.definition.id !== context.definition.id) {
    throw new Error('Mission runtime definition does not match the requested mission');
  }
  if (runtime.definition.rulesetVersion !== context.definition.rulesetVersion) {
    throw new Error('Mission runtime ruleset does not match the requested mission');
  }
  if (runtime.objective.kind !== context.definition.objective.kind) {
    throw new Error('Mission runtime objective does not match its definition');
  }
  return runtime;
}
