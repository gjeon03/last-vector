import * as THREE from 'three';
import type { FlightCommand } from '../core/Input.ts';
import { FLIGHT } from '../core/art.ts';
import { clamp, clamp01, damp } from '../core/mathx.ts';

/**
 * The flight model. This is where the game lives or dies.
 *
 * Design intent — an arcade craft with real inertia:
 *
 *  - Rotation is *rate* controlled with a spool-up, so the nose has mass. Instant rotation is
 *    the single biggest tell of a cheap space game.
 *  - Velocity is decomposed into a forward component and a lateral component. Thrust drives
 *    the forward part toward a commanded speed; the lateral part decays on its own clock.
 *    Turning therefore converts forward velocity into lateral velocity, and you visibly arc
 *    through the turn before the vector catches up. That arc is the whole feel of the game.
 *  - The assist level is nothing but the lateral decay time constant, which is why "raw"
 *    feels like Newtonian drift and "arcade" feels like an aeroplane, with one number between.
 *  - Control authority falls with speed, so boosting commits you to a line.
 */

export type AssistLevel = 'arcade' | 'standard' | 'raw';

const LATERAL_TAU: Record<AssistLevel, number> = {
  arcade: 0.34,
  standard: 0.95,
  raw: 5.5,
};

const MAX_RATE = {
  pitch: 1.55,
  yaw: 1.25,
  roll: 2.7,
};

export class Ship {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  /** Body-frame angular rates: x = pitch, y = yaw, z = roll. */
  readonly angularVelocity = new THREE.Vector3();

  /** Cosmetic lean applied to the mesh only; the flight frame is never rolled by it. */
  readonly visualLean = new THREE.Euler();

  energy = FLIGHT.boostCapacity;
  hull = 1;
  boosting = false;
  boostLocked = false;
  assist: AssistLevel = 'standard';

  /** Metres. Used for collision and for the camera's clearance test. */
  readonly radius = 9;

  private boostCooldown = 0;
  private leanRoll = 0;
  private leanPitch = 0;
  private smoothedThrottle = 0;
  private gLoad = 0;
  private lastVelocity = new THREE.Vector3();
  private shakeImpulse = 0;

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly lateral = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly rotationDelta = new THREE.Quaternion();
  private readonly rotationEuler = new THREE.Euler(0, 0, 0, 'XYZ');

  /**
   * Last state known to be entirely finite. A single non-finite value anywhere in the
   * integration poisons position, orientation and every downstream consumer within one frame,
   * and the interface layer is full of canvas calls that throw on NaN. Rather than sprinkle
   * guards through the renderer, the simulation refuses to emit a broken state at all.
   */
  private readonly lastGoodPosition = new THREE.Vector3();
  private readonly lastGoodQuaternion = new THREE.Quaternion();
  private readonly lastGoodVelocity = new THREE.Vector3();

  reset(position: THREE.Vector3, quaternion: THREE.Quaternion, speed: number): void {
    this.position.copy(position);
    this.quaternion.copy(quaternion);
    this.getForward(this.forward);
    this.velocity.copy(this.forward).multiplyScalar(speed);
    this.lastVelocity.copy(this.velocity);
    this.angularVelocity.set(0, 0, 0);
    this.energy = FLIGHT.boostCapacity;
    this.hull = 1;
    this.boosting = false;
    this.boostLocked = false;
    this.boostCooldown = 0;
    this.leanRoll = 0;
    this.leanPitch = 0;
    this.smoothedThrottle = 0;
    this.gLoad = 0;
    this.shakeImpulse = 0;
    this.lastGoodPosition.copy(this.position);
    this.lastGoodQuaternion.copy(this.quaternion);
    this.lastGoodVelocity.copy(this.velocity);
  }

  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quaternion);
  }

  get speed(): number {
    return this.velocity.length();
  }

  get speed01(): number {
    return clamp01(this.speed / FLIGHT.maxSpeed);
  }

  /** 0..1 lateral slip, i.e. how far the vector is from the nose. Drives thruster audio. */
  get slip(): number {
    if (this.speed < 1) return 0;
    this.getForward(this.scratch);
    const along = this.velocity.dot(this.scratch);
    return clamp01(Math.sqrt(Math.max(0, this.velocity.lengthSq() - along * along)) / 220);
  }

  get gForce(): number {
    return this.gLoad;
  }

  get shake(): number {
    return this.shakeImpulse;
  }

  update(dt: number, command: FlightCommand): void {
    this.getForward(this.forward);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);

    const speed01 = this.speed01;
    // Authority falls off with speed: at full boost you can still steer, but you commit.
    const authority = 1 - speed01 * 0.42;

    // --- boost ------------------------------------------------------------------------
    // The overdrive is a single latch with hysteresis. Without the floor it re-lit for one
    // frame every time regeneration crossed a hair above empty, so a held key produced a
    // buzzing stutter instead of either thrust or a clear "you are out".
    const engageFloor = FLIGHT.boostCapacity * 0.08;
    const rearmLevel = FLIGHT.boostCapacity * 0.45;
    const wantsBoost = command.boost && command.throttle > 0.05;
    if (wantsBoost && !this.boostLocked && this.energy > engageFloor) {
      this.boosting = true;
      this.energy -= FLIGHT.boostDrain * dt;
      this.boostCooldown = FLIGHT.boostRegenDelay;
      if (this.energy <= engageFloor) {
        this.energy = Math.max(0, this.energy);
        this.boosting = false;
        this.boostLocked = true;
      }
    } else {
      this.boosting = false;
      this.boostCooldown = Math.max(0, this.boostCooldown - dt);
      if (this.boostCooldown === 0) {
        this.energy = Math.min(FLIGHT.boostCapacity, this.energy + FLIGHT.boostRegen * dt);
      }
      // Re-arm only once there is a *usable* reserve. Just under half a tank buys well over a
      // second of thrust, so a re-engage always feels like a decision rather than a twitch.
      if (this.boostLocked && this.energy >= rearmLevel) this.boostLocked = false;
    }

    // --- angular ----------------------------------------------------------------------
    const targetPitch = command.pitch * MAX_RATE.pitch * authority;
    const targetYaw = -command.yaw * MAX_RATE.yaw * authority;
    const targetRoll = -command.roll * MAX_RATE.roll;

    // Asymmetric spool: the nose leads into a manoeuvre faster than it settles out of one,
    // which reads as a craft fighting its own mass rather than a lerp.
    const spinTau = 0.115;
    const settleTau = 0.2;
    this.angularVelocity.x = damp(
      this.angularVelocity.x,
      targetPitch,
      Math.abs(targetPitch) > Math.abs(this.angularVelocity.x) ? spinTau : settleTau,
      dt,
    );
    this.angularVelocity.y = damp(
      this.angularVelocity.y,
      targetYaw,
      Math.abs(targetYaw) > Math.abs(this.angularVelocity.y) ? spinTau : settleTau,
      dt,
    );
    this.angularVelocity.z = damp(this.angularVelocity.z, targetRoll, 0.13, dt);

    this.rotationEuler.set(
      this.angularVelocity.x * dt,
      this.angularVelocity.y * dt,
      this.angularVelocity.z * dt,
      'XYZ',
    );
    this.rotationDelta.setFromEuler(this.rotationEuler);
    this.quaternion.multiply(this.rotationDelta).normalize();
    this.getForward(this.forward);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);

    // Cosmetic lean: the airframe banks into yaw and noses into pitch. Purely visual, so the
    // control axes never drift, but it is most of what sells the craft as physical.
    this.leanRoll = damp(this.leanRoll, clamp(-command.yaw, -1, 1) * 0.62, 0.22, dt);
    this.leanPitch = damp(this.leanPitch, clamp(command.pitch, -1, 1) * 0.14, 0.24, dt);
    this.visualLean.set(this.leanPitch, 0, this.leanRoll);

    // --- linear -----------------------------------------------------------------------
    this.smoothedThrottle = damp(this.smoothedThrottle, command.throttle, 0.16, dt);

    const targetSpeed = command.brake
      ? 0
      : this.smoothedThrottle * (this.boosting ? FLIGHT.boostSpeed : FLIGHT.cruiseSpeed);

    let along = this.velocity.dot(this.forward);
    this.lateral.copy(this.velocity).addScaledVector(this.forward, -along);

    // Spooling up takes longer than spooling down; brakes are stronger than the drive.
    const accelTau = this.boosting ? 0.85 : FLIGHT.spoolTime / 3;
    const tau = command.brake ? 0.55 : along < targetSpeed ? accelTau : 1.1;
    along = damp(along, targetSpeed, tau, dt);

    const lateralTau = command.brake ? 0.4 : LATERAL_TAU[this.assist];
    this.lateral.multiplyScalar(Math.exp(-dt / lateralTau));

    // Manoeuvring thrusters push directly on the lateral component.
    const strafeAccel = 165;
    this.lateral.addScaledVector(this.right, command.strafeX * strafeAccel * dt);
    this.lateral.addScaledVector(this.up, command.strafeY * strafeAccel * dt);

    this.velocity.copy(this.forward).multiplyScalar(along).add(this.lateral);
    const speed = this.velocity.length();
    if (speed > FLIGHT.maxSpeed) this.velocity.multiplyScalar(FLIGHT.maxSpeed / speed);

    this.position.addScaledVector(this.velocity, dt);

    // --- felt load --------------------------------------------------------------------
    this.scratch.copy(this.velocity).sub(this.lastVelocity).divideScalar(Math.max(dt, 1e-4));
    this.gLoad = damp(this.gLoad, this.scratch.length() / 9.81, 0.12, dt);
    this.lastVelocity.copy(this.velocity);

    this.shakeImpulse = damp(this.shakeImpulse, 0, 0.28, dt);
    this.guardState();
  }

  private static finiteVector(v: THREE.Vector3): boolean {
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  }

  /** Rolls back to the last finite state if the integration produced anything that is not. */
  private guardState(): void {
    const ok =
      Ship.finiteVector(this.position) &&
      Ship.finiteVector(this.velocity) &&
      Ship.finiteVector(this.angularVelocity) &&
      Number.isFinite(this.quaternion.x) &&
      Number.isFinite(this.quaternion.y) &&
      Number.isFinite(this.quaternion.z) &&
      Number.isFinite(this.quaternion.w) &&
      Number.isFinite(this.energy) &&
      Number.isFinite(this.hull);

    if (ok) {
      this.lastGoodPosition.copy(this.position);
      this.lastGoodQuaternion.copy(this.quaternion);
      this.lastGoodVelocity.copy(this.velocity);
      return;
    }

    this.position.copy(this.lastGoodPosition);
    this.quaternion.copy(this.lastGoodQuaternion);
    this.velocity.copy(this.lastGoodVelocity);
    this.angularVelocity.set(0, 0, 0);
    this.lastVelocity.copy(this.velocity);
    if (!Number.isFinite(this.energy)) this.energy = FLIGHT.boostCapacity;
    if (!Number.isFinite(this.hull)) this.hull = 1;
    this.gLoad = 0;
    this.smoothedThrottle = clamp01(this.smoothedThrottle) || 0;
  }

  /** Applies a collision response and returns the severity, 0..1. */
  applyImpact(normal: THREE.Vector3, penetration: number): number {
    const closing = Math.max(0, -this.velocity.dot(normal));
    const severity = clamp01(closing / 520);

    // Slide along the surface rather than stopping dead: glancing a rock should cost time and
    // control, not end the run.
    this.velocity.addScaledVector(normal, closing * 1.35);
    this.velocity.multiplyScalar(1 - 0.35 * severity);
    this.position.addScaledVector(normal, penetration + 0.5);

    this.angularVelocity.x += (Math.random() - 0.5) * severity * 2.4;
    this.angularVelocity.y += (Math.random() - 0.5) * severity * 2.4;
    this.angularVelocity.z += (Math.random() - 0.5) * severity * 3.2;

    this.hull = clamp01(this.hull - severity * 0.22);
    this.shakeImpulse = Math.min(1, this.shakeImpulse + severity * 1.2 + 0.15);
    return severity;
  }

  get energy01(): number {
    return clamp01(this.energy / FLIGHT.boostCapacity);
  }

  get throttleSmoothed(): number {
    return this.smoothedThrottle;
  }
}
