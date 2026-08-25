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
const UNIT_X = new THREE.Vector3(1, 0, 0);

function triangles(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? Math.floor(geometry.index.count / 3)
    : Math.floor(geometry.getAttribute('position').count / 3);
}

const TARGET_BEACON_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize <= 0.0
      ? 0.0
      : clamp(aSize / max(-mv.z, 1.0), 24.0, 180.0);
    vColor = aColor;
  }
`;

const TARGET_BEACON_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p);
    if (r > 0.5) discard;
    float outer = 1.0 - smoothstep(0.43, 0.49, r);
    float inner = smoothstep(0.31, 0.37, r);
    float ring = outer * inner;
    float core = 1.0 - smoothstep(0.08, 0.15, r);
    float tickX = (1.0 - smoothstep(0.018, 0.038, abs(p.x)))
      * smoothstep(0.22, 0.29, abs(p.y));
    float tickY = (1.0 - smoothstep(0.018, 0.038, abs(p.y)))
      * smoothstep(0.22, 0.29, abs(p.x));
    float alpha = max(max(ring, core), max(tickX, tickY));
    gl_FragColor = vec4(vColor * (1.25 + core * 1.4), alpha);
  }
`;

/**
 * Eclipsed industrial array assembled from retained RINGFALL ring hulls and WRECKLINE spine
 * massing. Fixed instanced draws represent the entire damageable facility, including one bounded
 * target-halo draw that keeps the damageable geometry legible against the eclipse.
 */
export class DeadSignalFacility {
  readonly object = new THREE.Group();

  private readonly state: DeadSignalState;
  private readonly structureMaterial: THREE.ShaderMaterial;
  private readonly ringGeometry = buildRingHull(720, 72, 105, 72, 12, 4.6, Math.PI * 1.72);
  private readonly pylonGeometry = new THREE.BoxGeometry(86, 120, 1_450, 1, 1, 5);
  private readonly nodeGeometry = new THREE.IcosahedronGeometry(110, 2);
  private readonly coreGeometry = new THREE.IcosahedronGeometry(54, 2);
  private readonly haloGeometry = new THREE.TorusGeometry(220, 9, 6, 24);
  private readonly targetMountGeometry = new THREE.BoxGeometry(360, 24, 24);
  private readonly beaconGeometry = new THREE.BufferGeometry();
  private readonly nodeMaterial = new THREE.MeshBasicMaterial({
    color: 0x7cecff,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    wireframe: true,
  });
  private readonly coreMaterial = new THREE.MeshBasicMaterial({
    color: 0xff4d38,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  private readonly haloMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  private readonly beaconMaterial = new THREE.ShaderMaterial({
    vertexShader: TARGET_BEACON_VERT,
    fragmentShader: TARGET_BEACON_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  private readonly outlineMaterial = new THREE.MeshBasicMaterial({
    color: 0x65d8ee,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    toneMapped: false,
    wireframe: true,
  });
  private readonly rings: THREE.InstancedMesh;
  private readonly ringOutlines: THREE.InstancedMesh;
  private readonly pylons: THREE.InstancedMesh;
  private readonly pylonOutlines: THREE.InstancedMesh;
  private readonly nodes: THREE.InstancedMesh;
  private readonly cores: THREE.InstancedMesh;
  private readonly halos: THREE.InstancedMesh;
  private readonly targetMounts: THREE.InstancedMesh;
  private readonly beacons: THREE.Points;
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
      base: 0x273249,
      accent: 0x718aa8,
      window: 0xff3b2d,
      windowDensity: 0.09,
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
    this.ringOutlines = new THREE.InstancedMesh(
      this.ringGeometry,
      this.outlineMaterial,
      ringCount,
    );
    this.ringOutlines.instanceMatrix = this.rings.instanceMatrix;
    this.ringOutlines.name = 'BLACK ARRAY / RING SILHOUETTE OUTLINES';
    this.ringOutlines.renderOrder = 4;

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
    this.pylonOutlines = new THREE.InstancedMesh(
      this.pylonGeometry,
      this.outlineMaterial,
      pylonCount,
    );
    this.pylonOutlines.instanceMatrix = this.pylons.instanceMatrix;
    this.pylonOutlines.name = 'BLACK ARRAY / PYLON SILHOUETTE OUTLINES';
    this.pylonOutlines.renderOrder = 4;

    const targetCount = this.state.targets.length;
    this.nodes = new THREE.InstancedMesh(this.nodeGeometry, this.nodeMaterial, targetCount);
    this.cores = new THREE.InstancedMesh(this.coreGeometry, this.coreMaterial, targetCount);
    this.halos = new THREE.InstancedMesh(this.haloGeometry, this.haloMaterial, targetCount);
    this.targetMounts = new THREE.InstancedMesh(
      this.targetMountGeometry,
      this.outlineMaterial,
      targetCount * 2,
    );
    const beaconPositions = new Float32Array(targetCount * 3);
    const beaconColors = new Float32Array(targetCount * 3);
    const beaconSizes = new Float32Array(targetCount);
    for (let index = 0; index < targetCount; index++) {
      const target = this.state.targets[index]!;
      target.position.toArray(beaconPositions, index * 3);
    }
    this.beaconGeometry.setAttribute('position', new THREE.BufferAttribute(beaconPositions, 3));
    this.beaconGeometry.setAttribute('aColor', new THREE.BufferAttribute(beaconColors, 3));
    this.beaconGeometry.setAttribute('aSize', new THREE.BufferAttribute(beaconSizes, 1));
    this.beaconGeometry.computeBoundingSphere();
    this.beacons = new THREE.Points(this.beaconGeometry, this.beaconMaterial);
    this.nodes.name = 'BLACK ARRAY / DAMAGEABLE TARGET HOUSINGS';
    this.cores.name = 'BLACK ARRAY / DAMAGEABLE TARGET CORES';
    this.halos.name = 'BLACK ARRAY / DAMAGEABLE TARGET HALOS';
    this.beacons.name = 'BLACK ARRAY / HIGH-CONTRAST TARGET BEACONS';
    this.targetMounts.name = 'BLACK ARRAY / TARGET PYLON BRACES';
    this.nodes.frustumCulled = false;
    this.cores.frustumCulled = false;
    this.halos.frustumCulled = false;
    this.nodes.renderOrder = 20;
    this.cores.renderOrder = 21;
    this.halos.renderOrder = 22;
    this.beacons.frustumCulled = false;
    this.beacons.renderOrder = 23;
    this.targetMounts.frustumCulled = false;
    this.targetMounts.renderOrder = 19;
    this.targetStages = new Array(targetCount).fill(-1);
    for (let index = 0; index < targetCount; index++) {
      const target = this.state.targets[index]!;
      this.quaternion.setFromUnitVectors(UNIT_Z, target.forward);
      // Keep the exposed core out of the cyan shield-housing batch. Its dedicated red-orange
      // instance remains in the same fixed draw and owns the climax silhouette.
      const size = target.kind === 'core' ? 0.01 : 1;
      this.scale.setScalar(size);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.nodes.setMatrixAt(index, this.matrix);
      this.scale.setScalar(target.kind === 'core' ? 4.5 : 0.01);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.cores.setMatrixAt(index, this.matrix);
      const haloScale = target.kind === 'core'
        ? target.definition.radius / 38
        : target.kind === 'calibration'
          ? 0.82
          : 1;
      this.scale.setScalar(haloScale);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.halos.setMatrixAt(index, this.matrix);
      this.halos.setColorAt(
        index,
        new THREE.Color(target.kind === 'core' ? 0xff3b20 : 0x7cecff),
      );
      this.quaternion.setFromUnitVectors(UNIT_X, target.right);
      this.scale.setScalar(1);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.targetMounts.setMatrixAt(index * 2, this.matrix);
      this.quaternion.setFromUnitVectors(UNIT_X, target.up);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.targetMounts.setMatrixAt(index * 2 + 1, this.matrix);
    }
    this.nodes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cores.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.halos.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodes.instanceMatrix.needsUpdate = true;
    this.cores.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
    if (this.halos.instanceColor) this.halos.instanceColor.needsUpdate = true;
    this.targetMounts.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.targetMounts.instanceMatrix.needsUpdate = true;
    this.syncDamage(true);

    this.object.add(
      this.rings,
      this.ringOutlines,
      this.pylons,
      this.pylonOutlines,
      this.targetMounts,
      this.nodes,
      this.cores,
      this.halos,
      this.beacons,
    );
    this.debug = Object.freeze({
      drawCalls: 9,
      triangles: triangles(this.ringGeometry) * ringCount
        + triangles(this.pylonGeometry) * pylonCount
        + (triangles(this.nodeGeometry) + triangles(this.coreGeometry)
          + triangles(this.haloGeometry) + triangles(this.targetMountGeometry) * 2) * targetCount,
      geometries: 7,
      materials: 6,
      targetables: targetCount,
    });
    if (this.debug.drawCalls > 12 || this.debug.triangles > 120_000) {
      throw new Error('DEAD SIGNAL facility exceeds its render budget');
    }
  }

  update(time: number, cameraPosition: THREE.Vector3, shipPosition: THREE.Vector3): void {
    this.structureMaterial.uniforms.uTime.value = time;
    this.structureMaterial.uniforms.uCameraPos.value.copy(cameraPosition);
    this.syncDamage(false);
    this.faceHalosTo(cameraPosition, shipPosition);
  }

  getDebugState(): DeadSignalFacilityDebug {
    return this.debug;
  }

  dispose(): void {
    this.ringGeometry.dispose();
    this.pylonGeometry.dispose();
    this.nodeGeometry.dispose();
    this.coreGeometry.dispose();
    this.haloGeometry.dispose();
    this.beaconGeometry.dispose();
    this.targetMountGeometry.dispose();
    this.structureMaterial.dispose();
    this.nodeMaterial.dispose();
    this.coreMaterial.dispose();
    this.haloMaterial.dispose();
    this.beaconMaterial.dispose();
    this.outlineMaterial.dispose();
  }

  private syncDamage(force: boolean): void {
    let dirty = false;
    for (let index = 0; index < this.state.targets.length; index++) {
      const target = this.state.targets[index]!;
      if (!force && this.targetStages[index] === target.damageStage) continue;
      this.targetStages[index] = target.damageStage;
      const beaconColor = target.destroyed
        ? new THREE.Color(0x4b151b)
        : target.damageStage === 0
          ? new THREE.Color(target.kind === 'core' ? 0xff4d38 : 0x7cecff)
          : target.damageStage === 1
            ? new THREE.Color(0xffd36a)
            : new THREE.Color(0xff5a42);
      const colors = this.beaconGeometry.getAttribute('aColor') as THREE.BufferAttribute;
      colors.setXYZ(index, beaconColor.r, beaconColor.g, beaconColor.b);
      const sizes = this.beaconGeometry.getAttribute('aSize') as THREE.BufferAttribute;
      sizes.setX(index, (target.kind === 'core' ? 34_000 : 24_000)
        * (target.destroyed ? 0.45 : 1 + target.damageStage * 0.08));
      const coreScale = target.kind !== 'core'
        ? 0.01
        : target.destroyed ? 0.12 : 1 + target.damageStage * 0.16;
      this.quaternion.setFromUnitVectors(UNIT_Z, target.forward);
      const nodeScale = target.kind === 'core'
        ? 0.01
        : target.destroyed ? 0.01 : 1 + target.damageStage * 0.06;
      this.scale.setScalar(nodeScale);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.nodes.setMatrixAt(index, this.matrix);
      this.scale.setScalar(coreScale * (target.kind === 'core' ? 4.5 : 1));
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.cores.setMatrixAt(index, this.matrix);
      const haloScale = (target.kind === 'core'
        ? target.definition.radius / 38
        : target.kind === 'calibration'
          ? 0.82
          : 1) * (target.destroyed ? 0.01 : 1 + target.damageStage * 0.06);
      this.scale.setScalar(haloScale);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.halos.setMatrixAt(index, this.matrix);
      dirty = true;
    }
    if (!dirty) return;
    this.beaconGeometry.getAttribute('aColor').needsUpdate = true;
    this.beaconGeometry.getAttribute('aSize').needsUpdate = true;
    this.nodes.instanceMatrix.needsUpdate = true;
    this.cores.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
  }

  /** One instanced billboard draw keeps every fixed target readable against the eclipsed hull. */
  private faceHalosTo(cameraPosition: THREE.Vector3, shipPosition: THREE.Vector3): void {
    const beaconSizes = this.beaconGeometry.getAttribute('aSize') as THREE.BufferAttribute;
    for (let index = 0; index < this.state.targets.length; index++) {
      const target = this.state.targets[index]!;
      this.position.copy(cameraPosition).sub(target.position);
      const presentationDistance = shipPosition.distanceTo(target.position);
      if (this.position.lengthSq() < 1e-6) this.position.copy(target.forward);
      else this.position.normalize();
      this.quaternion.setFromUnitVectors(UNIT_Z, this.position);
      const haloScale = (target.kind === 'core'
        ? target.definition.radius / 38
        : target.kind === 'calibration'
          ? 0.82
          : 1) * (target.destroyed ? 0.01 : 1 + target.damageStage * 0.06);
      this.scale.setScalar(haloScale);
      this.matrix.compose(target.position, this.quaternion, this.scale);
      this.halos.setMatrixAt(index, this.matrix);
      // Only the active presentation window gets the unmistakable large beacon. Far targets keep
      // their physical housings but cannot collapse into a cluster of screen-space markers.
      beaconSizes.setX(index, presentationDistance <= 3_300 && !target.destroyed
        ? (target.kind === 'core' ? 34_000 : 24_000) * (1 + target.damageStage * 0.08)
        : 0);
    }
    this.halos.instanceMatrix.needsUpdate = true;
    beaconSizes.needsUpdate = true;
  }
}
