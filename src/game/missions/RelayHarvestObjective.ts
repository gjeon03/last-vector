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
  RELAY_HARVEST_CELL_LIFETIME,
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

function rankForCollection(totalTime: number, cleanRun: boolean, parSeconds: number): string {
  const ratio = totalTime / Math.max(1, parSeconds);
  if (ratio < 0.74 && cleanRun) return 'S';
  if (ratio < 0.84) return 'A';
  if (ratio < 0.96) return 'B';
  if (ratio < 1.18) return 'C';
  return 'D';
}

/** Earliest segment/sphere entry, including a segment that starts inside the sphere. */
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

/** Mission-runtime adapter over the deterministic Relay Harvest state. */
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
      sourceId: `CELL-${String(source.index + 1).padStart(2, '0')}`,
      sourceIndex: source.index,
    })));
    this.telemetrySources = state.sources.map((source) => ({
      id: `CELL-${String(source.index + 1).padStart(2, '0')}`,
      position: source.position.toArray() as [number, number, number],
      anchor: createAnchor(),
      generation: source.generation,
      expiresIn: source.charge * RELAY_HARVEST_CELL_LIFETIME,
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
    this.lastPosition.copy(this.state.relayPosition);
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
    this.updatePrimary(this.state.relayPosition);
    this.syncTelemetry();
  }

  update(frame: ObjectiveUpdateFrame): ObjectiveTerminalState {
    if (this.state.extracted) return SUCCEEDED;
    if (this.state.failureReason !== null) return RELAY_WINDOW_CLOSED;

    const elapsed = Number.isFinite(frame.elapsed) ? Math.max(0, frame.elapsed) : 0;
    const segmentStart = frame.previousPosition ?? (
      this.hasPreviousPosition ? this.previousPosition : frame.position
    );
    const startElapsed = this.hasPreviousPosition
      ? this.previousElapsed
      : Math.max(0, elapsed - frame.position.distanceTo(segmentStart) / Math.max(1, frame.speed));
    const dt = this.hasPreviousPosition ? Math.max(0, elapsed - this.previousElapsed) : elapsed;
    this.lastPosition.copy(frame.position);
    this.lastElapsed = elapsed;

    let returnStart: THREE.Vector3 | null = null;
    let returnStartElapsed = startElapsed;
    if (this.state.phase === 'collecting') {
      // Expiry owns the frame before collision: a cell that discharged is never also collected.
      this.state.advanceDecay(elapsed, dt);
      this.candidateCount = 0;
      for (let index = 0; index < this.state.sources.length; index++) {
        const source = this.state.sources[index]!;
        if (!source.alive) continue;
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
          + Math.max(0, elapsed - startElapsed) * candidate.timeOfImpact;
        const pickup = this.state.collect(candidate.sourceIndex, collectedAt);
        if (!pickup) continue;
        this.pickupSplits.push(pickup.collectedAt);
        this.pendingRewardSourceIndices[this.pendingRewardCount++] = pickup.sourceIndex;

        if (pickup.quotaMet) {
          this.returnSegmentStart.lerpVectors(segmentStart, frame.position, candidate.timeOfImpact);
          this.state.beginReturn(
            pickup.collectedAt,
            this.returnSegmentStart.distanceTo(this.state.relayPosition),
            FLIGHT.cruiseSpeed,
          );
          returnStart = this.returnSegmentStart;
          returnStartElapsed = pickup.collectedAt;
          break;
        }
      }
    } else {
      returnStart = segmentStart;
    }

    this.previousPosition.copy(frame.position);
    this.previousElapsed = elapsed;
    this.hasPreviousPosition = true;
    this.updatePrimary(frame.position);
    this.syncTelemetry();

    if (this.state.phase !== 'returning') return RUNNING;
    return this.resolveReturn(
      returnStart ?? segmentStart,
      frame.position,
      returnStartElapsed,
      elapsed,
    );
  }

  guidance(position: THREE.Vector3): ObjectiveGuidance {
    if (this.state.phase === 'returning') {
      const distance = position.distanceTo(this.state.relayPosition);
      this.syncTelemetry();
      return {
        label: 'RELAY',
        anchor: this.state.relayPosition,
        distance,
        progress: 1,
        current: this.state.collected,
        total: RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
      };
    }

    this.updatePrimary(position);
    this.syncTelemetry();
    const primary = this.state.sources[this.primarySourceIndex]
      ?? this.state.nearestSource(position);
    if (!primary) {
      return {
        label: 'RELAY',
        anchor: this.state.relayPosition,
        distance: position.distanceTo(this.state.relayPosition),
        progress: this.state.collected / RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
        current: this.state.collected,
        total: RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
      };
    }
    return {
      label: 'ENERGY CELL',
      anchor: primary.position,
      distance: position.distanceTo(primary.position),
      progress: this.state.collected / RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
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
    const par = (this.state.path.totalLength * 1.45) / FLIGHT.cruiseSpeed;
    return {
      kind: 'collection',
      missionId: 'relay-harvest',
      rulesetVersion: 3,
      totalTime: input.totalTime,
      hullRemaining: input.hullRemaining,
      objectiveSummary: `${this.state.collected} / ${RELAY_HARVEST_REQUIRED_SOURCE_COUNT} CELLS + RELAY RETURN`,
      topSpeed: input.topSpeed,
      cleanRun: input.cleanRun,
      rank: rankForCollection(input.totalTime, input.cleanRun, par),
      destinationName: 'RELAY HEART',
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
    return baseRecordId;
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
    return this.state.sources[a.sourceIndex]!.id - this.state.sources[b.sourceIndex]!.id;
  }

  private updatePrimary(position: THREE.Vector3): void {
    const nearest = this.state.phase === 'collecting' ? this.state.nearestSource(position) : null;
    this.primarySourceIndex = nearest?.index ?? -1;
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
      telemetrySource.expiresIn = collecting && stateSource.alive
        ? Math.max(0, stateSource.charge * RELAY_HARVEST_CELL_LIFETIME)
        : null;
      telemetrySource.distance = this.hasPreviousPosition
        ? this.lastPosition.distanceTo(stateSource.position)
        : Infinity;
      telemetrySource.collected = !stateSource.alive;
      telemetrySource.primary = collecting && index === this.primarySourceIndex;
    }
    this.telemetryValue.phase = this.state.phase;
    this.telemetryValue.collected = this.state.collected;
    this.telemetryValue.charge = this.state.charge;
    this.telemetryValue.primaryExpiresIn = primary?.alive
      ? Math.max(0, primary.charge * RELAY_HARVEST_CELL_LIFETIME)
      : null;
    this.telemetryValue.relayRemaining = this.state.relayRemaining(this.lastElapsed);
    this.telemetryValue.relayWindow = this.state.relayWindow;
    this.telemetryValue.primarySourceId = primary
      ? this.telemetrySources[primary.index]!.id
      : null;
    this.telemetryValue.primaryDistance = this.state.phase === 'returning'
      ? (this.hasPreviousPosition ? this.lastPosition.distanceTo(this.state.relayPosition) : null)
      : (primary && this.hasPreviousPosition ? this.lastPosition.distanceTo(primary.position) : null);
  }
}
