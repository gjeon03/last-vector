import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import type { FlightPath } from '../game/FlightPath.ts';
import type { WorldContact } from '../game/MissionRuntime.ts';
import type { LastAscentCheckpointFrame } from '../game/missions/LastAscentObjective.ts';

const COLLISION_COUNT = 20;
const DECORATIVE_COUNT = 144;
const ORIGIN_GUARD_METRES = 0.001;

interface DebrisSeed {
  readonly checkpoint: number;
  readonly right: number;
  readonly up: number;
  readonly forward: number;
  readonly radius: number;
  readonly phase: number;
}

const DEBRIS_SEEDS: readonly DebrisSeed[] = [
  { checkpoint: 0, right: -740, up: -260, forward: 0, radius: 138, phase: 0.1 },
  { checkpoint: 0, right: -480, up: 220, forward: -30, radius: 116, phase: 1.0 },
  { checkpoint: 0, right: -190, up: -340, forward: 26, radius: 128, phase: 2.1 },
  { checkpoint: 0, right: 20, up: 330, forward: -18, radius: 112, phase: 3.0 },
  { checkpoint: 0, right: 610, up: -310, forward: 22, radius: 148, phase: 4.2 },
  { checkpoint: 0, right: 760, up: 260, forward: -34, radius: 124, phase: 5.1 },

  { checkpoint: 1, right: -700, up: -420, forward: 14, radius: 142, phase: 0.6 },
  { checkpoint: 1, right: -430, up: -120, forward: -26, radius: 108, phase: 1.4 },
  { checkpoint: 1, right: -170, up: 50, forward: 28, radius: 132, phase: 2.5 },
  { checkpoint: 1, right: 120, up: -260, forward: -16, radius: 122, phase: 3.4 },
  { checkpoint: 1, right: 410, up: 10, forward: 32, radius: 118, phase: 4.3 },
  { checkpoint: 1, right: 680, up: -350, forward: -24, radius: 150, phase: 5.2 },
  { checkpoint: 1, right: 760, up: 220, forward: 12, radius: 104, phase: 5.8 },

  { checkpoint: 2, right: -760, up: 300, forward: -28, radius: 126, phase: 0.2 },
  { checkpoint: 2, right: -620, up: -440, forward: 18, radius: 116, phase: 1.2 },
  { checkpoint: 2, right: -40, up: -360, forward: -12, radius: 144, phase: 2.2 },
  { checkpoint: 2, right: 180, up: 40, forward: 30, radius: 108, phase: 3.2 },
  { checkpoint: 2, right: 410, up: 370, forward: -20, radius: 138, phase: 4.1 },
  { checkpoint: 2, right: 690, up: -170, forward: 24, radius: 114, phase: 5.0 },
  { checkpoint: 2, right: 780, up: 330, forward: -32, radius: 146, phase: 5.7 },
];

/** One collision batch, one decorative batch, one three-instance corridor batch. */
export class LastAscentDebris {
  readonly object = new THREE.Group();
  readonly contacts: readonly WorldContact[];
  readonly collisionBatchCount = 1;

  private readonly collisionMesh: THREE.InstancedMesh;
  private readonly decorativeMesh: THREE.InstancedMesh;
  private readonly corridorMesh: THREE.InstancedMesh;
  private readonly bases: THREE.Vector3[] = [];
  private readonly positions: THREE.Vector3[] = [];
  private readonly radii: number[] = [];
  private readonly phases: number[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scale = new THREE.Vector3();
  private readonly corridorQuaternion = new THREE.Quaternion();
  private clock = 0;

  constructor(
    path: FlightPath,
    checkpoints: readonly LastAscentCheckpointFrame[],
    seed: number,
  ) {
    if (DEBRIS_SEEDS.length !== COLLISION_COUNT) {
      throw new Error('LAST ASCENT collision debris authoring must remain exactly bounded');
    }
    const collisionGeometry = new THREE.IcosahedronGeometry(1, 1);
    const collisionMaterial = new THREE.MeshStandardMaterial({
      color: 0x39444b,
      roughness: 0.82,
      metalness: 0.48,
      emissive: 0x110806,
      emissiveIntensity: 0.18,
      flatShading: true,
    });
    this.collisionMesh = new THREE.InstancedMesh(
      collisionGeometry,
      collisionMaterial,
      COLLISION_COUNT,
    );
    this.collisionMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.collisionMesh.frustumCulled = false;

    const contacts: WorldContact[] = [];
    for (let index = 0; index < DEBRIS_SEEDS.length; index++) {
      const authored = DEBRIS_SEEDS[index]!;
      const checkpoint = checkpoints[authored.checkpoint]!;
      const base = checkpoint.position.clone()
        .addScaledVector(checkpoint.right, authored.right)
        .addScaledVector(checkpoint.up, authored.up)
        .addScaledVector(checkpoint.forward, authored.forward);
      if (base.distanceTo(path.startPosition) <= ORIGIN_GUARD_METRES) {
        throw new Error(`LAST ASCENT debris ${index} violates the exact-centre spawn guard`);
      }
      const position = base.clone();
      this.bases.push(base);
      this.positions.push(position);
      this.radii.push(authored.radius);
      this.phases.push(authored.phase);
      contacts.push({
        id: `last-ascent:debris:${index}`,
        kind: 'debris',
        position,
        radius: authored.radius,
      });
    }
    this.contacts = Object.freeze(contacts);

    const decorativeGeometry = new THREE.TetrahedronGeometry(1, 0);
    const decorativeMaterial = new THREE.MeshStandardMaterial({
      color: 0x28333b,
      roughness: 0.88,
      metalness: 0.35,
      flatShading: true,
    });
    this.decorativeMesh = new THREE.InstancedMesh(
      decorativeGeometry,
      decorativeMaterial,
      DECORATIVE_COUNT,
    );
    this.decorativeMesh.frustumCulled = false;
    const rng = new Rng(seed ^ 0x6e11);
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    for (let index = 0; index < DECORATIVE_COUNT; index++) {
      const progress = rng.range(0.08, 0.96);
      path.curve.getPointAt(progress, point);
      path.curve.getTangentAt(progress, tangent).normalize();
      right.crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
      up.crossVectors(right, tangent).normalize();
      const side = rng.range(1200, 3800) * (rng.bool() ? 1 : -1);
      point.addScaledVector(right, side).addScaledVector(up, rng.range(-2300, 2300));
      const radius = rng.range(18, 88);
      this.euler.set(rng.range(0, 6), rng.range(0, 6), rng.range(0, 6));
      this.quaternion.setFromEuler(this.euler);
      this.scale.set(radius * rng.range(0.6, 1.8), radius, radius * rng.range(0.5, 1.4));
      this.matrix.compose(point, this.quaternion, this.scale);
      this.decorativeMesh.setMatrixAt(index, this.matrix);
    }
    this.decorativeMesh.instanceMatrix.needsUpdate = true;

    const corridorGeometry = new THREE.TorusGeometry(360, 8, 8, 48);
    const corridorMaterial = new THREE.MeshBasicMaterial({
      color: 0x76ecff,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.corridorMesh = new THREE.InstancedMesh(
      corridorGeometry,
      corridorMaterial,
      checkpoints.length,
    );
    this.corridorMesh.frustumCulled = false;
    for (const checkpoint of checkpoints) {
      this.corridorQuaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        checkpoint.forward,
      );
      this.scale.set(1, 1, 1);
      this.matrix.compose(checkpoint.position, this.corridorQuaternion, this.scale);
      this.corridorMesh.setMatrixAt(checkpoint.index, this.matrix);
    }
    this.corridorMesh.instanceMatrix.needsUpdate = true;
    this.object.add(this.decorativeMesh, this.collisionMesh, this.corridorMesh);
    this.updatePresentation();
  }

  reset(): void {
    this.clock = 0;
    for (let index = 0; index < this.positions.length; index++) {
      this.positions[index]!.copy(this.bases[index]!);
    }
  }

  /** Slow deterministic drift/tumble only; ship position is deliberately absent. */
  updateSimulation(dt: number): void {
    this.clock += dt;
    for (let index = 0; index < this.positions.length; index++) {
      const phase = this.phases[index]!;
      const base = this.bases[index]!;
      this.positions[index]!.set(
        base.x + Math.sin(this.clock * 0.21 + phase) * 18,
        base.y + Math.cos(this.clock * 0.17 + phase * 1.3) * 14,
        base.z + Math.sin(this.clock * 0.13 + phase * 0.7) * 12,
      );
    }
  }

  updatePresentation(): void {
    for (let index = 0; index < this.positions.length; index++) {
      const radius = this.radii[index]!;
      const phase = this.phases[index]!;
      this.euler.set(
        this.clock * (0.06 + (index % 3) * 0.015) + phase,
        this.clock * (0.05 + (index % 5) * 0.01) - phase,
        phase * 0.4,
      );
      this.quaternion.setFromEuler(this.euler);
      this.scale.set(radius * 1.12, radius * 0.74, radius * 0.92);
      this.matrix.compose(this.positions[index]!, this.quaternion, this.scale);
      this.collisionMesh.setMatrixAt(index, this.matrix);
    }
    this.collisionMesh.instanceMatrix.needsUpdate = true;
  }

  setDecorativeFraction(fraction: number): void {
    this.decorativeMesh.count = Math.max(24, Math.floor(DECORATIVE_COUNT * fraction));
  }

  dispose(): void {
    this.collisionMesh.geometry.dispose();
    (this.collisionMesh.material as THREE.Material).dispose();
    this.decorativeMesh.geometry.dispose();
    (this.decorativeMesh.material as THREE.Material).dispose();
    this.corridorMesh.geometry.dispose();
    (this.corridorMesh.material as THREE.Material).dispose();
  }
}
