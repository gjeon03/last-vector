import * as THREE from 'three';
import type {
  GateRaceMissionResult,
  GateRaceObjectiveTelemetry,
} from '../core/contracts.ts';
import { calculateCourseRank } from '../core/Courses.ts';
import type { MissionDefinition } from '../core/Missions.ts';
import type { Course } from './Course.ts';
import type {
  MissionRewardEvent,
  MissionResultInput,
  MissionObjectiveRuntime,
  ObjectiveGuidance,
  ObjectiveTerminalState,
  ObjectiveUpdateFrame,
} from './MissionRuntime.ts';

/** Gate progression and the final extraction boundary, with no DOM, audio or persistence. */
export class GateRaceObjective implements MissionObjectiveRuntime {
  readonly kind = 'gate-race' as const;
  readonly course: Course;

  private readonly extractionRadius: number;
  private readonly mission: Pick<MissionDefinition, 'id' | 'rulesetVersion'>;
  private readonly offset = new THREE.Vector3();

  constructor(
    course: Course,
    extractionRadius: number,
    mission: Pick<MissionDefinition, 'id' | 'rulesetVersion'>,
  ) {
    this.course = course;
    this.extractionRadius = extractionRadius;
    this.mission = mission;
  }

  reset(): void {
    this.course.reset();
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    this.course.update(frame.position, frame.speed, frame.elapsed);
    if (!this.course.complete) return { status: 'running' };
    const signed = this.offset.copy(frame.position).sub(this.course.terminusPosition)
      .dot(this.course.terminusNormal);
    if (signed < 0) return { status: 'running' };
    this.offset.copy(frame.position).sub(this.course.terminusPosition)
      .addScaledVector(this.course.terminusNormal, -signed);
    return this.offset.length() <= this.extractionRadius
      ? { status: 'succeeded' }
      : { status: 'running' };
  }

  guidance(position: THREE.Vector3): ObjectiveGuidance {
    const gate = this.course.nextGate;
    const anchor = gate?.position ?? this.course.terminusPosition;
    return {
      label: gate?.name ?? this.course.definition.text.canonicalDestination,
      ...(gate?.nameMessage ? { labelMessage: gate.nameMessage } : {}),
      anchor,
      distance: position.distanceTo(anchor),
      progress: this.course.progress(position),
      current: this.course.nextIndex,
      total: this.course.gates.length,
    };
  }

  telemetry(): GateRaceObjectiveTelemetry {
    return {
      kind: 'gate-race',
      gatesCleared: this.course.passes.length,
      gatesTotal: this.course.gates.length,
      misses: this.course.crossings.length - this.course.passes.length,
      complete: this.course.complete,
    };
  }

  bestRunSplits(): readonly number[] {
    return this.course.passes.map((pass) => pass.time);
  }

  /** CAIRN retains its accepted-gate legacy reward path; the shared queue is intentionally empty. */
  drainRewardEvents(_out: MissionRewardEvent[]): number {
    return 0;
  }

  buildResult(input: MissionResultInput): GateRaceMissionResult {
    const splits = this.course.passes.map((pass) => pass.time);
    return {
      kind: 'gate-race',
      missionId: this.mission.id,
      rulesetVersion: this.mission.rulesetVersion,
      totalTime: input.totalTime,
      hullRemaining: input.hullRemaining,
      objectiveSummary: `${this.course.passes.length} / ${this.course.gates.length}`,
      splits,
      bestTime: input.bestTime,
      bestSplits: [...input.bestSplits],
      isNewBest: input.isNewBest,
      gatesCleared: this.course.passes.length,
      gatesTotal: this.course.gates.length,
      topSpeed: input.topSpeed,
      cleanRun: input.cleanRun,
      rank: calculateCourseRank(
        this.course.definition,
        input.totalTime,
        this.course.totalLength,
        input.cruiseSpeed,
        input.cleanRun,
      ),
      destinationName: this.course.definition.text.canonicalDestination,
      maxGateOffset: this.course.passes.reduce(
        (maximum, pass) => Math.max(maximum, pass.offset),
        0,
      ),
      newlyUnlockedMissionId: null,
    };
  }

  dispose(): void {
    this.course.dispose();
  }
}
