import * as THREE from 'three';
import {
  RELAY_HARVEST_ACTIVE_SOURCE_COUNT,
  RELAY_HARVEST_CHARGE_PER_SOURCE,
  type RelayHarvestBand,
  type RelayHarvestLayout,
  type RelayHarvestSocketDefinition,
} from './RelayHarvestLayout.ts';

export interface RelayHarvestSourceState {
  readonly index: number;
  readonly id: string;
  readonly band: RelayHarvestBand;
  readonly socket: RelayHarvestSocketDefinition;
  /** Stable Vector3 identity shared by objective and renderer. */
  readonly position: THREE.Vector3;
  collected: boolean;
  collectedAt: number | null;
}

export interface RelayHarvestStateDebug {
  readonly layoutIndex: number;
  readonly layoutSignature: string;
  readonly collected: number;
  readonly charge: number;
  readonly sources: readonly {
    readonly id: string;
    readonly position: readonly [number, number, number];
    readonly collected: boolean;
    readonly collectedAt: number | null;
  }[];
}

/**
 * One fixed-capacity state allocation shared by gameplay and rendering. Reset mutates collection
 * facts only: source IDs, positions, array identity and layout identity remain unchanged.
 */
export class RelayHarvestState {
  readonly layout: RelayHarvestLayout;
  readonly layoutIndex: number;
  readonly layoutSignature: string;
  readonly sources: readonly RelayHarvestSourceState[];
  collected = 0;
  charge = 0;

  constructor(
    layout: RelayHarvestLayout,
    launchPosition?: THREE.Vector3,
    launchOrientation?: THREE.Quaternion,
  ) {
    this.layout = layout;
    this.layoutIndex = layout.index;
    this.layoutSignature = layout.signature;
    const origin = launchPosition ?? new THREE.Vector3();
    const orientation = launchOrientation ?? new THREE.Quaternion();
    this.sources = Object.freeze(layout.sockets.map((socket, index) => ({
      index,
      id: socket.id,
      band: socket.band,
      socket,
      position: new THREE.Vector3(socket.right, socket.up, -socket.forward)
        .applyQuaternion(orientation)
        .add(origin),
      collected: false,
      collectedAt: null,
    })));
    if (this.sources.length !== RELAY_HARVEST_ACTIVE_SOURCE_COUNT) {
      throw new Error('BLACKOUT RELAY state requires exactly five active sources');
    }
  }

  reset(): void {
    this.collected = 0;
    this.charge = 0;
    for (const source of this.sources) {
      source.collected = false;
      source.collectedAt = null;
    }
  }

  collect(sourceIndex: number, elapsed: number): RelayHarvestSourceState | null {
    const source = this.sources[sourceIndex];
    if (!source || source.collected) return null;
    source.collected = true;
    source.collectedAt = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    this.collected++;
    this.charge += RELAY_HARVEST_CHARGE_PER_SOURCE;
    return source;
  }

  debugSnapshot(): RelayHarvestStateDebug {
    return {
      layoutIndex: this.layoutIndex,
      layoutSignature: this.layoutSignature,
      collected: this.collected,
      charge: this.charge,
      sources: this.sources.map((source) => ({
        id: source.id,
        position: Object.freeze(source.position.toArray()) as readonly [number, number, number],
        collected: source.collected,
        collectedAt: source.collectedAt,
      })),
    };
  }
}
