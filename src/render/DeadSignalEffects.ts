import * as THREE from 'three';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const UNIT_Z = new THREE.Vector3(0, 0, 1);

interface TracerSlot {
  ttl: number;
  readonly matrix: THREE.Matrix4;
}

interface ExplosionSlot {
  ttl: number;
  duration: number;
  radius: number;
  readonly position: THREE.Vector3;
  readonly matrix: THREE.Matrix4;
}

/** One fixed 48-instance tracer draw plus one fixed eight-instance explosion draw. */
export class DeadSignalEffects {
  readonly object = new THREE.Group();
  readonly tracerCapacity = 48;
  readonly explosionCapacity = 8;

  private readonly tracerGeometry = new THREE.BoxGeometry(0.7, 0.7, 1);
  private readonly tracerMaterial = new THREE.MeshBasicMaterial({
    color: 0xa8f7ff,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  private readonly tracers = new THREE.InstancedMesh(
    this.tracerGeometry,
    this.tracerMaterial,
    this.tracerCapacity,
  );
  private readonly explosionGeometry = new THREE.IcosahedronGeometry(1, 2);
  private readonly explosionMaterial = new THREE.MeshBasicMaterial({
    color: 0xff6840,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });
  private readonly explosions = new THREE.InstancedMesh(
    this.explosionGeometry,
    this.explosionMaterial,
    this.explosionCapacity,
  );
  private readonly tracerSlots: TracerSlot[] = [];
  private readonly explosionSlots: ExplosionSlot[] = [];
  private readonly direction = new THREE.Vector3();
  private readonly midpoint = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private nextTracer = 0;
  private nextExplosion = 0;

  constructor() {
    this.object.name = 'DEAD SIGNAL / POOLED WEAPON EFFECTS';
    this.tracers.name = 'DEAD SIGNAL / TRACERS 48';
    this.explosions.name = 'DEAD SIGNAL / EXPLOSIONS 8';
    this.tracers.frustumCulled = false;
    this.explosions.frustumCulled = false;
    for (let index = 0; index < this.tracerCapacity; index++) {
      this.tracerSlots.push({ ttl: 0, matrix: new THREE.Matrix4() });
      this.tracers.setMatrixAt(index, ZERO);
    }
    const cool = new THREE.Color(0xffa05d);
    const hot = new THREE.Color(0xff3f2a);
    for (let index = 0; index < this.explosionCapacity; index++) {
      this.explosionSlots.push({
        ttl: 0,
        duration: 0.6,
        radius: 1,
        position: new THREE.Vector3(),
        matrix: new THREE.Matrix4(),
      });
      this.explosions.setMatrixAt(index, ZERO);
      this.explosions.setColorAt(index, index % 2 === 0 ? hot : cool);
    }
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.explosions.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.instanceMatrix.needsUpdate = true;
    this.explosions.instanceMatrix.needsUpdate = true;
    if (this.explosions.instanceColor) this.explosions.instanceColor.needsUpdate = true;
    this.object.add(this.tracers, this.explosions);
  }

  reset(): void {
    for (let index = 0; index < this.tracerSlots.length; index++) {
      this.tracerSlots[index]!.ttl = 0;
      this.tracers.setMatrixAt(index, ZERO);
    }
    for (let index = 0; index < this.explosionSlots.length; index++) {
      this.explosionSlots[index]!.ttl = 0;
      this.explosions.setMatrixAt(index, ZERO);
    }
    this.tracers.instanceMatrix.needsUpdate = true;
    this.explosions.instanceMatrix.needsUpdate = true;
    this.nextTracer = 0;
    this.nextExplosion = 0;
  }

  spawnTracer(origin: THREE.Vector3, end: THREE.Vector3): void {
    const index = this.nextTracer;
    this.nextTracer = (index + 1) % this.tracerCapacity;
    const slot = this.tracerSlots[index]!;
    this.direction.copy(end).sub(origin);
    const length = Math.max(1, this.direction.length());
    this.direction.divideScalar(length);
    this.midpoint.copy(origin).lerp(end, 0.5);
    this.quaternion.setFromUnitVectors(UNIT_Z, this.direction);
    this.scale.set(1, 1, length);
    slot.matrix.compose(this.midpoint, this.quaternion, this.scale);
    slot.ttl = 0.075;
    this.tracers.setMatrixAt(index, slot.matrix);
    this.tracers.instanceMatrix.needsUpdate = true;
  }

  spawnExplosion(position: THREE.Vector3, radius: number): void {
    const index = this.nextExplosion;
    this.nextExplosion = (index + 1) % this.explosionCapacity;
    const slot = this.explosionSlots[index]!;
    slot.position.copy(position);
    slot.radius = radius;
    slot.duration = 0.58;
    slot.ttl = slot.duration;
  }

  update(dt: number): void {
    let tracerDirty = false;
    for (let index = 0; index < this.tracerSlots.length; index++) {
      const slot = this.tracerSlots[index]!;
      if (slot.ttl <= 0) continue;
      slot.ttl -= dt;
      if (slot.ttl <= 0) {
        this.tracers.setMatrixAt(index, ZERO);
        tracerDirty = true;
      }
    }
    if (tracerDirty) this.tracers.instanceMatrix.needsUpdate = true;

    let explosionDirty = false;
    for (let index = 0; index < this.explosionSlots.length; index++) {
      const slot = this.explosionSlots[index]!;
      if (slot.ttl <= 0) continue;
      slot.ttl -= dt;
      if (slot.ttl <= 0) {
        this.explosions.setMatrixAt(index, ZERO);
      } else {
        const phase = 1 - slot.ttl / slot.duration;
        const pulse = slot.radius * (0.35 + phase * 1.65);
        this.scale.setScalar(pulse);
        slot.matrix.compose(slot.position, this.quaternion.identity(), this.scale);
        this.explosions.setMatrixAt(index, slot.matrix);
      }
      explosionDirty = true;
    }
    if (explosionDirty) this.explosions.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.tracerGeometry.dispose();
    this.tracerMaterial.dispose();
    this.explosionGeometry.dispose();
    this.explosionMaterial.dispose();
  }
}

