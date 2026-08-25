import * as THREE from 'three';
import type { MissionDefinition } from '../core/Missions.ts';
import type { FlightPath } from '../game/FlightPath.ts';
import { lastAscentShockfrontProgressAt } from '../game/missions/LastAscentObjective.ts';

/** Damaged launch gantry and ascent rails, built in two fixed instanced batches. */
export class LastAscentLaunchStructure {
  readonly object = new THREE.Group();

  private readonly rails: THREE.InstancedMesh;
  private readonly beacons: THREE.InstancedMesh;

  constructor(path: FlightPath) {
    const railGeometry = new THREE.BoxGeometry(1, 1, 1);
    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0x243844,
      metalness: 0.78,
      roughness: 0.52,
      emissive: 0x07141b,
      emissiveIntensity: 0.3,
    });
    this.rails = new THREE.InstancedMesh(railGeometry, railMaterial, 24);
    this.rails.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (let index = 0; index < 12; index++) {
      const progress = 0.006 + index * 0.008;
      path.curve.getPointAt(progress, point);
      path.curve.getTangentAt(progress, tangent).normalize();
      right.crossVectors(tangent, worldUp).normalize();
      up.crossVectors(right, tangent).normalize();
      quaternion.setFromUnitVectors(zAxis, tangent);
      for (let side = 0; side < 2; side++) {
        const instance = index * 2 + side;
        const sideSign = side === 0 ? -1 : 1;
        point.addScaledVector(right, sideSign * 230).addScaledVector(up, -80 + index * 10);
        scale.set(20, 24, 390);
        matrix.compose(point, quaternion, scale);
        this.rails.setMatrixAt(instance, matrix);
        point.addScaledVector(right, -sideSign * 230).addScaledVector(up, 80 - index * 10);
      }
    }
    this.rails.instanceMatrix.needsUpdate = true;

    const beaconGeometry = new THREE.CylinderGeometry(4, 9, 76, 8);
    const beaconMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6238,
      transparent: true,
      opacity: 0.72,
    });
    this.beacons = new THREE.InstancedMesh(beaconGeometry, beaconMaterial, 12);
    this.beacons.frustumCulled = false;
    for (let index = 0; index < 12; index++) {
      const progress = 0.01 + index * 0.008;
      path.curve.getPointAt(progress, point);
      path.curve.getTangentAt(progress, tangent).normalize();
      right.crossVectors(tangent, worldUp).normalize();
      point.addScaledVector(right, index % 2 === 0 ? -225 : 225);
      quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
      scale.set(1, 1, 1);
      matrix.compose(point, quaternion, scale);
      this.beacons.setMatrixAt(index, matrix);
    }
    this.beacons.instanceMatrix.needsUpdate = true;
    this.object.add(this.rails, this.beacons);
  }

  update(time: number): void {
    const material = this.beacons.material as THREE.MeshBasicMaterial;
    material.opacity = 0.72 + Math.sin(time * 3.2) * 0.2;
  }

  dispose(): void {
    this.rails.geometry.dispose();
    (this.rails.material as THREE.Material).dispose();
    this.beacons.geometry.dispose();
    (this.beacons.material as THREE.Material).dispose();
  }
}

/** Three concentric opaque-edged energy rings showing the scripted front on the authored path. */
export class LastAscentShockfront {
  readonly object: THREE.InstancedMesh;

  private readonly path: FlightPath;
  private readonly definition: MissionDefinition;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  private readonly normal = new THREE.Vector3();
  private readonly instancePosition = new THREE.Vector3();

  constructor(path: FlightPath, definition: MissionDefinition) {
    this.path = path;
    this.definition = definition;
    this.material = new THREE.MeshBasicMaterial({
      color: 0xff4b2d,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.InstancedMesh(
      new THREE.RingGeometry(720, 900, 64, 1),
      this.material,
      3,
    );
    this.object.frustumCulled = false;
  }

  update(runTime: number): void {
    const progress = lastAscentShockfrontProgressAt(runTime, this.definition);
    this.object.visible = progress > 0;
    if (!this.object.visible) return;
    const p = Math.min(0.999, Math.max(0, progress));
    this.path.poseAt(p, this.position, this.quaternion);
    this.normal.copy(this.zAxis).applyQuaternion(this.quaternion);
    for (let index = 0; index < 3; index++) {
      this.scale.setScalar(1 + index * 0.16 + Math.sin(runTime * 2.4 + index) * 0.025);
      this.instancePosition.copy(this.position).addScaledVector(this.normal, -index * 110);
      this.matrix.compose(
        this.instancePosition,
        this.quaternion,
        this.scale,
      );
      this.object.setMatrixAt(index, this.matrix);
    }
    this.object.instanceMatrix.needsUpdate = true;
    this.material.opacity = 0.27 + Math.sin(runTime * 3.1) * 0.06;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
