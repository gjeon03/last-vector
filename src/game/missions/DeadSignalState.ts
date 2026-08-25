import * as THREE from 'three';
import type { FlightPath } from '../FlightPath.ts';
import type {
  DeadSignalStrikeDefinition,
  DeadSignalTargetDefinition,
  DeadSignalTargetKind,
} from './DeadSignalMission.ts';

export interface DeadSignalTargetState {
  readonly definition: DeadSignalTargetDefinition;
  readonly id: string;
  readonly kind: DeadSignalTargetKind;
  readonly position: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly up: THREE.Vector3;
  hitPoints: number;
  destroyed: boolean;
  damageStage: 0 | 1 | 2 | 3;
  destroyedAt: number | null;
}
export interface DeadSignalDamageOutcome {
  readonly hit: boolean;
  readonly destroyed: boolean;
  readonly target: DeadSignalTargetState;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Fixed target state shared by objective, world representation, and the bounded hitscan owner. */
export class DeadSignalState {
  readonly targets: readonly DeadSignalTargetState[];
  shotsFired = 0;
  shotsHit = 0;

  private readonly shieldTargets: readonly DeadSignalTargetState[];
  private readonly coreTarget: DeadSignalTargetState;
  private readonly calibrationTarget: DeadSignalTargetState;

  constructor(
    path: FlightPath,
    definition: DeadSignalStrikeDefinition,
  ) {
    if (definition.targets.length > 16) {
      throw new Error('DEAD SIGNAL exceeds the 16-targetable ceiling');
    }
    const quaternion = new THREE.Quaternion();
    const base = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.targets = Object.freeze(definition.targets.map((target) => {
      path.poseAt(target.pathT, base, quaternion);
      forward.set(0, 0, -1).applyQuaternion(quaternion).normalize();
      right.crossVectors(forward, WORLD_UP);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      else right.normalize();
      up.crossVectors(right, forward).normalize();
      const position = base.clone()
        .addScaledVector(right, target.rightOffset)
        .addScaledVector(up, target.upOffset)
        .addScaledVector(forward, target.forwardOffset);
      return {
        definition: target,
        id: target.id,
        kind: target.kind,
        position,
        forward: forward.clone(),
        right: right.clone(),
        up: up.clone(),
        hitPoints: target.hitPoints,
        destroyed: false,
        damageStage: 0 as const,
        destroyedAt: null,
      };
    }));
    this.shieldTargets = this.targets.filter((target) => target.kind === 'shield');
    const core = this.targets.find((target) => target.kind === 'core');
    const calibration = this.targets.find((target) => target.kind === 'calibration');
    if (!core || !calibration || this.shieldTargets.length !== 6) {
      throw new Error('DEAD SIGNAL requires one calibration target, six shield nodes, and one core');
    }
    this.coreTarget = core;
    this.calibrationTarget = calibration;
  }

  reset(): void {
    this.shotsFired = 0;
    this.shotsHit = 0;
    for (const target of this.targets) {
      target.hitPoints = target.definition.hitPoints;
      target.destroyed = false;
      target.damageStage = 0;
      target.destroyedAt = null;
    }
  }

  get shieldDestroyed(): number {
    let count = 0;
    for (const target of this.shieldTargets) if (target.destroyed) count++;
    return count;
  }

  get shieldTotal(): number {
    return this.shieldTargets.length;
  }

  get coreDestroyed(): boolean {
    return this.coreTarget.destroyed;
  }

  get coreDestroyedAt(): number | null {
    return this.coreTarget.destroyedAt;
  }

  get calibrationDestroyed(): boolean {
    return this.calibrationTarget.destroyed;
  }

  get accuracy(): number {
    return this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0;
  }

  canReceiveFire(target: DeadSignalTargetState, shieldRequired: number): boolean {
    if (target.destroyed) return false;
    return target.kind !== 'core' || this.shieldDestroyed >= shieldRequired;
  }

  recordShot(hit: boolean): void {
    this.shotsFired++;
    if (hit) this.shotsHit++;
  }

  damage(target: DeadSignalTargetState, amount: number, elapsed: number): DeadSignalDamageOutcome {
    if (target.destroyed || amount <= 0) return { hit: false, destroyed: false, target };
    target.hitPoints = Math.max(0, target.hitPoints - amount);
    const ratio = target.hitPoints / target.definition.hitPoints;
    target.damageStage = ratio <= 0
      ? 3
      : ratio <= 1 / 3
        ? 2
        : ratio <= 2 / 3
          ? 1
          : 0;
    if (target.hitPoints > 0) return { hit: true, destroyed: false, target };
    target.destroyed = true;
    target.destroyedAt = elapsed;
    return { hit: true, destroyed: true, target };
  }
}
