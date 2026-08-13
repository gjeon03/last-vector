import * as THREE from 'three';
import type { Ship } from './Ship.ts';
import { clamp01, damp, lerp } from '../core/mathx.ts';

/**
 * The chase camera is half the flight feel.
 *
 * It is a spring arm with *two* independent lags: the boom's position trails the ship, and
 * the boom's orientation trails the ship's orientation on a slower clock. The second lag is
 * the important one — because the camera rotates late, a turn pushes the ship toward the edge
 * of frame and you watch it bank against the starfield instead of the world sliding around a
 * pinned model. Add FOV that opens with speed and a boom that extends under boost, and the
 * same 400 m/s reads as twice as fast.
 */

export interface CameraShakeSource {
  boost: number;
  impact: number;
  proximity: number;
}

const BASE_OFFSET = new THREE.Vector3(0, 2.3, 13.4);

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Multiplier on all shake, from the settings menu. */
  shakeScale = 1;
  baseFov = 76;

  private readonly boomPosition = new THREE.Vector3();
  private readonly boomQuaternion = new THREE.Quaternion();
  private readonly desiredPosition = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly smoothedLook = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly shakeOffset = new THREE.Vector3();
  private readonly upVector = new THREE.Vector3();

  private fov = 76;
  private shakeTime = 0;
  private initialised = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 1.5, 90000);
  }

  snapTo(ship: Ship): void {
    this.boomPosition.copy(ship.position);
    this.boomQuaternion.copy(ship.quaternion);
    this.offset.copy(BASE_OFFSET);
    this.desiredPosition.copy(this.offset).applyQuaternion(this.boomQuaternion).add(this.boomPosition);
    this.camera.position.copy(this.desiredPosition);
    ship.getForward(this.scratch);
    this.smoothedLook.copy(ship.position).addScaledVector(this.scratch, 60);
    this.camera.lookAt(this.smoothedLook);
    this.initialised = true;
  }

  update(dt: number, ship: Ship, shake: CameraShakeSource): void {
    if (!this.initialised) this.snapTo(ship);

    const speed01 = ship.speed01;
    const boost = clamp01(shake.boost);

    // Boom: position lags a little, orientation lags a lot. The gap between the two is what
    // lets you see your own ship manoeuvre.
    this.boomPosition.x = damp(this.boomPosition.x, ship.position.x, 0.045, dt);
    this.boomPosition.y = damp(this.boomPosition.y, ship.position.y, 0.045, dt);
    this.boomPosition.z = damp(this.boomPosition.z, ship.position.z, 0.045, dt);

    const orientationTau = lerp(0.16, 0.085, speed01);
    this.boomQuaternion.slerp(ship.quaternion, 1 - Math.exp(-dt / orientationTau));

    // Pull back and drop slightly as speed builds; under boost the arm extends further.
    this.offset.set(
      BASE_OFFSET.x,
      BASE_OFFSET.y + speed01 * 0.35,
      BASE_OFFSET.z + speed01 * 3.6 + boost * 4.2,
    );
    this.desiredPosition.copy(this.offset).applyQuaternion(this.boomQuaternion).add(this.boomPosition);

    // The camera itself is critically damped toward the arm end, so hard manoeuvres overshoot
    // very slightly and settle without a bounce.
    this.camera.position.x = damp(this.camera.position.x, this.desiredPosition.x, 0.055, dt);
    this.camera.position.y = damp(this.camera.position.y, this.desiredPosition.y, 0.055, dt);
    this.camera.position.z = damp(this.camera.position.z, this.desiredPosition.z, 0.055, dt);

    // Aim ahead of the ship, biased toward where the velocity vector is actually going. At
    // high slip this points off the nose, which is exactly the information a pilot wants.
    ship.getForward(this.scratch);
    this.lookTarget
      .copy(ship.position)
      .addScaledVector(this.scratch, 44 + speed01 * 78);
    if (ship.speed > 12) {
      this.lookTarget.addScaledVector(ship.velocity, 0.035 + boost * 0.02);
    }
    this.smoothedLook.x = damp(this.smoothedLook.x, this.lookTarget.x, 0.08, dt);
    this.smoothedLook.y = damp(this.smoothedLook.y, this.lookTarget.y, 0.08, dt);
    this.smoothedLook.z = damp(this.smoothedLook.z, this.lookTarget.z, 0.08, dt);

    this.upVector.set(0, 1, 0).applyQuaternion(this.boomQuaternion);
    this.camera.up.copy(this.upVector);
    this.camera.lookAt(this.smoothedLook);

    // --- shake ------------------------------------------------------------------------
    this.shakeTime += dt;
    const intensity =
      (boost * 0.55 + shake.impact * 2.4 + shake.proximity * 0.5 + speed01 * 0.14) * this.shakeScale;
    if (intensity > 0.001) {
      const t = this.shakeTime;
      // Layered sines at incommensurable rates: reads as vibration, never as a loop.
      this.shakeOffset.set(
        Math.sin(t * 47.3) * 0.6 + Math.sin(t * 113.7) * 0.25,
        Math.sin(t * 61.1 + 1.3) * 0.6 + Math.sin(t * 97.3) * 0.22,
        Math.sin(t * 39.7 + 2.1) * 0.3,
      );
      this.shakeOffset.multiplyScalar(intensity * 0.42);
      this.shakeOffset.applyQuaternion(this.camera.quaternion);
      this.camera.position.add(this.shakeOffset);
      this.camera.rotateZ(Math.sin(t * 29.3) * intensity * 0.006);
    }

    // --- field of view ----------------------------------------------------------------
    const targetFov = this.baseFov + speed01 * 7.5 + boost * 15 + shake.impact * 4;
    this.fov = damp(this.fov, targetFov, boost > 0.5 ? 0.16 : 0.28, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setAspect(aspect: number): void {
    if (this.camera.aspect === aspect) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Places the camera at an arbitrary pose, for cinematic vantages and screenshots. */
  setPose(position: THREE.Vector3, target: THREE.Vector3, fov: number): void {
    this.camera.position.copy(position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.camera.fov = fov;
    this.fov = fov;
    this.camera.updateProjectionMatrix();
    this.initialised = false;
  }
}
