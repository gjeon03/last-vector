import * as THREE from 'three';
import type { MissionRewardEvent } from '../../core/contracts.ts';
import {
  MISSION_REWARD_EVENT_CAPACITY,
  MISSION_WEAPON_EVENT_CAPACITY,
  type MissionWeaponEvent,
  type MissionWeaponRuntime,
  type MissionWeaponUpdateFrame,
} from '../MissionRuntime.ts';
import type { DeadSignalEffects } from '../../render/DeadSignalEffects.ts';
import type { DeadSignalMissionDefinition } from './DeadSignalMission.ts';
import type { DeadSignalState, DeadSignalTargetState } from './DeadSignalState.ts';

export const DEAD_SIGNAL_WEAPON = Object.freeze({
  fireIntervalSeconds: 0.125,
  damagePerPulse: 22,
  rangeMetres: 3_200,
  aimAssistDegrees: 4.25,
  targetableCapacity: 16,
});

const ASSIST_TANGENT = Math.tan(THREE.MathUtils.degToRad(DEAD_SIGNAL_WEAPON.aimAssistDegrees));

/** Fixed-rate centreline hitscan. It owns no projectile bodies and scans at most 16 targets. */
export class DeadSignalWeapon implements MissionWeaponRuntime {
  private readonly mission: DeadSignalMissionDefinition;
  private readonly state: DeadSignalState;
  private readonly effects: DeadSignalEffects;
  private readonly events: MissionWeaponEvent[] = [];
  private readonly rewards: MissionRewardEvent[] = [];
  private readonly origin = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private cooldown = 0;

  constructor(options: {
    mission: DeadSignalMissionDefinition;
    state: DeadSignalState;
    effects: DeadSignalEffects;
  }) {
    this.mission = options.mission;
    this.state = options.state;
    this.effects = options.effects;
  }

  reset(): void {
    this.cooldown = 0;
    this.events.length = 0;
    this.rewards.length = 0;
    this.state.reset();
  }

  update(frame: MissionWeaponUpdateFrame): void {
    this.cooldown -= frame.dt;
    if (!frame.fire) {
      this.cooldown = Math.max(0, this.cooldown);
      return;
    }
    if (frame.targetables.length > DEAD_SIGNAL_WEAPON.targetableCapacity) {
      throw new Error('DEAD SIGNAL weapon targetable set exceeded 16');
    }

    // A bounded catch-up preserves 8 Hz under ordinary frame variation without allowing a
    // debugger pause to burst an unbounded number of shots into one simulation step.
    let fired = 0;
    while (this.cooldown <= 0 && fired < 4) {
      this.firePulse(frame);
      this.cooldown += DEAD_SIGNAL_WEAPON.fireIntervalSeconds;
      fired++;
    }
    if (this.cooldown <= 0) this.cooldown = DEAD_SIGNAL_WEAPON.fireIntervalSeconds;
  }

  drainEvents(out: MissionWeaponEvent[]): number {
    const count = this.events.length;
    for (let index = 0; index < count; index++) out.push(this.events[index]!);
    this.events.length = 0;
    return count;
  }

  drainRewardEvents(out: MissionRewardEvent[]): number {
    const count = this.rewards.length;
    for (let index = 0; index < count; index++) out.push(this.rewards[index]!);
    this.rewards.length = 0;
    return count;
  }

  dispose(): void {
    this.events.length = 0;
    this.rewards.length = 0;
  }

  private firePulse(frame: MissionWeaponUpdateFrame): void {
    this.origin.copy(frame.position).addScaledVector(frame.forward, 14);
    const target = this.acquire(frame);
    this.pushEvent({ type: 'fire', intensity: target ? 0.72 : 0.48 });
    this.state.recordShot(target !== null);

    if (!target) {
      this.end.copy(this.origin).addScaledVector(frame.forward, DEAD_SIGNAL_WEAPON.rangeMetres);
      this.effects.spawnTracer(this.origin, this.end);
      return;
    }

    this.end.copy(target.position);
    this.effects.spawnTracer(this.origin, this.end);
    const damage = this.state.damage(
      target,
      DEAD_SIGNAL_WEAPON.damagePerPulse,
      frame.elapsed,
    );
    if (!damage.hit) return;
    this.pushEvent({
      type: 'hit',
      intensity: target.kind === 'core' ? 1 : 0.65,
      sourceId: target.id,
    });
    this.effects.spawnExplosion(target.position, target.kind === 'core' ? 9 : 5);
    if (!damage.destroyed) return;

    this.pushEvent({
      type: 'destroy',
      intensity: target.kind === 'core' ? 1 : target.kind === 'shield' ? 0.78 : 0.5,
      sourceId: target.id,
    });
    this.effects.spawnExplosion(target.position, target.definition.radius * 1.2);
    if (target.kind === 'shield') {
      this.pushReward({ kind: 'boost-recharge', amount: 25, sourceId: target.id });
    }
  }

  private acquire(frame: MissionWeaponUpdateFrame): DeadSignalTargetState | null {
    let best: DeadSignalTargetState | null = null;
    let bestAngleSq = Infinity;
    let bestDistance = Infinity;
    for (let index = 0; index < frame.targetables.length; index++) {
      const candidate = frame.targetables[index] as DeadSignalTargetState;
      if (!this.state.targets.includes(candidate)
        || !this.state.canReceiveFire(candidate, this.mission.objective.shieldRequired)) continue;
      this.toTarget.copy(candidate.position).sub(this.origin);
      const along = this.toTarget.dot(frame.forward);
      if (along <= 0 || along > DEAD_SIGNAL_WEAPON.rangeMetres) continue;
      const perpendicularSq = Math.max(0, this.toTarget.lengthSq() - along * along);
      const assistedRadius = candidate.definition.radius + along * ASSIST_TANGENT;
      if (perpendicularSq > assistedRadius * assistedRadius) continue;
      const angleSq = perpendicularSq / (along * along);
      if (angleSq < bestAngleSq || (angleSq === bestAngleSq && along < bestDistance)) {
        best = candidate;
        bestAngleSq = angleSq;
        bestDistance = along;
      }
    }
    return best;
  }

  private pushEvent(event: MissionWeaponEvent): void {
    if (this.events.length < MISSION_WEAPON_EVENT_CAPACITY) this.events.push(event);
  }

  private pushReward(event: MissionRewardEvent): void {
    if (this.rewards.length < MISSION_REWARD_EVENT_CAPACITY) this.rewards.push(event);
  }
}
