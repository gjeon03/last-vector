import * as THREE from 'three';
import type { ShearGateDefinition } from '../core/Courses.ts';
import { Rng } from '../core/rng.ts';
import type { Gate } from './Gate.ts';

const TAU = Math.PI * 2;

export interface ShearGateState {
  readonly gateIndex: number;
  readonly initialPhase: number;
  readonly angularSpeed: number;
}

export interface ShearDebugState {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly halfWidthRadians: number;
  readonly hubRadiusFraction: number;
  readonly states: readonly {
    gateIndex: number;
    phase: number;
    initialPhase: number;
    angularSpeed: number;
  }[];
}

function wrapAngle(value: number): number {
  let wrapped = (value + Math.PI) % TAU;
  if (wrapped < 0) wrapped += TAU;
  return wrapped - Math.PI;
}

function buildArmGeometry(halfWidth: number, hubFraction: number): THREE.BufferGeometry {
  const segments = 12;
  const positions: number[] = [];
  const inner = Math.max(hubFraction * 1.08, 0.02);
  for (let i = 0; i < segments; i++) {
    const a0 = -halfWidth + (i / segments) * halfWidth * 2;
    const a1 = -halfWidth + ((i + 1) / segments) * halfWidth * 2;
    const ix0 = Math.cos(a0) * inner;
    const iy0 = Math.sin(a0) * inner;
    const ix1 = Math.cos(a1) * inner;
    const iy1 = Math.sin(a1) * inner;
    const ox0 = Math.cos(a0);
    const oy0 = Math.sin(a0);
    const ox1 = Math.cos(a1);
    const oy1 = Math.sin(a1);
    positions.push(ix0, iy0, 0, ox0, oy0, 0, ox1, oy1, 0);
    positions.push(ix0, iy0, 0, ox1, oy1, 0, ix1, iy1, 0);
  }

  // A geometric arrow at the leading edge communicates rotation even without colour.
  const direction = halfWidth + 0.08;
  const tangentX = -Math.sin(direction);
  const tangentY = Math.cos(direction);
  const radialX = Math.cos(direction);
  const radialY = Math.sin(direction);
  const cx = radialX * 0.73;
  const cy = radialY * 0.73;
  positions.push(
    cx + tangentX * 0.18, cy + tangentY * 0.18, 0.003,
    cx - tangentX * 0.12 + radialX * 0.1, cy - tangentY * 0.12 + radialY * 0.1, 0.003,
    cx - tangentX * 0.12 - radialX * 0.1, cy - tangentY * 0.12 - radialY * 0.1, 0.003,
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // Keep the shutter in front of the translucent gate field. Sharing the exact plane produces
  // depth flicker on shallow approaches even though the draw order is stable.
  geometry.translate(0, 0, 0.006);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Shared rendering and collision truth for NEEDLE's rotating radial shutters.
 *
 * The field owns two instanced draws for every barrier. All phase parameters are derived once;
 * `update`, `isBlocked`, and `aimPoint` only mutate reused Three.js scratch objects.
 */
export class ShearGateField {
  readonly object = new THREE.Group();
  readonly states: readonly ShearGateState[];
  readonly drawCalls = 2;
  readonly triangles: number;

  private readonly definition: ShearGateDefinition;
  private readonly gates: readonly Gate[];
  private readonly stateByGate = new Map<number, ShearGateState>();
  private readonly arms: THREE.InstancedMesh;
  private readonly hubs: THREE.InstancedMesh;
  private readonly armGeometry: THREE.BufferGeometry;
  private readonly hubGeometry: THREE.BufferGeometry;
  private readonly armMaterial: THREE.MeshBasicMaterial;
  private readonly hubMaterial: THREE.MeshBasicMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly phaseQuaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor(gates: readonly Gate[], definition: ShearGateDefinition, seed: number) {
    this.definition = definition;
    this.gates = gates;
    const states: ShearGateState[] = [];
    for (const gateIndex of definition.gates) {
      const rng = new Rng((seed ^ Math.imul(gateIndex + 1, 0x6d2b79f5)) >>> 0);
      const magnitude = rng.range(
        definition.angularSpeedRange[0],
        definition.angularSpeedRange[1],
      );
      const state: ShearGateState = Object.freeze({
        gateIndex,
        initialPhase: rng.range(-Math.PI, Math.PI),
        angularSpeed: magnitude * (rng.bool() ? 1 : -1),
      });
      states.push(state);
      this.stateByGate.set(gateIndex, state);
    }
    this.states = Object.freeze(states);

    this.armGeometry = buildArmGeometry(definition.halfWidthRadians, definition.hubRadiusFraction);
    this.hubGeometry = new THREE.CircleGeometry(1, 24);
    this.hubGeometry.translate(0, 0, 0.006);
    this.armMaterial = new THREE.MeshBasicMaterial({
      color: 0xe14d62,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.hubMaterial = new THREE.MeshBasicMaterial({
      color: 0x1a1024,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.arms = new THREE.InstancedMesh(
      this.armGeometry,
      this.armMaterial,
      this.states.length,
    );
    this.hubs = new THREE.InstancedMesh(
      this.hubGeometry,
      this.hubMaterial,
      this.states.length,
    );
    this.arms.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hubs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.arms.frustumCulled = false;
    this.hubs.frustumCulled = false;
    this.arms.renderOrder = 9;
    this.hubs.renderOrder = 10;
    this.object.add(this.arms, this.hubs);

    const armTriangles = (this.armGeometry.getAttribute('position')?.count ?? 0) / 3;
    const hubTriangles = this.hubGeometry.index
      ? this.hubGeometry.index.count / 3
      : (this.hubGeometry.getAttribute('position')?.count ?? 0) / 3;
    this.triangles = Math.round((armTriangles + hubTriangles) * this.states.length);
    this.update(0);
  }

  phaseAt(gateIndex: number, time: number): number | null {
    const state = this.stateByGate.get(gateIndex);
    if (!state) return null;
    return wrapAngle(state.initialPhase + state.angularSpeed * Math.max(0, time));
  }

  isBlocked(gate: Gate, localX: number, localY: number, time: number): boolean {
    const phase = this.phaseAt(gate.index, time);
    if (phase === null) return false;
    const radius = Math.hypot(localX, localY);
    if (radius <= gate.radius * this.definition.hubRadiusFraction) return true;
    const angle = Math.atan2(localY, localX);
    return Math.abs(wrapAngle(angle - phase)) <= this.definition.halfWidthRadians;
  }

  /** Open target opposite the shutter, outside its hub. */
  aimPoint(gate: Gate, time: number, out: THREE.Vector3): THREE.Vector3 {
    const phase = this.phaseAt(gate.index, time);
    if (phase === null) return out.copy(gate.position);
    const open = phase + Math.PI;
    const offset = gate.radius * this.definition.aimOffsetFraction;
    return out.copy(gate.position)
      .addScaledVector(gate.planeX, Math.cos(open) * offset)
      .addScaledVector(gate.planeY, Math.sin(open) * offset);
  }

  update(time: number): void {
    for (let instance = 0; instance < this.states.length; instance++) {
      const state = this.states[instance]!;
      const gate = this.gates[state.gateIndex]!;
      const phase = this.phaseAt(state.gateIndex, time) ?? 0;
      this.phaseQuaternion.setFromAxisAngle(gate.normal, phase);
      this.quaternion.copy(this.phaseQuaternion).multiply(gate.object.quaternion);
      // The wedge is symmetric, but its leading-edge arrow is authored for positive rotation.
      // Mirror only the local Y axis for clockwise instances so the visual cue agrees with the
      // signed phase velocity without creating a second geometry/material/draw call.
      this.scale.set(
        gate.radius,
        gate.radius * (state.angularSpeed < 0 ? -1 : 1),
        gate.radius,
      );
      this.matrix.compose(gate.position, this.quaternion, this.scale);
      this.arms.setMatrixAt(instance, this.matrix);

      this.scale.setScalar(gate.radius * this.definition.hubRadiusFraction);
      this.matrix.compose(gate.position, gate.object.quaternion, this.scale);
      this.hubs.setMatrixAt(instance, this.matrix);
    }
    this.arms.instanceMatrix.needsUpdate = true;
    this.hubs.instanceMatrix.needsUpdate = true;
  }

  getDebugState(time: number): ShearDebugState {
    return {
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      halfWidthRadians: this.definition.halfWidthRadians,
      hubRadiusFraction: this.definition.hubRadiusFraction,
      states: this.states.map((state) => ({
        gateIndex: state.gateIndex,
        phase: this.phaseAt(state.gateIndex, time) ?? 0,
        initialPhase: state.initialPhase,
        angularSpeed: state.angularSpeed,
      })),
    };
  }

  dispose(): void {
    this.armGeometry.dispose();
    this.hubGeometry.dispose();
    this.armMaterial.dispose();
    this.hubMaterial.dispose();
  }
}
