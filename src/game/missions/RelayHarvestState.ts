import * as THREE from 'three';
import {
  RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
  RELAY_HARVEST_CHARGE_PER_SOURCE,
  RELAY_HARVEST_RETURN_MINIMUM_SECONDS,
  RELAY_HARVEST_RETURN_PACE,
  RELAY_HARVEST_SOCKETS,
  RELAY_HARVEST_SOURCE_LIFETIME_MAX,
  RELAY_HARVEST_SOURCE_LIFETIME_MIN,
  type RelayHarvestBand,
  type RelayHarvestLayout,
  type RelayHarvestSocketDefinition,
} from './RelayHarvestLayout.ts';

export type RelayHarvestPhase = 'collecting' | 'returning';

export interface RelayHarvestSourceState {
  readonly index: number;
  readonly id: string;
  readonly band: RelayHarvestBand;
  readonly homeSocket: RelayHarvestSocketDefinition;
  /** Current authored socket. The source identity and Vector3 identity never change. */
  socket: RelayHarvestSocketDefinition;
  readonly position: THREE.Vector3;
  generation: number;
  activatedAt: number;
  expiresAt: number | null;
  collected: boolean;
  collectedAt: number | null;
}

export interface RelayHarvestStateDebug {
  readonly layoutIndex: number;
  readonly layoutSignature: string;
  readonly phase: RelayHarvestPhase;
  readonly collected: number;
  readonly charge: number;
  readonly relayWindow: number | null;
  readonly relayDeadline: number | null;
  readonly sources: readonly {
    readonly id: string;
    readonly socketId: string;
    readonly position: readonly [number, number, number];
    readonly generation: number;
    readonly expiresAt: number | null;
    readonly collected: boolean;
    readonly collectedAt: number | null;
  }[];
}

/**
 * One fixed-capacity allocation shared by gameplay and rendering. Runtime expiry mutates ten
 * stable source records and their Vector3 values; it never constructs a mesh, array, or vector.
 */
export class RelayHarvestState {
  readonly layout: RelayHarvestLayout;
  readonly layoutIndex: number;
  readonly layoutSignature: string;
  readonly relayPosition: THREE.Vector3;
  /** All twelve launch-transformed authored sockets, used as stable world-clearance anchors. */
  readonly authoredPositions: readonly THREE.Vector3[];
  readonly sources: readonly RelayHarvestSourceState[];

  private readonly lifetimeOverride: number | null;

  phase: RelayHarvestPhase = 'collecting';
  collected = 0;
  charge = 0;
  returnStartedAt: number | null = null;
  relayWindow: number | null = null;
  relayDeadline: number | null = null;
  extracted = false;
  failureReason: string | null = null;

  constructor(
    layout: RelayHarvestLayout,
    launchPosition?: THREE.Vector3,
    launchOrientation?: THREE.Quaternion,
    sourceLifetimeSeconds?: number,
  ) {
    this.layout = layout;
    this.layoutIndex = layout.index;
    this.layoutSignature = layout.signature;
    const origin = launchPosition ?? new THREE.Vector3();
    const orientation = launchOrientation ?? new THREE.Quaternion();
    this.relayPosition = origin.clone();
    this.lifetimeOverride = Number.isFinite(sourceLifetimeSeconds)
      && (sourceLifetimeSeconds ?? 0) > 0
      ? sourceLifetimeSeconds!
      : null;
    this.authoredPositions = Object.freeze(RELAY_HARVEST_SOCKETS.map((socket) =>
      new THREE.Vector3(socket.right, socket.up, -socket.forward)
        .applyQuaternion(orientation)
        .add(origin)));
    this.sources = Object.freeze(layout.sockets.map((socket, index) => ({
      index,
      id: socket.id,
      band: socket.band,
      homeSocket: socket,
      socket,
      position: this.authoredPositions[socket.index]!.clone(),
      generation: 0,
      activatedAt: 0,
      expiresAt: this.sourceLifetime(index, 0),
      collected: false,
      collectedAt: null,
    })));
    if (this.sources.length !== RELAY_HARVEST_ACTIVE_SOURCE_COUNT) {
      throw new Error('BLACKOUT RELAY state requires exactly ten active sources');
    }
  }

  reset(): void {
    this.phase = 'collecting';
    this.collected = 0;
    this.charge = 0;
    this.returnStartedAt = null;
    this.relayWindow = null;
    this.relayDeadline = null;
    this.extracted = false;
    this.failureReason = null;
    for (const source of this.sources) {
      source.socket = source.homeSocket;
      source.position.copy(this.authoredPositions[source.homeSocket.index]!);
      source.generation = 0;
      source.activatedAt = 0;
      source.expiresAt = this.sourceLifetime(source.index, 0);
      source.collected = false;
      source.collectedAt = null;
    }
  }

  /** Relocates every expired live source, preserving source/vector/array identities. */
  relocateExpired(elapsed: number): number {
    if (this.phase !== 'collecting' || !Number.isFinite(elapsed)) return 0;
    const now = Math.max(0, elapsed);
    let relocated = 0;
    for (const source of this.sources) {
      while (!source.collected && source.expiresAt !== null && now >= source.expiresAt) {
        const activationTime = source.expiresAt;
        this.relocate(source);
        source.generation++;
        source.activatedAt = activationTime;
        source.expiresAt = activationTime + this.sourceLifetime(source.index, source.generation);
        relocated++;
      }
    }
    return relocated;
  }

  collect(sourceIndex: number, elapsed: number): RelayHarvestSourceState | null {
    if (this.phase !== 'collecting') return null;
    const source = this.sources[sourceIndex];
    if (!source || source.collected) return null;
    source.collected = true;
    source.collectedAt = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    source.expiresAt = null;
    this.collected++;
    this.charge += RELAY_HARVEST_CHARGE_PER_SOURCE;
    return source;
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
    // The remaining sources are no longer targets once the bank is full.
    for (const source of this.sources) {
      if (!source.collected) source.expiresAt = null;
    }
  }

  relayRemaining(elapsed: number): number | null {
    if (this.relayDeadline === null) return null;
    return Math.max(0, this.relayDeadline - Math.max(0, elapsed));
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
      layoutIndex: this.layoutIndex,
      layoutSignature: this.layoutSignature,
      phase: this.phase,
      collected: this.collected,
      charge: this.charge,
      relayWindow: this.relayWindow,
      relayDeadline: this.relayDeadline,
      sources: this.sources.map((source) => ({
        id: source.id,
        socketId: source.socket.id,
        position: Object.freeze(source.position.toArray()) as readonly [number, number, number],
        generation: source.generation,
        expiresAt: source.expiresAt,
        collected: source.collected,
        collectedAt: source.collectedAt,
      })),
    };
  }

  private sourceLifetime(sourceIndex: number, generation: number): number {
    if (this.lifetimeOverride !== null) return this.lifetimeOverride;
    const span = RELAY_HARVEST_SOURCE_LIFETIME_MAX - RELAY_HARVEST_SOURCE_LIFETIME_MIN + 1;
    let value = (this.layoutIndex + 1) ^ Math.imul(sourceIndex + 1, 0x9e37_79b9)
      ^ Math.imul(generation + 1, 0x85eb_ca6b);
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb_352d);
    value ^= value >>> 15;
    return RELAY_HARVEST_SOURCE_LIFETIME_MIN + ((value >>> 0) % span);
  }

  private relocate(source: RelayHarvestSourceState): void {
    // Five is coprime to twelve, so this probes every socket without an allocation or lookup table.
    const start = (source.socket.index + 1
      + ((this.layoutIndex + source.index * 3 + source.generation * 7) % 11)) % RELAY_HARVEST_SOCKETS.length;
    for (let attempt = 0; attempt < RELAY_HARVEST_SOCKETS.length; attempt++) {
      const socketIndex = (start + attempt * 5) % RELAY_HARVEST_SOCKETS.length;
      if (socketIndex === source.socket.index || this.socketOccupied(socketIndex, source.index)) continue;
      source.socket = RELAY_HARVEST_SOCKETS[socketIndex]!;
      source.position.copy(this.authoredPositions[socketIndex]!);
      return;
    }
    throw new Error(`BLACKOUT RELAY exhausted reserve sockets for ${source.id}`);
  }

  private socketOccupied(socketIndex: number, excludedSourceIndex: number): boolean {
    for (const source of this.sources) {
      if (source.index !== excludedSourceIndex && source.socket.index === socketIndex) return true;
    }
    return false;
  }
}
