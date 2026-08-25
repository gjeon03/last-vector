import * as THREE from 'three';
import type {
  EscapeMissionResult,
  EscapeObjectiveTelemetry,
  MissionRewardEvent,
} from '../../core/contracts.ts';
import type { MissionDefinition } from '../../core/Missions.ts';
import { clamp01 } from '../../core/mathx.ts';
import { FlightPath } from '../FlightPath.ts';
import type {
  MissionObjectiveRuntime,
  MissionResultInput,
  ObjectiveGuidance,
  ObjectiveTerminalState,
  ObjectiveUpdateFrame,
} from '../MissionRuntime.ts';
import {
  LAST_ASCENT_CHECKPOINT_PROGRESS,
  LAST_ASCENT_CHECKPOINT_REWARD,
  LAST_ASCENT_SHOCK_EXTRACTION_SECONDS,
  LAST_ASCENT_SHOCK_GRACE_SECONDS,
  LAST_ASCENT_SHOCK_TRANSITION_SECONDS,
} from './LastAscentDefinition.ts';

const RUNNING = Object.freeze({ status: 'running' } as const);
const SUCCEEDED = Object.freeze({ status: 'succeeded' } as const);
const SHOCKFRONT_FAILURE = Object.freeze({
  status: 'failed',
  reason: 'shockfront-catch',
} as const);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export const LAST_ASCENT_CHECKPOINT_REWARD_SOURCE = 'escape-checkpoint';

const CHECKPOINT_OFFSETS = [
  [280, 0],
  [-30, 300],
  [-300, -90],
] as const;

export interface LastAscentCheckpointFrame {
  readonly index: number;
  readonly progress: number;
  readonly position: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly radius: number;
}

/** Shared authored frames keep visual openings, collision lines and reward checks identical. */
export function createLastAscentCheckpointFrames(
  path: FlightPath,
): readonly LastAscentCheckpointFrame[] {
  return LAST_ASCENT_CHECKPOINT_PROGRESS.map((progress, index) => {
    const centre = path.curve.getPointAt(progress);
    const forward = path.curve.getTangentAt(progress).normalize();
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const offset = CHECKPOINT_OFFSETS[index]!;
    return {
      index,
      progress,
      position: centre.clone()
        .addScaledVector(right, offset[0])
        .addScaledVector(up, offset[1]),
      forward,
      right,
      up,
      radius: 360,
    };
  });
}

/**
 * Scripted path-progress front. It never reads player speed or position. The late acceleration is
 * the authored impact pulse: a cruise-only trace is caught around the second act, while a committed
 * escape reaches extraction shortly before the front itself arrives there.
 */
export function lastAscentShockfrontProgressAt(
  elapsed: number,
  definition: MissionDefinition,
): number {
  if (definition.objective.kind !== 'escape') return 0;
  const shock = definition.objective.shockwave;
  const activeTime = Math.max(0, elapsed - LAST_ASCENT_SHOCK_GRACE_SECONDS);
  const transitionActive = LAST_ASCENT_SHOCK_TRANSITION_SECONDS
    - LAST_ASCENT_SHOCK_GRACE_SECONDS;
  if (activeTime <= transitionActive) {
    return shock.startProgress + shock.speed * activeTime;
  }
  const lateDuration = LAST_ASCENT_SHOCK_EXTRACTION_SECONDS
    - LAST_ASCENT_SHOCK_TRANSITION_SECONDS;
  const lateRate = (1 - shock.catchProgress) / lateDuration;
  return shock.catchProgress
    + lateRate * (elapsed - LAST_ASCENT_SHOCK_TRANSITION_SECONDS);
}

function rankForEscape(totalTime: number, clean: boolean): string {
  if (totalTime < 108 && clean) return 'S';
  if (totalTime < 118) return 'A';
  if (totalTime < 128) return 'B';
  if (totalTime < 145) return 'C';
  return 'D';
}

export class LastAscentObjective implements MissionObjectiveRuntime {
  readonly kind = 'escape' as const;

  private readonly definition: MissionDefinition;
  private readonly path: FlightPath;
  private readonly checkpoints: readonly LastAscentCheckpointFrame[];
  private readonly pendingRewards: MissionRewardEvent[] = [];
  private readonly checkpointTimes: number[] = [];
  private progressIndex = 0;
  private nextDecision = 0;
  private cleared = 0;
  private playerProgress = 0;
  private shockwaveProgress = -0.08;

  constructor(definition: MissionDefinition, path: FlightPath) {
    if (definition.objective.kind !== 'escape') {
      throw new Error('LAST ASCENT requires an escape objective definition');
    }
    this.definition = definition;
    this.path = path;
    this.checkpoints = createLastAscentCheckpointFrames(path);
  }

  reset(): void {
    this.pendingRewards.length = 0;
    this.checkpointTimes.length = 0;
    this.progressIndex = 0;
    this.nextDecision = 0;
    this.cleared = 0;
    this.playerProgress = 0;
    this.shockwaveProgress = this.definition.objective.kind === 'escape'
      ? this.definition.objective.shockwave.startProgress
      : 0;
  }

  private locateProgress(position: THREE.Vector3): number {
    const spine = this.path.spine;
    let bestIndex = this.progressIndex;
    let bestDistanceSq = Infinity;
    // The fixed 301-sample scan is cheap, seek-safe and allocation-free. Monotonic clamping below
    // prevents doubling back from creating progress or moving the shockfront.
    for (let index = 0; index < spine.length; index++) {
      const point = spine[index]!;
      const dx = point.x - position.x;
      const dy = point.y - position.y;
      const dz = point.z - position.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestIndex = index;
      }
    }
    this.progressIndex = Math.max(this.progressIndex, bestIndex);
    return this.progressIndex / (spine.length - 1);
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    this.playerProgress = Math.max(this.playerProgress, this.locateProgress(frame.position));
    this.shockwaveProgress = lastAscentShockfrontProgressAt(frame.elapsed, this.definition);

    while (
      this.nextDecision < this.checkpoints.length
      && this.playerProgress >= this.checkpoints[this.nextDecision]!.progress
    ) {
      const checkpoint = this.checkpoints[this.nextDecision]!;
      this.nextDecision += 1;
      if (frame.position.distanceToSquared(checkpoint.position) > checkpoint.radius ** 2) continue;
      this.cleared += 1;
      this.checkpointTimes.push(frame.elapsed);
      this.pendingRewards.push({
        kind: 'boost-recharge',
        amount: LAST_ASCENT_CHECKPOINT_REWARD,
        sourceId: LAST_ASCENT_CHECKPOINT_REWARD_SOURCE,
        sourceIndex: checkpoint.index,
      });
    }

    if (
      frame.elapsed > LAST_ASCENT_SHOCK_GRACE_SECONDS
      && this.shockwaveProgress >= this.playerProgress
    ) {
      return SHOCKFRONT_FAILURE;
    }
    if (this.playerProgress >= 0.997) return SUCCEEDED;
    return RUNNING;
  }

  guidance(position: THREE.Vector3): ObjectiveGuidance {
    const checkpoint = this.checkpoints[this.nextDecision];
    if (checkpoint) {
      return {
        label: `SAFE CORRIDOR ${String(checkpoint.index + 1).padStart(2, '0')}`,
        anchor: checkpoint.position,
        distance: position.distanceTo(checkpoint.position),
        progress: this.playerProgress,
        current: this.nextDecision,
        total: this.checkpoints.length,
      };
    }
    const lookAheadIndex = Math.min(
      this.path.spine.length - 1,
      this.progressIndex + Math.max(4, Math.floor(this.path.spine.length * 0.035)),
    );
    const anchor = this.playerProgress > 0.92
      ? this.path.terminusPosition
      : this.path.spine[lookAheadIndex]!;
    return {
      label: this.playerProgress < 0.8 ? 'ESCAPE BURN' : 'EXTRACTION VECTOR',
      anchor,
      distance: Math.max(0, (1 - this.playerProgress) * this.path.totalLength),
      progress: this.playerProgress,
      current: this.nextDecision,
      total: this.checkpoints.length,
    };
  }

  telemetry(): EscapeObjectiveTelemetry {
    return {
      kind: 'escape',
      pathProgress: clamp01(this.playerProgress),
      shockwaveProgress: this.shockwaveProgress,
      checkpoint: this.cleared,
      checkpointTotal: this.checkpoints.length,
    };
  }

  drainRewardEvents(out: MissionRewardEvent[]): number {
    const count = this.pendingRewards.length;
    for (let index = 0; index < count; index++) out.push(this.pendingRewards[index]!);
    this.pendingRewards.length = 0;
    return count;
  }

  bestRunSplits(): readonly number[] {
    return this.checkpointTimes;
  }

  buildResult(input: MissionResultInput): EscapeMissionResult {
    return {
      kind: 'escape',
      missionId: this.definition.id,
      rulesetVersion: this.definition.rulesetVersion,
      totalTime: input.totalTime,
      hullRemaining: input.hullRemaining,
      objectiveSummary: `${this.cleared} / ${this.checkpoints.length} SAFE`,
      topSpeed: input.topSpeed,
      cleanRun: input.cleanRun,
      rank: rankForEscape(input.totalTime, input.cleanRun),
      destinationName: this.definition.world.sourceCourse.text.canonicalDestination,
      newlyUnlockedMissionId: null,
      checkpointsCleared: this.cleared,
      checkpointsTotal: this.checkpoints.length,
      secondsAhead: Math.max(0, LAST_ASCENT_SHOCK_EXTRACTION_SECONDS - input.totalTime),
    };
  }

  dispose(): void {
    this.pendingRewards.length = 0;
    this.checkpointTimes.length = 0;
  }
}
