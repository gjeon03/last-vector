import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import type { LightingUniforms } from './lighting.ts';
import {
  buildAsteroidGeometry,
  createAsteroidMaterial,
  type AsteroidGeometry,
} from './Asteroids.ts';

/** A hard gameplay and allocation ceiling. Difficulty must never grow this population. */
export const METEOR_POOL_CAPACITY = 128;
/** Eight silhouettes keep repetition low while holding the field to eight draw calls. */
export const METEOR_VARIANT_COUNT = 8;

interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface QuaternionLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface MeteorSpawnParams {
  position: Vector3Like;
  velocity: Vector3Like;
  /** Collision sphere radius in world metres. */
  radius: number;
  /** Procedural silhouette selected by the deterministic spawn scheduler. */
  geometryVariant: number;
  /** Stable scheduler identity used for debugging and deterministic replays. */
  spawnId?: number;
  quaternion?: QuaternionLike;
  spinAxis?: Vector3Like;
  spinRate?: number;
}

/**
 * Stable, construction-time contact record. The object and all of its vectors are reused each
 * time its slot is spawned, so collision code can inspect a dense active prefix without making
 * garbage. `generation` changes whenever the slot is reused.
 */
export interface MeteorContact {
  readonly slot: number;
  generation: number;
  active: boolean;
  spawnId: number;
  geometryVariant: number;
  radius: number;
  readonly previousPosition: THREE.Vector3;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
}

interface MeteorSlot extends MeteorContact {
  denseIndex: number;
  matrixIndex: number;
  scale: number;
  spinRate: number;
  readonly quaternion: THREE.Quaternion;
  readonly spinAxis: THREE.Vector3;
  readonly defaultQuaternion: THREE.Quaternion;
  readonly defaultSpinAxis: THREE.Vector3;
  readonly defaultSpinRate: number;
  readonly tint: THREE.Color;
}

interface MeteorBatch {
  readonly mesh: THREE.InstancedMesh;
  /** Logical slot at each live GPU instance index. Only [0, count) is valid. */
  readonly slots: Int16Array;
  readonly trianglesPerInstance: number;
  count: number;
}

export interface MeteorFieldOptions {
  lighting: LightingUniforms;
  /** Controls geometry, slot orientation, spin and tint. The same seed resets identically. */
  seed?: number;
}

export interface MeteorFieldDebugStats {
  capacity: number;
  activeCount: number;
  freeCount: number;
  peakActive: number;
  batchCount: number;
  activeBatchCount: number;
  geometryCount: number;
  materialCount: number;
  allocatedGpuInstances: number;
  estimatedTriangles: number;
  totalSpawned: number;
  totalDespawned: number;
}

/**
 * Fixed-size dynamic rock field for the survival mode.
 *
 * Logical slots are independent from render batches. Every batch allocates room for the full
 * logical cap, so an authored wave may choose one silhouette for all 128 meteors without being
 * rejected by an artificial per-variant quota. The active population is still globally capped
 * at 128. Both the global contact list and every render batch use dense live prefixes with swap
 * removal; no arrays, vectors, matrices or render resources are created by spawn/update/despawn.
 */
export class MeteorField {
  readonly object = new THREE.Group();
  readonly capacity = METEOR_POOL_CAPACITY;
  readonly variantCount = METEOR_VARIANT_COUNT;

  private readonly material: THREE.ShaderMaterial;
  private readonly geometries: AsteroidGeometry[] = [];
  private readonly batches: MeteorBatch[] = [];
  private readonly slots: MeteorSlot[] = [];
  private readonly activeSlots = new Int16Array(METEOR_POOL_CAPACITY);
  private readonly freeSlots = new Int16Array(METEOR_POOL_CAPACITY);
  private readonly matrixScratch = new THREE.Matrix4();
  private readonly scaleScratch = new THREE.Vector3();
  private readonly spinScratch = new THREE.Quaternion();
  private activeLength = 0;
  private freeLength = 0;
  private totalSpawned = 0;
  private totalDespawned = 0;
  private peakActive = 0;
  private disposed = false;

  constructor(options: MeteorFieldOptions) {
    const seed = options.seed ?? 0x4d455445;
    const geometryRng = new Rng(seed ^ 0x91e10da5);
    const slotRng = new Rng(seed ^ 0x7f4a7c15);

    this.object.name = 'survival-meteor-field';
    this.material = createAsteroidMaterial(options.lighting);

    // Detail 3 is 320 triangles per silhouette: 128 live rocks stay at 40,960 triangles.
    for (let variant = 0; variant < METEOR_VARIANT_COUNT; variant++) {
      const shape = buildAsteroidGeometry(geometryRng.fork(variant), 3);
      this.geometries.push(shape);

      const mesh = new THREE.InstancedMesh(shape.geometry, this.material, METEOR_POOL_CAPACITY);
      mesh.name = `survival-meteors-${variant}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      // Force instanceColor allocation during construction rather than on the first live spawn.
      const neutral = new THREE.Color(1, 1, 1);
      for (let i = 0; i < METEOR_POOL_CAPACITY; i++) mesh.setColorAt(i, neutral);
      mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      const index = shape.geometry.index;
      const trianglesPerInstance = index
        ? Math.floor(index.count / 3)
        : Math.floor((shape.geometry.getAttribute('position')?.count ?? 0) / 3);
      this.batches.push({
        mesh,
        slots: new Int16Array(METEOR_POOL_CAPACITY),
        trianglesPerInstance,
        count: 0,
      });
      this.object.add(mesh);
    }

    const direction = new THREE.Vector3();
    const orientationAxis = new THREE.Vector3();
    for (let slotIndex = 0; slotIndex < METEOR_POOL_CAPACITY; slotIndex++) {
      slotRng.onSphere(direction);
      slotRng.onSphere(orientationAxis);
      const defaultSpinAxis = direction.clone().normalize();
      const defaultQuaternion = new THREE.Quaternion().setFromAxisAngle(
        orientationAxis.normalize(),
        slotRng.range(0, Math.PI * 2),
      );
      const value = slotRng.range(0.64, 1.08);
      const tint = new THREE.Color().setRGB(
        value,
        value * slotRng.range(0.97, 1.015),
        value * slotRng.range(0.94, 1.015),
        THREE.LinearSRGBColorSpace,
      );

      const defaultSpinRate = slotRng.signed(0.55);
      this.slots.push({
        slot: slotIndex,
        generation: 0,
        active: false,
        spawnId: -1,
        geometryVariant: 0,
        radius: 0,
        previousPosition: new THREE.Vector3(),
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        denseIndex: -1,
        matrixIndex: -1,
        scale: 0,
        spinRate: defaultSpinRate,
        quaternion: defaultQuaternion.clone(),
        spinAxis: defaultSpinAxis.clone(),
        defaultQuaternion,
        defaultSpinAxis,
        defaultSpinRate,
        tint,
      });
    }

    this.reset();
  }

  get activeCount(): number {
    return this.activeLength;
  }

  get freeCount(): number {
    return this.freeLength;
  }

  /** Returns a stable contact object from the dense active prefix, or null outside it. */
  getActiveContact(denseIndex: number): MeteorContact | null {
    if (!Number.isInteger(denseIndex) || denseIndex < 0 || denseIndex >= this.activeLength) return null;
    return this.slots[this.activeSlots[denseIndex]];
  }

  /** Returns a stable physical slot for deterministic harness checks. */
  getContactBySlot(slotIndex: number): MeteorContact | null {
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= METEOR_POOL_CAPACITY) return null;
    return this.slots[slotIndex];
  }

  /**
   * Activates one preallocated slot. Returns null at the hard cap; it never expands the pool.
   * The returned object is stable but may later represent another generation after recycling.
   */
  spawn(params: MeteorSpawnParams): MeteorContact | null {
    if (this.disposed || this.freeLength === 0) return null;
    if (!Number.isFinite(params.radius) || params.radius <= 0) return null;
    if (!this.isFiniteVector(params.position) || !this.isFiniteVector(params.velocity)) return null;

    const variant = this.wrapVariant(params.geometryVariant);
    const slotIndex = this.freeSlots[--this.freeLength];
    const slot = this.slots[slotIndex];
    const batch = this.batches[variant];

    slot.generation = (slot.generation + 1) >>> 0;
    if (slot.generation === 0) slot.generation = 1;
    slot.active = true;
    slot.spawnId = params.spawnId ?? -1;
    slot.geometryVariant = variant;
    slot.radius = params.radius;
    slot.previousPosition.set(params.position.x, params.position.y, params.position.z);
    slot.position.copy(slot.previousPosition);
    slot.velocity.set(params.velocity.x, params.velocity.y, params.velocity.z);
    slot.scale = params.radius / this.geometries[variant].boundRadius;

    const q = params.quaternion;
    if (q && Number.isFinite(q.x) && Number.isFinite(q.y)
      && Number.isFinite(q.z) && Number.isFinite(q.w)) {
      slot.quaternion.set(q.x, q.y, q.z, q.w).normalize();
    } else {
      slot.quaternion.copy(slot.defaultQuaternion);
    }

    const axis = params.spinAxis;
    if (axis && this.isFiniteVector(axis)) {
      slot.spinAxis.set(axis.x, axis.y, axis.z);
      if (slot.spinAxis.lengthSq() > 1e-10) slot.spinAxis.normalize();
      else slot.spinAxis.copy(slot.defaultSpinAxis);
    } else {
      slot.spinAxis.copy(slot.defaultSpinAxis);
    }
    slot.spinRate = Number.isFinite(params.spinRate) ? params.spinRate as number : slot.defaultSpinRate;

    slot.denseIndex = this.activeLength;
    this.activeSlots[this.activeLength++] = slotIndex;
    slot.matrixIndex = batch.count;
    batch.slots[batch.count++] = slotIndex;
    batch.mesh.count = batch.count;
    this.writeSlot(batch, slot);
    batch.mesh.instanceMatrix.needsUpdate = true;
    if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;

    this.totalSpawned++;
    this.peakActive = Math.max(this.peakActive, this.activeLength);
    return slot;
  }

  /** Swap-removes a live slot from both dense prefixes and returns it to the fixed free stack. */
  despawn(contactOrSlot: MeteorContact | number): boolean {
    const slotIndex = typeof contactOrSlot === 'number' ? contactOrSlot : contactOrSlot.slot;
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= METEOR_POOL_CAPACITY) return false;
    const slot = this.slots[slotIndex];
    if (typeof contactOrSlot !== 'number' && contactOrSlot !== slot) return false;
    if (!slot.active) return false;

    const lastDenseIndex = --this.activeLength;
    const movedDenseSlotIndex = this.activeSlots[lastDenseIndex];
    if (slot.denseIndex !== lastDenseIndex) {
      this.activeSlots[slot.denseIndex] = movedDenseSlotIndex;
      this.slots[movedDenseSlotIndex].denseIndex = slot.denseIndex;
    }

    const batch = this.batches[slot.geometryVariant];
    const lastMatrixIndex = --batch.count;
    const movedMatrixSlotIndex = batch.slots[lastMatrixIndex];
    if (slot.matrixIndex !== lastMatrixIndex) {
      batch.slots[slot.matrixIndex] = movedMatrixSlotIndex;
      const movedSlot = this.slots[movedMatrixSlotIndex];
      movedSlot.matrixIndex = slot.matrixIndex;
      this.writeSlot(batch, movedSlot);
      batch.mesh.instanceMatrix.needsUpdate = true;
      if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
    }
    batch.mesh.count = batch.count;

    slot.active = false;
    slot.spawnId = -1;
    slot.denseIndex = -1;
    slot.matrixIndex = -1;
    this.freeSlots[this.freeLength++] = slotIndex;
    this.totalDespawned++;
    return true;
  }

  /**
   * Advances all live meteors and refreshes their instance matrices. Runtime work is bounded by
   * 128 and uses only construction-time scratch values and slot records.
   */
  update(dt: number, cameraPosition: Vector3Like): void {
    if (this.disposed) return;
    this.material.uniforms.uCameraPos.value.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;

    for (let i = 0; i < this.activeLength; i++) {
      const slot = this.slots[this.activeSlots[i]];
      slot.previousPosition.copy(slot.position);
      slot.position.addScaledVector(slot.velocity, step);
      if (slot.spinRate !== 0 && step !== 0) {
        this.spinScratch.setFromAxisAngle(slot.spinAxis, slot.spinRate * step);
        slot.quaternion.multiply(this.spinScratch).normalize();
      }
      this.writeMatrix(this.batches[slot.geometryVariant], slot);
    }

    for (let i = 0; i < this.batches.length; i++) {
      const batch = this.batches[i];
      if (batch.count > 0) batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Swept sphere test in relative motion space. Supplying the ship's previous and current
   * centres catches tunnelling by either a high-speed meteor or a high-speed player.
   */
  intersectsSweptSphere(
    contact: MeteorContact,
    spherePrevious: Vector3Like,
    sphereCurrent: Vector3Like,
    sphereRadius: number,
  ): boolean {
    return this.sweptSphereHitTime(
      contact,
      spherePrevious,
      sphereCurrent,
      sphereRadius,
    ) >= 0;
  }

  /**
   * Returns the first relative-motion contact time in the closed frame interval [0, 1], or -1.
   * Keeping this scalar lets gameplay reconstruct the impact point and normal without allocating
   * a hit record, and avoids deriving a backwards normal from a fast meteor's end-of-frame pose.
   */
  sweptSphereHitTime(
    contact: MeteorContact,
    spherePrevious: Vector3Like,
    sphereCurrent: Vector3Like,
    sphereRadius: number,
  ): number {
    if (!contact.active || !Number.isFinite(sphereRadius) || sphereRadius < 0) return -1;

    const startX = contact.previousPosition.x - spherePrevious.x;
    const startY = contact.previousPosition.y - spherePrevious.y;
    const startZ = contact.previousPosition.z - spherePrevious.z;
    const deltaX = (contact.position.x - contact.previousPosition.x)
      - (sphereCurrent.x - spherePrevious.x);
    const deltaY = (contact.position.y - contact.previousPosition.y)
      - (sphereCurrent.y - spherePrevious.y);
    const deltaZ = (contact.position.z - contact.previousPosition.z)
      - (sphereCurrent.z - spherePrevious.z);
    const combinedRadius = contact.radius + sphereRadius;
    const c = startX * startX + startY * startY + startZ * startZ
      - combinedRadius * combinedRadius;
    if (c <= 0) return 0;

    const deltaLengthSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    if (deltaLengthSq <= 1e-12) return -1;

    const halfB = startX * deltaX + startY * deltaY + startZ * deltaZ;
    const discriminant = halfB * halfB - deltaLengthSq * c;
    if (discriminant < 0) return -1;
    const first = (-halfB - Math.sqrt(discriminant)) / deltaLengthSq;
    return first >= 0 && first <= 1 ? first : -1;
  }

  /** Restores deterministic slot order, generations, counters and empty render prefixes. */
  reset(): void {
    this.activeLength = 0;
    this.freeLength = METEOR_POOL_CAPACITY;
    this.totalSpawned = 0;
    this.totalDespawned = 0;
    this.peakActive = 0;

    for (let i = 0; i < METEOR_POOL_CAPACITY; i++) {
      // Reversed stack makes the first spawn slot 0, then 1, and so on.
      this.freeSlots[i] = METEOR_POOL_CAPACITY - 1 - i;
      const slot = this.slots[i];
      slot.generation = 0;
      slot.active = false;
      slot.spawnId = -1;
      slot.geometryVariant = 0;
      slot.radius = 0;
      slot.previousPosition.set(0, 0, 0);
      slot.position.set(0, 0, 0);
      slot.velocity.set(0, 0, 0);
      slot.denseIndex = -1;
      slot.matrixIndex = -1;
      slot.scale = 0;
      slot.quaternion.copy(slot.defaultQuaternion);
      slot.spinAxis.copy(slot.defaultSpinAxis);
      slot.spinRate = slot.defaultSpinRate;
    }
    for (let i = 0; i < this.batches.length; i++) {
      this.batches[i].count = 0;
      this.batches[i].mesh.count = 0;
    }
  }

  /** Explicit diagnostics may allocate only when the caller omits its reusable output object. */
  getDebugStats(out?: MeteorFieldDebugStats): MeteorFieldDebugStats {
    const report = out ?? {
      capacity: 0,
      activeCount: 0,
      freeCount: 0,
      peakActive: 0,
      batchCount: 0,
      activeBatchCount: 0,
      geometryCount: 0,
      materialCount: 0,
      allocatedGpuInstances: 0,
      estimatedTriangles: 0,
      totalSpawned: 0,
      totalDespawned: 0,
    };
    let activeBatchCount = 0;
    let estimatedTriangles = 0;
    for (let i = 0; i < this.batches.length; i++) {
      const batch = this.batches[i];
      if (batch.count > 0) activeBatchCount++;
      estimatedTriangles += batch.count * batch.trianglesPerInstance;
    }
    report.capacity = METEOR_POOL_CAPACITY;
    report.activeCount = this.activeLength;
    report.freeCount = this.freeLength;
    report.peakActive = this.peakActive;
    report.batchCount = this.batches.length;
    report.activeBatchCount = activeBatchCount;
    report.geometryCount = this.geometries.length;
    report.materialCount = 1;
    report.allocatedGpuInstances = this.batches.length * METEOR_POOL_CAPACITY;
    report.estimatedTriangles = estimatedTriangles;
    report.totalSpawned = this.totalSpawned;
    report.totalDespawned = this.totalDespawned;
    return report;
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    for (let i = 0; i < this.batches.length; i++) this.batches[i].mesh.dispose();
    for (let i = 0; i < this.geometries.length; i++) this.geometries[i].geometry.dispose();
    this.material.dispose();
    this.object.clear();
  }

  private writeSlot(batch: MeteorBatch, slot: MeteorSlot): void {
    this.writeMatrix(batch, slot);
    batch.mesh.setColorAt(slot.matrixIndex, slot.tint);
  }

  private writeMatrix(batch: MeteorBatch, slot: MeteorSlot): void {
    this.matrixScratch.compose(
      slot.position,
      slot.quaternion,
      this.scaleScratch.setScalar(slot.scale),
    );
    batch.mesh.setMatrixAt(slot.matrixIndex, this.matrixScratch);
  }

  private wrapVariant(value: number): number {
    const integer = Number.isFinite(value) ? Math.trunc(value) : 0;
    return ((integer % METEOR_VARIANT_COUNT) + METEOR_VARIANT_COUNT) % METEOR_VARIANT_COUNT;
  }

  private isFiniteVector(value: Vector3Like): boolean {
    return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
  }
}
