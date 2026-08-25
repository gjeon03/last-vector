import * as THREE from 'three';
import type {
  GateNameMessage,
  MissionRewardEvent,
  MissionResult,
  ObjectiveTelemetry,
} from '../core/contracts.ts';
export type { MissionRewardEvent } from '../core/contracts.ts';
import type { VantageDefinition } from '../core/Courses.ts';
import { missionRecordId, type MissionDefinition } from '../core/Missions.ts';
import type { QualityProfile } from '../core/Settings.ts';
import type {
  HarnessCourseCrossing,
  HarnessShearState,
  HarnessStageLandmarkState,
  HazardReport,
} from '../core/harness.ts';
import type { LightingUniforms } from '../render/lighting.ts';
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

/** Maximum rewards one MissionRuntime may expose between two drains. */
export const MISSION_REWARD_EVENT_CAPACITY = 16;

/** Maximum weapon feedback events one MissionRuntime may expose between two drains. */
export const MISSION_WEAPON_EVENT_CAPACITY = 64;

export type MissionWeaponEvent =
  | {
    readonly type: 'fire';
    readonly intensity: number;
    readonly sourceId?: string;
    readonly sourceIndex?: number;
  }
  | {
    readonly type: 'hit';
    readonly intensity: number;
    readonly sourceId?: string;
    readonly sourceIndex?: number;
  }
  | {
    readonly type: 'destroy';
    readonly intensity: number;
    readonly sourceId?: string;
    readonly sourceIndex?: number;
  };

interface MissionRewardSource {
  /**
   * Appends queued events to the caller-owned array and returns the appended count. The source
   * clears its queue, never exceeds MISSION_REWARD_EVENT_CAPACITY, and allocates nothing when
   * there are no events.
   */
  drainRewardEvents(out: MissionRewardEvent[]): number;
}

export interface MissionObjectiveRuntime extends MissionRewardSource {
  readonly kind: MissionDefinition['objective']['kind'];
  reset(): void;
  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState;
  guidance(position: THREE.Vector3): ObjectiveGuidance;
  telemetry(): ObjectiveTelemetry;
  bestRunSplits(): readonly number[];
  buildResult(input: MissionResultInput): MissionResult;
  dispose(): void;
}

export interface MissionWeaponUpdateFrame {
  /** Values are valid for the synchronous update call; runtimes copy anything they retain. */
  readonly dt: number;
  readonly elapsed: number;
  readonly position: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly fire: boolean;
  readonly targetables: readonly unknown[];
}

/** Optional bounded weapon seam. Rendering, audio and objective state remain outside it. */
export interface MissionWeaponRuntime extends MissionRewardSource {
  reset(): void;
  update(frame: MissionWeaponUpdateFrame): void;
  /** Appends and clears at most MISSION_WEAPON_EVENT_CAPACITY queued feedback events. */
  drainEvents(out: MissionWeaponEvent[]): number;
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

/** One stable, allocation-bounded spherical contact owned by the selected mission world. */
export interface WorldContact {
  readonly id: string;
  readonly kind: 'debris' | 'landmark' | 'target' | 'hazard';
  /** Mutable positions are allowed for moving hazards; the Vector3 identity remains stable. */
  readonly position: THREE.Vector3;
  readonly radius: number;
}

export interface MissionWorldRuntime {
  /** Stable array identity; contents never exceed contactCapacity and change only in place. */
  readonly contacts: readonly WorldContact[];
  readonly contactCapacity: number;
  readonly targetables: readonly unknown[];
  reset(): void;
  updateSimulation(dt: number, shipPosition: THREE.Vector3): void;
  updatePresentation(frame: WorldPresentationFrame): void;
  applyQuality(profile: QualityProfile, maximum: QualityProfile): void;
  dispose(): void;
}

export interface LegacyStagedContact {
  readonly id: string | number;
  readonly kind: 'debris' | 'landmark';
  readonly position: THREE.Vector3;
  readonly radius: number;
}

export interface LegacyGateFrame {
  readonly position: THREE.Vector3;
  readonly radius: number;
  alignment(forward: THREE.Vector3): number;
}

export interface LegacyGatePassEvent {
  readonly index: number;
  readonly time: number;
  readonly radialDistance: number;
  readonly speed: number;
  readonly offset: number;
}

export interface LegacyGateMissEvent {
  readonly gateIndex: number;
  readonly blockedBy: 'aperture' | 'shear' | null;
}

export interface LegacyAutopilotFrame {
  readonly position: THREE.Vector3;
  readonly speed: number;
  readonly energy: number;
  readonly skill: number;
  readonly alignment: number;
  readonly targetDistance: number;
}

export interface LegacyAutopilotControls {
  readonly brake: boolean;
  readonly boost: boolean;
}

/** Optional CAIRN-only capture/debug adapter. Common simulation never reads this surface. */
export interface LegacyMissionAdapter {
  autopilotTarget(
    position: THREE.Vector3,
    target: THREE.Vector3,
    elapsed: number,
    speed: number,
  ): THREE.Vector3;
  currentGate(): LegacyGateFrame | null;
  remainingDistance(position: THREE.Vector3): number;
  autopilotControls(frame: LegacyAutopilotFrame): LegacyAutopilotControls;
  vantages(): readonly VantageDefinition[];
  bindGateEvents(handlers: {
    onPass(event: LegacyGatePassEvent): void;
    onMiss(event: LegacyGateMissEvent): void;
  }): void;
  resetMotion(): void;
  clearVantage(point: THREE.Vector3, shipRadius: number, margin: number): void;
  poseGate(
    index: number,
    standoff: number,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
  ): boolean;
  seek(t: number): void;
  setVantageState(gateIndex: number | undefined, atTerminus: boolean): void;
  stageContact(kind: LegacyStagedContact['kind']): LegacyStagedContact | null;
  hazard(samples: number, consumedContacts: readonly WorldContact[] | null): HazardReport;
  crossings(): HarnessCourseCrossing[];
  stageShearBlock(elapsed: number, speed: number): HarnessCourseCrossing | null;
  shearState(elapsed: number): HarnessShearState | null;
  landmarkState(): HarnessStageLandmarkState;
}

export interface MissionContactBody {
  readonly position: THREE.Vector3;
  readonly radius: number;
  readonly speed: number;
  readonly hull: number;
  applyImpact(normal: THREE.Vector3, penetration: number): number;
}

export interface MissionSimulationFrame {
  readonly dt: number;
  readonly elapsed: number;
  readonly body: MissionContactBody;
  readonly forward: THREE.Vector3;
  readonly fire: boolean;
  readonly proximityRange: number;
  readonly resolveContacts: boolean;
  readonly resolveObjective: boolean;
  readonly onContact?: (
    contact: WorldContact,
    penetration: number,
    severity: number,
  ) => void;
}

export interface MissionSimulationOutcome {
  readonly proximity: number;
  readonly hullFailed: boolean;
  /** Null when hull failure wins or the objective is not active in this phase. */
  readonly terminal: ObjectiveTerminalState | null;
}

/** One page-load runtime: one definition, one path, one world and one objective. */
export class MissionRuntime {
  readonly definition: MissionDefinition;
  readonly path: FlightPath;
  readonly world: MissionWorldRuntime;
  readonly objective: MissionObjectiveRuntime;
  readonly weapon: MissionWeaponRuntime | null;
  readonly legacy: LegacyMissionAdapter | null;

  private readonly contactNormal = new THREE.Vector3();
  /** Reused for the optional weapon update so the seam adds no steady-state frame allocation. */
  private readonly weaponUpdateFrame = {
    dt: 0,
    elapsed: 0,
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    fire: false,
    targetables: [] as readonly unknown[],
  };

  constructor(options: {
    definition: MissionDefinition;
    path: FlightPath;
    world: MissionWorldRuntime;
    objective: MissionObjectiveRuntime;
    weapon?: MissionWeaponRuntime | null;
    legacy?: LegacyMissionAdapter | null;
  }) {
    this.definition = options.definition;
    this.path = options.path;
    this.world = options.world;
    this.objective = options.objective;
    this.weapon = options.weapon ?? null;
    this.legacy = options.legacy ?? null;
  }

  reset(): void {
    this.world.reset();
    this.weapon?.reset();
    this.objective.reset();
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    return this.objective.update(frame);
  }

  /** Common frame order: world motion -> all contacts -> hull -> weapon -> objective. */
  simulate(frame: MissionSimulationFrame): MissionSimulationOutcome {
    this.world.updateSimulation(frame.dt, frame.body.position);
    let nearest = Infinity;
    const contacts = this.world.contacts;
    if (contacts.length > this.world.contactCapacity) {
      throw new Error('Mission world exceeded its declared contact capacity');
    }
    for (const contact of contacts) {
      const dx = contact.position.x - frame.body.position.x;
      const dy = contact.position.y - frame.body.position.y;
      const dz = contact.position.z - frame.body.position.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      const reach = contact.radius + frame.body.radius + frame.proximityRange;
      if (distanceSq > reach * reach) continue;

      const distance = Math.sqrt(distanceSq);
      nearest = Math.min(nearest, distance - contact.radius - frame.body.radius);
      const penetration = contact.radius + frame.body.radius - distance;
      if (!frame.resolveContacts || penetration <= 0 || distance <= 1e-3) continue;

      this.contactNormal.set(-dx / distance, -dy / distance, -dz / distance);
      const severity = frame.body.applyImpact(this.contactNormal, penetration);
      frame.onContact?.(contact, penetration, severity);
    }

    const proximity = nearest === Infinity
      ? 0
      : Math.min(1, Math.max(0, 1 - nearest / frame.proximityRange));
    const hullFailed = frame.body.hull <= 0;
    let terminal: ObjectiveTerminalState | null = null;
    if (frame.resolveObjective && !hullFailed) {
      if (this.weapon) {
        const weaponFrame = this.weaponUpdateFrame;
        weaponFrame.dt = frame.dt;
        weaponFrame.elapsed = frame.elapsed;
        weaponFrame.position.copy(frame.body.position);
        weaponFrame.forward.copy(frame.forward);
        weaponFrame.fire = frame.fire;
        weaponFrame.targetables = this.world.targetables;
        this.weapon.update(weaponFrame);
      }
      terminal = this.objective.update({
        position: frame.body.position,
        speed: frame.body.speed,
        elapsed: frame.elapsed,
      });
    }
    return { proximity, hullFailed, terminal };
  }

  /** Aggregates weapon then objective rewards in simulation order into one reusable buffer. */
  drainRewardEvents(out: MissionRewardEvent[]): number {
    const start = out.length;
    if (start > MISSION_REWARD_EVENT_CAPACITY) {
      throw new Error('Mission reward output already exceeds its declared capacity');
    }
    if (this.weapon) this.drainRewardsFrom(this.weapon, out);
    this.drainRewardsFrom(this.objective, out);
    return out.length - start;
  }

  /** Drains weapon feedback without adapting it to audio or presentation. */
  drainWeaponEvents(out: MissionWeaponEvent[]): number {
    if (out.length > MISSION_WEAPON_EVENT_CAPACITY) {
      throw new Error('Mission weapon output already exceeds its declared capacity');
    }
    if (!this.weapon) return 0;
    const start = out.length;
    const reported = this.weapon.drainEvents(out);
    return this.validateDrain(
      reported,
      out,
      start,
      MISSION_WEAPON_EVENT_CAPACITY,
      'Mission weapon',
    );
  }

  private drainRewardsFrom(source: MissionRewardSource, out: MissionRewardEvent[]): number {
    const start = out.length;
    const reported = source.drainRewardEvents(out);
    return this.validateDrain(
      reported,
      out,
      start,
      MISSION_REWARD_EVENT_CAPACITY,
      'Mission reward',
    );
  }

  private validateDrain<T>(
    reported: number,
    out: T[],
    start: number,
    capacity: number,
    label: string,
  ): number {
    const appended = out.length - start;
    if (!Number.isInteger(reported) || reported < 0 || reported !== appended) {
      out.length = start;
      throw new Error(`${label} drain returned an invalid event count`);
    }
    if (out.length > capacity) {
      out.length = start;
      throw new Error(`${label} drain exceeded its declared capacity`);
    }
    return appended;
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
    this.weapon?.dispose();
    this.world.dispose();
  }
}

export interface GameMissionRuntimeFactoryContext {
  readonly definition: MissionDefinition;
  readonly seed: number;
  readonly renderer: THREE.WebGLRenderer;
  readonly farScene: THREE.Scene;
  readonly mainScene: THREE.Scene;
  readonly lighting: LightingUniforms;
  readonly initialQuality: QualityProfile;
  readonly maximumQuality: QualityProfile;
}

export type GameMissionRuntimeFactory = (
  context: GameMissionRuntimeFactoryContext,
) => MissionRuntime;

/** The only Game-facing construction seam; validation is objective-kind neutral. */
export function createGameMissionRuntime(
  context: GameMissionRuntimeFactoryContext,
  factory: GameMissionRuntimeFactory,
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
