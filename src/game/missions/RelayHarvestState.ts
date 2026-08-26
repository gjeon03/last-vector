import * as THREE from 'three';
import { distanceToSegment } from '../../core/mathx.ts';
import { Rng } from '../../core/rng.ts';
import type { AsteroidInstance } from '../../render/Asteroids.ts';
import type { FlightPath } from '../FlightPath.ts';
import {
  RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
  RELAY_HARVEST_CELL_LIFETIME,
  RELAY_HARVEST_CHARGE_PER_SOURCE,
  RELAY_HARVEST_MAX_CHANNEL_MULTIPLIER,
  RELAY_HARVEST_MAX_PATH_FRACTION,
  RELAY_HARVEST_MIN_CHANNEL_MULTIPLIER,
  RELAY_HARVEST_MIN_PATH_FRACTION,
  RELAY_HARVEST_MIN_SOURCE_SEPARATION,
  RELAY_HARVEST_PLACEMENT_ATTEMPTS,
  RELAY_HARVEST_PREGENERATED_POSITION_COUNT,
  RELAY_HARVEST_REQUIRED_ROCK_CLEARANCE,
  RELAY_HARVEST_REQUIRED_SOURCE_COUNT,
  RELAY_HARVEST_RETURN_MINIMUM_SECONDS,
  RELAY_HARVEST_RETURN_PACE,
} from './RelayHarvestLayout.ts';

export type RelayHarvestPhase = 'collecting' | 'returning';

/** One fixed renderer slot. Its position and identity are reused when a cell respawns. */
export interface RelayHarvestSourceState {
  readonly index: number;
  readonly position: THREE.Vector3;
  /** Monotonic cell identity; changes every time this fixed slot respawns. */
  id: number;
  /** Renderer-friendly respawn counter. */
  generation: number;
  phase: number;
  charge: number;
  alive: boolean;
  spawnedAt: number;
  expiresAt: number | null;
  /** Compatibility state for collection telemetry: false again after an immediate respawn. */
  collected: boolean;
  collectedAt: number | null;
}

export interface RelayHarvestPickup {
  readonly sourceIndex: number;
  readonly cellId: number;
  readonly collectedAt: number;
  readonly collected: number;
  readonly quotaMet: boolean;
}

export interface RelayHarvestStateDebug {
  readonly seed: number;
  readonly phase: RelayHarvestPhase;
  readonly collected: number;
  readonly charge: number;
  readonly active: number;
  readonly queueIndex: number;
  readonly relayWindow: number | null;
  readonly relayDeadline: number | null;
  readonly sources: readonly {
    readonly index: number;
    readonly id: number;
    readonly position: readonly [number, number, number];
    readonly generation: number;
    readonly phase: number;
    readonly charge: number;
    readonly alive: boolean;
    readonly spawnedAt: number;
    readonly expiresAt: number | null;
  }[];
}

/**
 * Deterministic Harvest simulation state.
 *
 * All potentially variable asteroid searches happen once in the constructor. Pickups and
 * expiries only copy the next pre-generated Vector3 into a stable ten-slot source array, keeping
 * the gameplay frame allocation-free and making a seed reproduce the same sequence regardless
 * of when the player reaches each cell.
 */
export class RelayHarvestState {
  readonly path: FlightPath;
  readonly seed: number;
  readonly relayPosition: THREE.Vector3;
  readonly sources: readonly RelayHarvestSourceState[];

  phase: RelayHarvestPhase = 'collecting';
  collected = 0;
  returnStartedAt: number | null = null;
  relayWindow: number | null = null;
  relayDeadline: number | null = null;
  extracted = false;
  failureReason: string | null = null;

  private readonly queue: THREE.Vector3[] = [];
  private queueIndex = 0;
  private nextId = 0;

  private readonly scratchPoint = new THREE.Vector3();
  private readonly scratchTangent = new THREE.Vector3();
  private readonly scratchLateralA = new THREE.Vector3();
  private readonly scratchLateralB = new THREE.Vector3();
  private readonly scratchCandidate = new THREE.Vector3();

  constructor(path: FlightPath, seed: number, rocks: readonly AsteroidInstance[]) {
    this.path = path;
    this.seed = Number.isFinite(seed) ? seed >>> 0 : 0;
    this.relayPosition = path.startPosition.clone();

    // Keep this stream independent from both path and asteroid generation consumption.
    const rng = new Rng(this.seed).fork(0x9c17_5eed);
    for (let index = 0; index < RELAY_HARVEST_PREGENERATED_POSITION_COUNT; index++) {
      this.queue.push(this.generatePosition(rng, rocks));
    }

    this.sources = Object.freeze(Array.from(
      { length: RELAY_HARVEST_ACTIVE_SOURCE_COUNT },
      (_, index): RelayHarvestSourceState => ({
        index,
        position: new THREE.Vector3(),
        id: 0,
        generation: -1,
        phase: 0,
        charge: 0,
        alive: false,
        spawnedAt: 0,
        expiresAt: null,
        collected: false,
        collectedAt: null,
      }),
    ));
    this.reset();
  }

  /** Compatibility percentage for shared collection result/UI contracts. */
  get charge(): number {
    return this.collected * RELAY_HARVEST_CHARGE_PER_SOURCE;
  }

  reset(): void {
    this.phase = 'collecting';
    this.collected = 0;
    this.returnStartedAt = null;
    this.relayWindow = null;
    this.relayDeadline = null;
    this.extracted = false;
    this.failureReason = null;
    this.queueIndex = 0;
    this.nextId = 0;

    for (const source of this.sources) {
      source.id = 0;
      source.generation = -1;
      this.respawn(source, 0);
      // A stagger avoids a synchronized field-wide discharge without making layout random.
      source.charge = 1 - (source.index / this.sources.length) * 0.55;
      source.expiresAt = source.charge * RELAY_HARVEST_CELL_LIFETIME;
    }
  }

  /**
   * Discharges cells before pickup collision is evaluated for the frame.
   * A replacement is immediate, so collecting always presents ten live choices until quota.
   */
  advanceDecay(elapsed: number, dt: number): number {
    if (this.phase !== 'collecting') return 0;
    const now = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    let expired = 0;
    for (const source of this.sources) {
      if (!source.alive) continue;
      source.charge -= step / RELAY_HARVEST_CELL_LIFETIME;
      if (source.charge > 0) {
        source.expiresAt = now + source.charge * RELAY_HARVEST_CELL_LIFETIME;
        continue;
      }
      source.alive = false;
      source.charge = 0;
      source.expiresAt = null;
      source.collected = true;
      this.respawn(source, now);
      expired++;
    }
    return expired;
  }

  collect(sourceIndex: number, elapsed: number): RelayHarvestPickup | null {
    if (this.phase !== 'collecting') return null;
    const source = this.sources[sourceIndex];
    if (!source?.alive) return null;
    const collectedAt = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    const cellId = source.id;

    source.alive = false;
    source.charge = 0;
    source.expiresAt = null;
    source.collected = true;
    source.collectedAt = collectedAt;
    this.collected++;
    const quotaMet = this.collected >= RELAY_HARVEST_REQUIRED_SOURCE_COUNT;

    if (!quotaMet) this.respawn(source, collectedAt);

    return {
      sourceIndex,
      cellId,
      collectedAt,
      collected: this.collected,
      quotaMet,
    };
  }

  beginReturn(elapsed: number, distance: number, cruiseSpeed: number): void {
    if (this.phase === 'returning') return;
    const startedAt = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    const safeDistance = Number.isFinite(distance) ? Math.max(0, distance) : 0;
    const safeCruise = Number.isFinite(cruiseSpeed) ? Math.max(1, cruiseSpeed) : 1;
    const window = Math.max(
      RELAY_HARVEST_RETURN_MINIMUM_SECONDS,
      safeDistance / (safeCruise * RELAY_HARVEST_RETURN_PACE),
    );

    this.phase = 'returning';
    this.returnStartedAt = startedAt;
    this.relayWindow = window;
    this.relayDeadline = startedAt + window;
    // The quota pickup powers the entire field down, including the nine uncollected slots.
    for (const source of this.sources) {
      source.alive = false;
      source.charge = 0;
      source.expiresAt = null;
      source.collected = true;
    }
  }

  activeCount(): number {
    let count = 0;
    for (const source of this.sources) if (source.alive) count++;
    return count;
  }

  nearestSource(from: THREE.Vector3): RelayHarvestSourceState | null {
    let nearest: RelayHarvestSourceState | null = null;
    let nearestDistanceSq = Infinity;
    for (const source of this.sources) {
      if (!source.alive) continue;
      const distanceSq = source.position.distanceToSquared(from);
      if (distanceSq < nearestDistanceSq
        || (distanceSq === nearestDistanceSq && source.id < (nearest?.id ?? Infinity))) {
        nearest = source;
        nearestDistanceSq = distanceSq;
      }
    }
    return nearest;
  }

  relayRemaining(elapsed: number): number | null {
    if (this.relayDeadline === null) return null;
    const now = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    return Math.max(0, this.relayDeadline - now);
  }

  markExtracted(): void {
    this.extracted = true;
    this.failureReason = null;
  }

  markFailed(reason: string): void {
    this.extracted = false;
    this.failureReason = reason;
  }

  debugSnapshot(): RelayHarvestStateDebug {
    return {
      seed: this.seed,
      phase: this.phase,
      collected: this.collected,
      charge: this.charge,
      active: this.activeCount(),
      queueIndex: this.queueIndex,
      relayWindow: this.relayWindow,
      relayDeadline: this.relayDeadline,
      sources: this.sources.map((source) => ({
        index: source.index,
        id: source.id,
        position: Object.freeze(source.position.toArray()) as readonly [number, number, number],
        generation: source.generation,
        phase: source.phase,
        charge: source.charge,
        alive: source.alive,
        spawnedAt: source.spawnedAt,
        expiresAt: source.expiresAt,
      })),
    };
  }

  private respawn(source: RelayHarvestSourceState, elapsed: number): void {
    source.position.copy(this.queue[this.queueIndex % this.queue.length]!);
    this.queueIndex++;
    source.phase = (source.id * 2.399963) % (Math.PI * 2);
    source.id = ++this.nextId;
    source.generation++;
    source.charge = 1;
    source.alive = true;
    source.spawnedAt = elapsed;
    source.expiresAt = elapsed + RELAY_HARVEST_CELL_LIFETIME;
    source.collected = false;
    source.collectedAt = null;
  }

  /** Generates one position just outside the path's protected debris-free channel. */
  private generatePosition(rng: Rng, rocks: readonly AsteroidInstance[]): THREE.Vector3 {
    let best = new THREE.Vector3();
    let bestClearance = -Infinity;

    for (let attempt = 0; attempt < RELAY_HARVEST_PLACEMENT_ATTEMPTS; attempt++) {
      const t = rng.range(RELAY_HARVEST_MIN_PATH_FRACTION, RELAY_HARVEST_MAX_PATH_FRACTION);
      this.path.curve.getPointAt(t, this.scratchPoint);
      this.path.curve.getTangentAt(t, this.scratchTangent).normalize();

      this.scratchLateralA.set(0, 1, 0);
      if (Math.abs(this.scratchLateralA.dot(this.scratchTangent)) > 0.9) {
        this.scratchLateralA.set(1, 0, 0);
      }
      this.scratchLateralB.crossVectors(this.scratchTangent, this.scratchLateralA).normalize();
      this.scratchLateralA.crossVectors(this.scratchLateralB, this.scratchTangent).normalize();

      const channel = this.channelRadiusAt(this.scratchPoint);
      const radius = channel * rng.range(
        RELAY_HARVEST_MIN_CHANNEL_MULTIPLIER,
        RELAY_HARVEST_MAX_CHANNEL_MULTIPLIER,
      );
      const angle = rng.range(0, Math.PI * 2);
      this.scratchCandidate
        .copy(this.scratchPoint)
        .addScaledVector(this.scratchLateralA, Math.cos(angle) * radius)
        .addScaledVector(this.scratchLateralB, Math.sin(angle) * radius);

      const clearance = this.clearanceOf(this.scratchCandidate, rocks);
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = this.scratchCandidate.clone();
      }
      if (clearance >= RELAY_HARVEST_REQUIRED_ROCK_CLEARANCE) break;
    }

    return best;
  }

  private clearanceOf(point: THREE.Vector3, rocks: readonly AsteroidInstance[]): number {
    let worst = Infinity;
    for (const rock of rocks) {
      const gap = point.distanceTo(rock.position) - rock.radius;
      if (gap < worst) {
        worst = gap;
        if (worst < 0) return worst;
      }
    }
    for (const other of this.queue) {
      const gap = point.distanceTo(other);
      if (gap < RELAY_HARVEST_MIN_SOURCE_SEPARATION) {
        worst = Math.min(worst, gap - RELAY_HARVEST_MIN_SOURCE_SEPARATION);
      }
    }
    return worst;
  }

  private channelRadiusAt(point: THREE.Vector3): number {
    let bestRadius = 260;
    let bestDistance = Infinity;
    for (const segment of this.path.clearChannel) {
      const distance = distanceToSegment(point, segment.a, segment.b);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestRadius = segment.radius;
      }
    }
    return bestRadius;
  }
}
