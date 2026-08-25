import * as THREE from 'three';
import type { LightingUniforms } from './lighting.ts';
import { buildRingHull, createStructureMaterial } from './Structures.ts';
import type { FlightPath } from '../game/FlightPath.ts';
import type { DeadSignalState } from '../game/missions/DeadSignalState.ts';

export interface DeadSignalFacilityDebug {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly materials: number;
  readonly targetables: number;
}

const UNIT_Z = new THREE.Vector3(0, 0, 1);

function triangles(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? Math.floor(geometry.index.count / 3)
    : Math.floor(geometry.getAttribute('position').count / 3);
}

/**
 * Eclipsed industrial array assembled from retained RINGFALL ring hulls and WRECKLINE spine
 * massing. Four instanced draws represent the entire damageable facility.
 */
export class DeadSignalFacility {
  readonly object = new THREE.Group();

  private readonly state: DeadSignalState;
  private readonly structureMaterial: THREE.ShaderMaterial;
  private readonly ringGeometry = buildRingHull(720, 72, 105, 72, 12, 4.6, Math.PI * 1.72);
  private readonly pylonGeometry = new THREE.BoxGeometry(86, 120, 1_450, 1, 1, 5);
  private readonly nodeGeometry = new THREE.IcosahedronGeometry(38, 2);
  private readonly coreGeometry = new THREE.IcosahedronGeometry(22, 2);
  private readonly nodeMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff });
  private readonly coreMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
  });
  private readonly rings: THREE.InstancedMesh;
  private readonly pylons: THREE.InstancedMesh;
  private readonly nodes: THREE.InstancedMesh;
  private readonly cores: THREE.InstancedMesh;
  private readonly targetStages: number[];
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly debug: DeadSignalFacilityDebug;

  constructor(options: {
    path: FlightPath;
    state: DeadSignalState;
    lighting: LightingUniforms;
  }) {
    this.state = options.state;
    this.object.name = 'BLACK ARRAY / DEAD SIGNAL';
    this.structureMaterial = createStructureMaterial({
      lighting: options.lighting,
      base: 0x121722,
      accent: 0x4c5969,
      window: 0xb6281e,
      windowDensity: 0.055,
    });

    const ringCount = 10;
    this.rings = new THREE.InstancedMesh(this.ringGeometry, this.structureMaterial, ringCount);
    this.rings.name = 'BLACK ARRAY / RETAINED RING SILHOUETTES';
    for (let index = 0; index < ringCount; index++) {
      const extraction = index === ringCount - 1;
      const t = extraction ? 1 : 0.255 + index * 0.071;
      options.path.poseAt(t, this.position, this.quaternion);
      if (extraction) this.position.copy(options.path.terminusPosition);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion).normalize();
      this.quaternion.setFromUnitVectors(UNIT_Z, forward);
      this.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UNIT_Z, index * 0.71));
      const size = extraction ? 1.22 : index === ringCount - 2 ? 1.55 : 0.82 + (index % 3) * 0.16;
      this.scale.setScalar(size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.rings.setMatrixAt(index, this.matrix);
    }
    this.rings.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.rings.instanceMatrix.needsUpdate = true;

    const pylonCount = 36;
    this.pylons = new THREE.InstancedMesh(this.pylonGeometry, this.structureMaterial, pylonCount);
    this.pylons.name = 'BLACK ARRAY / WRECKLINE SPINES';
    let pylon = 0;
    for (let bank = 0; bank < 9; bank++) {
      const t = 0.27 + bank * 0.069;
      options.path.poseAt(t, this.position, this.quaternion);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion).normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion).normalize();
      for (let arm = 0; arm < 4; arm++) {
        const angle = arm * Math.PI * 0.5 + bank * 0.22;
        const radial = 720 + (bank % 2) * 120;
        const radialVector = right.clone().multiplyScalar(Math.cos(angle))
          .addScaledVector(up, Math.sin(angle));
        const anchor = this.position.clone().addScaledVector(radialVector, radial);
        this.quaternion.setFromUnitVectors(UNIT_Z, forward);
        this.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(UNIT_Z, angle));
        this.scale.set(0.9 + (arm % 2) * 0.3, 0.8, 0.72 + (bank % 3) * 0.13);
        this.matrix.compose(anchor, this.quaternion, this.scale);
        this.pylons.setMatrixAt(pylon++, this.matrix);
      }
    }
    this.pylons.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.pylons.instanceMatrix.needsUpdate = true;

    const targetCount = this.state.targets.length;
    this.nodes = new THREE.InstancedMesh(this.nodeGeometry, this.nodeMaterial, targetCount);
    this.cores = new THREE.InstancedMesh(this.coreGeometry, this.coreMaterial, targetCount);
    this.nodes.name = 'BLACK ARRAY / DAMAGEABLE TARGET HOUSINGS';
    this.cores.name = 'BLACK ARRAY / DAMAGEABLE TARGET CORES';
    this.nodes.frustumCulled = false;
    this.cores.frustumCulled = false;
    this.targetStages = new Array(targetCount).fill(-1);
    for (let index = 0; index < targetCount; index++) {
      const target = this.state.targets[index]!;
      this.quaternion.setFromUnitVectors(UNIT_Z, target.forward);
      const size = target.kind === 'core' ? target.definition.radius / 38 : 1;
      this.scale.setScalar(size);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.nodes.setMatrixAt(index, this.matrix);
      this.scale.setScalar(target.kind === 'core' ? 2.2 : 1);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.cores.setMatrixAt(index, this.matrix);
    }
    this.nodes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.cores.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodes.instanceMatrix.needsUpdate = true;
    this.cores.instanceMatrix.needsUpdate = true;
    this.syncDamage(true);

    this.object.add(this.rings, this.pylons, this.nodes, this.cores);
    this.debug = Object.freeze({
      drawCalls: 4,
      triangles: triangles(this.ringGeometry) * ringCount
        + triangles(this.pylonGeometry) * pylonCount
        + (triangles(this.nodeGeometry) + triangles(this.coreGeometry)) * targetCount,
      geometries: 4,
      materials: 3,
      targetables: targetCount,
    });
    if (this.debug.drawCalls > 12 || this.debug.triangles > 120_000) {
      throw new Error('DEAD SIGNAL facility exceeds its render budget');
    }
  }

  update(time: number, cameraPosition: THREE.Vector3): void {
    this.structureMaterial.uniforms.uTime.value = time;
    this.structureMaterial.uniforms.uCameraPos.value.copy(cameraPosition);
    this.syncDamage(false);
  }

  getDebugState(): DeadSignalFacilityDebug {
    return this.debug;
  }

  dispose(): void {
    this.ringGeometry.dispose();
    this.pylonGeometry.dispose();
    this.nodeGeometry.dispose();
    this.coreGeometry.dispose();
    this.structureMaterial.dispose();
    this.nodeMaterial.dispose();
    this.coreMaterial.dispose();
  }

  private syncDamage(force: boolean): void {
    let dirty = false;
    for (let index = 0; index < this.state.targets.length; index++) {
      const target = this.state.targets[index]!;
      if (!force && this.targetStages[index] === target.damageStage) continue;
      this.targetStages[index] = target.damageStage;
      const shellColor = target.destroyed
        ? new THREE.Color(0x15171b)
        : target.damageStage === 0
          ? new THREE.Color(target.kind === 'core' ? 0xff4a36 : 0x7cecff)
          : target.damageStage === 1
            ? new THREE.Color(0xffb04a)
            : new THREE.Color(0xff5037);
      const coreColor = target.destroyed
        ? new THREE.Color(0x260b08)
        : target.kind === 'core'
          ? new THREE.Color(0xff2d1f)
          : new THREE.Color(0xc5fbff);
      this.nodes.setColorAt(index, shellColor);
      this.cores.setColorAt(index, coreColor);
      const coreScale = target.destroyed ? 0.12 : 1 + target.damageStage * 0.16;
      this.quaternion.setFromUnitVectors(UNIT_Z, target.forward);
      this.scale.setScalar(coreScale * (target.kind === 'core' ? 2.2 : 1));
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.cores.setMatrixAt(index, this.matrix);
      dirty = true;
    }
    if (!dirty) return;
    if (this.nodes.instanceColor) this.nodes.instanceColor.needsUpdate = true;
    if (this.cores.instanceColor) this.cores.instanceColor.needsUpdate = true;
    this.cores.instanceMatrix.needsUpdate = true;
  }
}
