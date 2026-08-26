import * as THREE from 'three';
import { FLIGHT } from '../../core/art.ts';
import type {
  CollectionMissionResult,
  CollectionObjectiveTelemetry,
  CollectionSourceTelemetry,
  MissionRewardEvent,
  ScreenAnchor,
} from '../../core/contracts.ts';
import type {
  MissionObjectiveRuntime,
  MissionResultInput,
  ObjectiveGuidance,
  ObjectiveTerminalState,
  ObjectiveUpdateFrame,
} from '../MissionRuntime.ts';
import {
  RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
  RELAY_HARVEST_BOOST_REWARD,
  RELAY_HARVEST_CAPTURE_RADIUS,
  RELAY_HARVEST_CHARGE_REQUIRED,
  RELAY_HARVEST_RELAY_CAPTURE_RADIUS,
  RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
} from './RelayHarvestLayout.ts';
import { RelayHarvestState } from './RelayHarvestState.ts';

const RUNNING = Object.freeze({ status: 'running' } as const);
const SUCCEEDED = Object.freeze({ status: 'succeeded' } as const);
const RELAY_WINDOW_CLOSED = Object.freeze({
  status: 'failed',
  reason: 'relay-window-closed',
} as const);
const TOI_EPSILON = 1e-9;
const PRIMARY_SWITCH_MARGIN = 0.12;
const PRIMARY_SWITCH_FLOOR = 350;

interface CollectionCandidate {
  sourceIndex: number;
  timeOfImpact: number;
}

interface MutableCollectionTelemetry extends CollectionObjectiveTelemetry {
  phase: 'collecting' | 'returning';
  collected: number;
  charge: number;
  primaryExpiresIn: number | null;
  relayRemaining: number | null;
  relayWindow: number | null;
  primarySourceId: string | null;
  primaryDistance: number | null;
}

interface MutableCollectionSourceTelemetry extends CollectionSourceTelemetry {
  generation: number;
  expiresIn: number | null;
}

function createAnchor(): ScreenAnchor {
  return { x: 0, y: 0, onScreen: false, angle: 0, distance: 0 };
}

function rankForCollection(totalTime: number, cleanRun: boolean, referenceSeconds: number): string {
  if (totalTime < referenceSeconds && cleanRun) return 'S';
  if (totalTime < referenceSeconds * 1.15) return 'A';
  if (totalTime < referenceSeconds * 1.35) return 'B';
  if (totalTime < referenceSeconds * 1.6) return 'C';
  return 'D';
}

/** Earliest segment/sphere entry. Handles an initial point already inside the capture volume. */
export function relayHarvestSegmentSphereEntry(
  start: THREE.Vector3,
  end: THREE.Vector3,
  centre: THREE.Vector3,
  radius = RELAY_HARVEST_CAPTURE_RADIUS,
): number | null {
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const sx = start.x - centre.x;
  const sy = start.y - centre.y;
  const sz = start.z - centre.z;
  const radiusSq = radius * radius;
  const c = sx * sx + sy * sy + sz * sz - radiusSq;
  if (c <= 0) return 0;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const a = dx * dx + dy * dy + dz * dz;
  if (a <= TOI_EPSILON) return null;
  const halfB = sx * dx + sy * dy + sz * dz;
  const discriminant = halfB * halfB - a * c;
  if (discriminant < 0) return null;
  const timeOfImpact = (-halfB - Math.sqrt(Math.max(0, discriminant))) / a;
  if (timeOfImpact < -TOI_EPSILON || timeOfImpact > 1 + TOI_EPSILON) return null;
  return Math.max(0, Math.min(1, timeOfImpact));
}

/**
 * Collection owner for BLACKOUT RELAY. Its state is deliberately injected so renderer and
 * objective observe the same ten stable source objects without a mission-ID branch in Game.
 */
export class RelayHarvestObjective implements MissionObjectiveRuntime {
  readonly kind = 'collection' as const;
  readonly state: RelayHarvestState;

  private readonly rewardPool: readonly MissionRewardEvent[];
  private readonly pendingRewardSourceIndices = new Uint8Array(RELAY_HARVEST_ACTIVE_SOURCE_COUNT);
  private readonly candidates: CollectionCandidate[] = Array.from(
    { length: RELAY_HARVEST_ACTIVE_SOURCE_COUNT },
    () => ({ sourceIndex: -1, timeOfImpact: Infinity }),
  );
  private readonly previousPosition = new THREE.Vector3();
  private readonly lastPosition = new THREE.Vector3();
  private readonly lastForward = new THREE.Vector3(0, 0, -1);
  private readonly direction = new THREE.Vector3();
  private readonly returnSegmentStart = new THREE.Vector3();
  private readonly telemetrySources: MutableCollectionSourceTelemetry[];
  private readonly telemetryValue: MutableCollectionTelemetry;
  private readonly pickupSplits: number[] = [];
  private hasPreviousPosition = false;
  private previousElapsed = 0;
  private primarySourceIndex = -1;
  private candidateCount = 0;
  private pendingRewardCount = 0;
  private lastElapsed = 0;

  constructor(state: RelayHarvestState) {
    this.state = state;
    this.rewardPool = Object.freeze(state.sources.map((source) => Object.freeze({
      kind: 'boost-recharge' as const,
      amount: RELAY_HARVEST_BOOST_REWARD,
      sourceId: source.id,
      sourceIndex: source.index,
    })));
    this.telemetrySources = state.sources.map((source) => ({
      id: source.id,
      position: source.position.toArray() as [number, number, number],
      anchor: createAnchor(),
      generation: 0,
      expiresIn: source.expiresAt,
      distance: Infinity,
      collected: false,
      primary: false,
    }));
    this.telemetryValue = {
      kind: 'collection',
      phase: 'collecting',
      collected: 0,
      required: RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
      activeTotal: RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
      charge: 0,
      chargeRequired: RELAY_HARVEST_CHARGE_REQUIRED,
      primaryExpiresIn: null,
      relayRemaining: null,
      relayWindow: null,
      primarySourceId: null,
      primaryDistance: null,
      sources: Object.freeze(this.telemetrySources),
    };
    this.reset();
  }

  reset(): void {
    this.state.reset();
    this.pendingRewardCount = 0;
    this.pickupSplits.length = 0;
    this.hasPreviousPosition = false;
    this.previousElapsed = 0;
    this.primarySourceIndex = -1;
    this.candidateCount = 0;
    this.lastElapsed = 0;
    this.lastPosition.set(0, 0, 0);
    this.lastForward.set(0, 0, -1);
    for (const source of this.telemetrySources) {
      source.distance = Infinity;
      source.collected = false;
      source.primary = false;
      source.anchor.x = 0;
      source.anchor.y = 0;
      source.anchor.onScreen = false;
      source.anchor.angle = 0;
      source.anchor.distance = 0;
    }
    this.syncTelemetry();
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    if (this.state.extracted) return SUCCEEDED;
    if (this.state.failureReason !== null) return RELAY_WINDOW_CLOSED;
    this.lastPosition.copy(frame.position);
    this.lastElapsed = Math.max(0, frame.elapsed);
    if (frame.forward && frame.forward.lengthSq() > 1e-9) this.lastForward.copy(frame.forward).normalize();

    const segmentStart = frame.previousPosition ?? (
      this.hasPreviousPosition ? this.previousPosition : frame.position
    );
    const startElapsed = this.hasPreviousPosition
      ? this.previousElapsed
      : Math.max(0, frame.elapsed - Math.max(0, frame.position.distanceTo(segmentStart)
        / Math.max(1, frame.speed)));

    let returnStart: THREE.Vector3 | null = null;
    let returnStartElapsed = startElapsed;
    if (this.state.phase === 'collecting') {
      this.candidateCount = 0;
      for (let index = 0; index < this.state.sources.length; index++) {
        const source = this.state.sources[index]!;
        if (source.collected) continue;
        const timeOfImpact = relayHarvestSegmentSphereEntry(
          segmentStart,
          frame.position,
          source.position,
        );
        if (timeOfImpact === null) continue;
        const candidate = this.candidates[this.candidateCount++]!;
        candidate.sourceIndex = index;
        candidate.timeOfImpact = timeOfImpact;
      }
      this.sortCandidates();

      for (let index = 0; index < this.candidateCount; index++) {
        if (this.state.collected >= RELAY_HARVEST_REQUIRED_SOURCE_COUNT) break;
        const candidate = this.candidates[index]!;
        const collectedAt = startElapsed
          + Math.max(0, frame.elapsed - startElapsed) * candidate.timeOfImpact;
        const candidateSource = this.state.sources[candidate.sourceIndex]!;
        // The swept pickup owns its exact contact time. An expiry later in this frame must not
        // erase an earlier valid pickup (or let 60/120 Hz choose different outcomes).
        if (candidateSource.expiresAt !== null
          && collectedAt > candidateSource.expiresAt + TOI_EPSILON) continue;
        const source = this.state.collect(candidate.sourceIndex, collectedAt);
        if (!source) continue;
        this.pickupSplits.push(source.collectedAt!);
        this.pendingRewardSourceIndices[this.pendingRewardCount++] = source.index;
        if (candidate.sourceIndex === this.primarySourceIndex) this.primarySourceIndex = -1;
        if (this.state.collected === RELAY_HARVEST_REQUIRED_SOURCE_COUNT) {
          this.returnSegmentStart.lerpVectors(segmentStart, frame.position, candidate.timeOfImpact);
          this.state.beginReturn(
            collectedAt,
            this.returnSegmentStart.distanceTo(this.state.relayPosition),
            FLIGHT.cruiseSpeed,
          );
          returnStart = this.returnSegmentStart;
          returnStartElapsed = collectedAt;
        }
      }
      // Expiry is applied after exact-time contacts. At maximum ship speed one frame travels far
      // less than the 220 m capture radius, so a source reached just after relocation is still
      // captured from the following frame's swept segment without tunnelling.
      this.state.relocateExpired(frame.elapsed);
    } else {
      returnStart = segmentStart;
    }

    this.previousPosition.copy(frame.position);
    this.previousElapsed = frame.elapsed;
    this.hasPreviousPosition = true;
    this.updatePrimary(frame.position, frame.forward ?? this.lastForward);
    this.syncTelemetry();
    if (this.state.phase !== 'returning') return RUNNING;
    return this.resolveReturn(
      returnStart ?? segmentStart,
      frame.position,
      returnStartElapsed,
      frame.elapsed,
    );
  }

  guidance(position: THREE.Vector3): ObjectiveGuidance {
    if (this.state.phase === 'returning') {
      const distance = position.distanceTo(this.state.relayPosition);
      this.syncTelemetry();
      return {
        label: 'LAUNCH RELAY',
        anchor: this.state.relayPosition,
        distance,
        progress: 1,
        current: this.state.collected,
        total: RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
      };
    }
    this.updatePrimary(position, this.lastForward);
    this.syncTelemetry();
    const primary = this.state.sources[this.primarySourceIndex]
      ?? this.state.sources.find((source) => !source.collected)
      ?? this.state.sources[0]!;
    const distance = position.distanceTo(primary.position);
    return {
      label: primary.collected ? 'RELAY STABLE' : primary.id,
      anchor: primary.position,
      distance,
      progress: Math.min(1, this.state.charge / RELAY_HARVEST_CHARGE_REQUIRED),
      current: this.state.collected,
      total: RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
    };
  }

  telemetry(): CollectionObjectiveTelemetry {
    this.syncTelemetry();
    return this.telemetryValue;
  }

  bestRunSplits(): readonly number[] {
    return this.pickupSplits;
  }

  buildResult(input: MissionResultInput): CollectionMissionResult {
    return {
      kind: 'collection',
      missionId: 'relay-harvest',
      rulesetVersion: 2,
      totalTime: input.totalTime,
      hullRemaining: input.hullRemaining,
      objectiveSummary: `${this.state.collected} / ${RELAY_HARVEST_REQUIRED_SOURCE_COUNT} CORES + RELAY RETURN`,
      topSpeed: input.topSpeed,
      cleanRun: input.cleanRun,
      rank: rankForCollection(
        input.totalTime,
        input.cleanRun,
        this.state.layout.referenceRoutes[0].referenceSeconds,
      ),
      destinationName: 'BLACKOUT RELAY',
      newlyUnlockedMissionId: null,
      bestTime: input.bestTime,
      isNewBest: input.isNewBest,
      collected: this.state.collected,
      required: RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
      activeTotal: RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
      charge: this.state.charge,
      chargeRequired: RELAY_HARVEST_CHARGE_REQUIRED,
    };
  }

  recordId(baseRecordId: string): string {
    return `${baseRecordId}-layout-${this.state.layoutSignature}`;
  }

  drainRewardEvents(out: MissionRewardEvent[]): number {
    const start = out.length;
    for (let index = 0; index < this.pendingRewardCount; index++) {
      out.push(this.rewardPool[this.pendingRewardSourceIndices[index]!]!);
    }
    this.pendingRewardCount = 0;
    return out.length - start;
  }

  dispose(): void {
    this.pendingRewardCount = 0;
  }

  private resolveReturn(
    segmentStart: THREE.Vector3,
    segmentEnd: THREE.Vector3,
    startElapsed: number,
    endElapsed: number,
  ): ObjectiveTerminalState {
    const deadline = this.state.relayDeadline;
    if (deadline === null) return RUNNING;
    const entry = relayHarvestSegmentSphereEntry(
      segmentStart,
      segmentEnd,
      this.state.relayPosition,
      RELAY_HARVEST_RELAY_CAPTURE_RADIUS,
    );
    if (entry !== null) {
      const entryElapsed = startElapsed + Math.max(0, endElapsed - startElapsed) * entry;
      if (entryElapsed <= deadline + TOI_EPSILON) {
        this.state.markExtracted();
        return SUCCEEDED;
      }
    }
    if (endElapsed >= deadline - TOI_EPSILON) {
      this.state.markFailed(RELAY_WINDOW_CLOSED.reason);
      return RELAY_WINDOW_CLOSED;
    }
    return RUNNING;
  }

  private sortCandidates(): void {
    // Ten fixed slots make insertion sort cheaper and more deterministic than allocating a slice.
    for (let index = 1; index < this.candidateCount; index++) {
      const value = this.candidates[index]!;
      let cursor = index - 1;
      while (cursor >= 0 && this.compareCandidates(value, this.candidates[cursor]!) < 0) {
        this.candidates[cursor + 1] = this.candidates[cursor]!;
        cursor--;
      }
      this.candidates[cursor + 1] = value;
    }
  }

  private compareCandidates(a: CollectionCandidate, b: CollectionCandidate): number {
    const timeDelta = a.timeOfImpact - b.timeOfImpact;
    if (Math.abs(timeDelta) > TOI_EPSILON) return timeDelta;
    return this.state.sources[a.sourceIndex]!.id.localeCompare(this.state.sources[b.sourceIndex]!.id);
  }

  private sourceScore(index: number, position: THREE.Vector3, forward: THREE.Vector3): number {
    const source = this.state.sources[index]!;
    this.direction.copy(source.position).sub(position);
    const distance = this.direction.length();
    if (distance <= 1e-6) return 0;
    this.direction.divideScalar(distance);
    const alignment = Math.max(-1, Math.min(1, forward.dot(this.direction)));
    const angle = Math.acos(alignment);
    return angle * 6_000 + distance * 0.25;
  }

  private updatePrimary(position: THREE.Vector3, forward: THREE.Vector3): void {
    if (this.state.phase === 'returning') {
      this.primarySourceIndex = -1;
      return;
    }
    let bestIndex = -1;
    let bestScore = Infinity;
    for (let index = 0; index < this.state.sources.length; index++) {
      const source = this.state.sources[index]!;
      if (source.collected) continue;
      const score = this.sourceScore(index, position, forward);
      if (score < bestScore - TOI_EPSILON
        || (Math.abs(score - bestScore) <= TOI_EPSILON
          && (bestIndex < 0 || source.id < this.state.sources[bestIndex]!.id))) {
        bestIndex = index;
        bestScore = score;
      }
    }
    if (bestIndex < 0) {
      this.primarySourceIndex = -1;
      return;
    }
    const current = this.state.sources[this.primarySourceIndex];
    if (!current || current.collected) {
      this.primarySourceIndex = bestIndex;
      return;
    }
    const currentScore = this.sourceScore(this.primarySourceIndex, position, forward);
    const requiredImprovement = Math.max(PRIMARY_SWITCH_FLOOR, currentScore * PRIMARY_SWITCH_MARGIN);
    if (bestIndex !== this.primarySourceIndex && bestScore + requiredImprovement < currentScore) {
      this.primarySourceIndex = bestIndex;
    }
  }

  private syncTelemetry(): void {
    const collecting = this.state.phase === 'collecting';
    const primary = collecting ? this.state.sources[this.primarySourceIndex] ?? null : null;
    for (let index = 0; index < this.state.sources.length; index++) {
      const stateSource = this.state.sources[index]!;
      const telemetrySource = this.telemetrySources[index]!;
      const telemetryPosition = telemetrySource.position as [number, number, number];
      telemetryPosition[0] = stateSource.position.x;
      telemetryPosition[1] = stateSource.position.y;
      telemetryPosition[2] = stateSource.position.z;
      telemetrySource.generation = stateSource.generation;
      telemetrySource.expiresIn = collecting && !stateSource.collected && stateSource.expiresAt !== null
        ? Math.max(0, stateSource.expiresAt - this.lastElapsed)
        : null;
      telemetrySource.distance = this.hasPreviousPosition
        ? this.lastPosition.distanceTo(stateSource.position)
        : Infinity;
      telemetrySource.collected = stateSource.collected;
      telemetrySource.primary = collecting && index === this.primarySourceIndex;
    }
    this.telemetryValue.phase = this.state.phase;
    this.telemetryValue.collected = this.state.collected;
    this.telemetryValue.charge = this.state.charge;
    this.telemetryValue.primaryExpiresIn = primary?.expiresAt !== null && primary?.expiresAt !== undefined
      ? Math.max(0, primary.expiresAt - this.lastElapsed)
      : null;
    this.telemetryValue.relayRemaining = this.state.relayRemaining(this.lastElapsed);
    this.telemetryValue.relayWindow = this.state.relayWindow;
    this.telemetryValue.primarySourceId = primary?.id ?? null;
    this.telemetryValue.primaryDistance = this.state.phase === 'returning'
      ? (this.hasPreviousPosition ? this.lastPosition.distanceTo(this.state.relayPosition) : null)
      : (primary && this.hasPreviousPosition ? this.lastPosition.distanceTo(primary.position) : null);
  }
}
