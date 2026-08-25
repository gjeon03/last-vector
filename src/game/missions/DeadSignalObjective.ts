import * as THREE from 'three';
import type {
  MissionRewardEvent,
  StrikeMissionResult,
  StrikeObjectiveTelemetry,
} from '../../core/contracts.ts';
import type {
  MissionObjectiveRuntime,
  MissionResultInput,
  ObjectiveGuidance,
  ObjectiveTerminalState,
  ObjectiveUpdateFrame,
} from '../MissionRuntime.ts';
import type { FlightPath } from '../FlightPath.ts';
import type { DeadSignalMissionDefinition } from './DeadSignalMission.ts';
import type { DeadSignalState, DeadSignalTargetState } from './DeadSignalState.ts';

export type DeadSignalAct = 'ingress' | 'shield-run' | 'core' | 'extract';

export class DeadSignalObjective implements MissionObjectiveRuntime {
  readonly kind = 'strike' as const;

  private readonly path: FlightPath;
  private readonly mission: DeadSignalMissionDefinition;
  private readonly state: DeadSignalState;
  private readonly offset = new THREE.Vector3();
  private spineIndex = 0;
  private progress = 0;
  private elapsed = 0;
  private terminal: ObjectiveTerminalState = { status: 'running' };

  constructor(path: FlightPath, mission: DeadSignalMissionDefinition, state: DeadSignalState) {
    this.path = path;
    this.mission = mission;
    this.state = state;
  }

  reset(): void {
    this.spineIndex = 0;
    this.progress = 0;
    this.elapsed = 0;
    this.terminal = { status: 'running' };
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    if (this.terminal.status !== 'running') return this.terminal;
    this.elapsed = frame.elapsed;
    this.advanceProgress(frame.position);
    const definition = this.mission.objective;
    const shieldDestroyed = this.state.shieldDestroyed;

    if (this.progress >= definition.coreBoundaryProgress
      && shieldDestroyed < definition.shieldRequired) {
      this.terminal = { status: 'failed', reason: 'core-boundary-without-shields' };
      return this.terminal;
    }
    if (!this.state.coreDestroyed && this.progress >= definition.coreWindowEndProgress) {
      this.terminal = { status: 'failed', reason: 'core-window-missed' };
      return this.terminal;
    }
    const coreDestroyedAt = this.state.coreDestroyedAt;
    if (this.state.coreDestroyed && coreDestroyedAt !== null
      && (frame.elapsed - coreDestroyedAt >= definition.extraction.timeoutSeconds
        || frame.elapsed >= definition.finalBlastDeadlineSeconds)) {
      this.terminal = { status: 'failed', reason: 'blast-timeout' };
      return this.terminal;
    }
    if (!this.state.coreDestroyed && frame.elapsed >= definition.finalBlastDeadlineSeconds) {
      this.terminal = { status: 'failed', reason: 'core-window-missed' };
      return this.terminal;
    }

    if (this.state.coreDestroyed && this.crossedExtraction(frame.position)) {
      this.terminal = { status: 'succeeded' };
    }
    return this.terminal;
  }

  guidance(position: THREE.Vector3): ObjectiveGuidance {
    const target = this.guidanceTarget();
    const anchor = target?.position ?? this.extractionAnchor();
    const shieldRequired = this.mission.objective.shieldRequired;
    const coreStep = this.state.coreDestroyed ? 1 : 0;
    const extractionStep = this.terminal.status === 'succeeded' ? 1 : 0;
    const current = Math.min(this.state.shieldDestroyed, shieldRequired) + coreStep + extractionStep;
    return {
      label: target?.kind === 'calibration'
        ? 'CALIBRATION TARGET'
        : target?.kind === 'shield'
          ? target.id.toUpperCase()
          : target?.kind === 'core'
            ? 'ARRAY CORE'
            : 'EXTRACTION VECTOR',
      anchor,
      distance: position.distanceTo(anchor),
      progress: this.progress,
      current,
      total: shieldRequired + 2,
    };
  }

  telemetry(): StrikeObjectiveTelemetry {
    const act = this.act();
    const coreDestroyedAt = this.state.coreDestroyedAt;
    const blastSeconds = coreDestroyedAt === null
      ? null
      : Math.max(0, Math.min(
        this.mission.objective.extraction.timeoutSeconds - (this.elapsed - coreDestroyedAt),
        this.mission.objective.finalBlastDeadlineSeconds - this.elapsed,
      ));
    return {
      kind: 'strike',
      targetsDestroyed: this.state.shieldDestroyed,
      targetsRequired: this.mission.objective.shieldRequired,
      coreDestroyed: this.state.coreDestroyed,
      extracting: act === 'extract',
      act,
      shieldNodesTotal: this.state.shieldTotal,
      calibrationDestroyed: this.state.calibrationDestroyed,
      coreExposed: this.state.shieldDestroyed >= this.mission.objective.shieldRequired,
      shotsFired: this.state.shotsFired,
      shotsHit: this.state.shotsHit,
      blastSeconds,
      pathProgress: this.progress,
    };
  }

  bestRunSplits(): readonly number[] {
    return [];
  }

  drainRewardEvents(_out: MissionRewardEvent[]): number {
    return 0;
  }

  buildResult(input: MissionResultInput): StrikeMissionResult {
    const accuracy = this.state.accuracy;
    const allNodes = this.state.shieldDestroyed === this.state.shieldTotal;
    const rank = input.totalTime <= 110 && input.cleanRun && allNodes && accuracy >= 0.75
      ? 'S'
      : input.totalTime <= 120 && accuracy >= 0.55
        ? 'A'
        : input.totalTime <= 132
          ? 'B'
          : input.totalTime <= 145
            ? 'C'
            : 'D';
    return {
      kind: 'strike',
      missionId: this.mission.id,
      rulesetVersion: this.mission.rulesetVersion,
      totalTime: input.totalTime,
      hullRemaining: input.hullRemaining,
      objectiveSummary: `${this.state.shieldDestroyed} / ${this.mission.objective.shieldRequired} + CORE`,
      targetsDestroyed: this.state.shieldDestroyed,
      targetsRequired: this.mission.objective.shieldRequired,
      shotsFired: this.state.shotsFired,
      shotsHit: this.state.shotsHit,
      coreDestroyed: this.state.coreDestroyed,
      topSpeed: input.topSpeed,
      cleanRun: input.cleanRun,
      rank,
      destinationName: this.mission.world.sourceCourse.text.canonicalDestination,
      newlyUnlockedMissionId: null,
    };
  }

  dispose(): void {
    // State and path are owned by the enclosing mission runtime.
  }

  private advanceProgress(position: THREE.Vector3): void {
    const spine = this.path.spine;
    while (this.spineIndex + 1 < spine.length) {
      const current = position.distanceToSquared(spine[this.spineIndex]!);
      const next = position.distanceToSquared(spine[this.spineIndex + 1]!);
      if (next > current) break;
      this.spineIndex++;
    }
    this.progress = this.spineIndex / Math.max(1, spine.length - 1);
  }

  private guidanceTarget(): DeadSignalTargetState | null {
    const required = this.mission.objective.shieldRequired;
    for (const target of this.state.targets) {
      if (target.destroyed || target.kind === 'core') continue;
      if (target.definition.pathT >= this.progress - 0.025) return target;
    }
    if (!this.state.coreDestroyed && this.state.shieldDestroyed >= required) {
      return this.state.targets.find((target) => target.kind === 'core') ?? null;
    }
    return null;
  }

  private extractionAnchor(): THREE.Vector3 {
    if (this.progress < 0.91) {
      return this.path.spine[Math.floor(this.path.spine.length * 0.93)]!;
    }
    return this.path.terminusPosition;
  }

  private crossedExtraction(position: THREE.Vector3): boolean {
    const signed = this.offset.copy(position).sub(this.path.terminusPosition)
      .dot(this.path.terminusNormal);
    if (signed < 0) return false;
    this.offset.copy(position).sub(this.path.terminusPosition)
      .addScaledVector(this.path.terminusNormal, -signed);
    return this.offset.length() <= this.mission.world.sourceCourse.destination.apertureRadius;
  }

  private act(): DeadSignalAct {
    if (this.state.coreDestroyed) return 'extract';
    if (this.elapsed >= 85) return 'core';
    if (this.elapsed >= 25) return 'shield-run';
    return 'ingress';
  }
}
