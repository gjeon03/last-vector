import * as THREE from 'three';
import type { FlightPathDefinition } from '../core/Courses.ts';
import { clamp01 } from '../core/mathx.ts';
import { Rng } from '../core/rng.ts';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export interface FlightPathGateAnchor {
  readonly position: THREE.Vector3;
  readonly tangent: THREE.Vector3;
  readonly bank: number;
}

export interface FlightPathChannelSegment {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly radius: number;
}

/**
 * Deterministic authored flight geometry, independent of gates and objective state.
 *
 * Gate race, escape and strike objectives may share this path for spawn pose, guidance,
 * protected channels, title flight and extraction without inheriting gate progression.
 */
export class FlightPath {
  readonly definition: FlightPathDefinition;
  readonly spine: THREE.Vector3[] = [];
  readonly gateAnchors: FlightPathGateAnchor[] = [];
  readonly curve: THREE.CatmullRomCurve3;
  readonly startPosition = new THREE.Vector3();
  readonly startQuaternion = new THREE.Quaternion();
  readonly terminusPosition = new THREE.Vector3();
  readonly terminusNormal = new THREE.Vector3();
  readonly totalLength: number;
  readonly legClearance: number[] = [];
  readonly clearChannel: FlightPathChannelSegment[] = [];

  private readonly tangent = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly poseMatrix = new THREE.Matrix4();

  constructor(definition: FlightPathDefinition, seed: number) {
    this.definition = definition;
    const legs = definition.legs;
    const rng = new Rng(seed);
    const controlPoints: THREE.Vector3[] = [];
    const heading = new THREE.Quaternion();
    const cursor = new THREE.Vector3(0, 0, 0);
    const forward = new THREE.Vector3(0, 0, -1);

    controlPoints.push(cursor.clone().addScaledVector(forward, -definition.leadInControlMetres));
    controlPoints.push(cursor.clone());
    this.startPosition.copy(cursor).addScaledVector(forward, definition.startOffsetMetres);
    this.startQuaternion.copy(heading);

    for (const leg of legs) {
      const distance = definition.gateSpacing * leg.length * rng.range(0.94, 1.06);
      const turn = leg.turn * rng.range(0.9, 1.1);
      const climb = leg.climb * rng.range(0.88, 1.12);
      const steps = 6;
      for (let step = 0; step < steps; step++) {
        const delta = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(climb / steps, turn / steps, 0, 'YXZ'),
        );
        heading.multiply(delta).normalize();
        forward.set(0, 0, -1).applyQuaternion(heading);
        cursor.addScaledVector(forward, distance / steps);
        controlPoints.push(cursor.clone());
      }

      this.gateAnchors.push({
        position: cursor.clone(),
        tangent: forward.clone().normalize(),
        bank: leg.bank,
      });
      this.legClearance.push(leg.clearance);
    }

    this.legClearance.push(legs[legs.length - 1]!.clearance);
    for (let step = 0; step < definition.runOutSteps; step++) {
      cursor.addScaledVector(forward, definition.runOutStepMetres);
      controlPoints.push(cursor.clone());
    }
    this.terminusPosition.copy(cursor).addScaledVector(forward, definition.terminusStandoff);
    this.terminusNormal.copy(forward).normalize();

    this.curve = new THREE.CatmullRomCurve3(controlPoints, false, 'centripetal', 0.5);
    this.totalLength = this.curve.getLength();
    for (let index = 0; index <= definition.sampleCount; index++) {
      this.spine.push(this.curve.getPointAt(index / definition.sampleCount));
    }

    const chordNodes = [
      this.startPosition.clone(),
      ...this.gateAnchors.map((anchor) => anchor.position.clone()),
      this.terminusPosition.clone(),
    ];
    for (let index = 0; index < chordNodes.length - 1; index++) {
      this.clearChannel.push({
        a: chordNodes[index]!,
        b: chordNodes[index + 1]!,
        radius: this.legClearance[index] ?? 320,
      });
    }

    const anchorIndices = this.gateAnchors.map((anchor) => {
      let closestIndex = 0;
      let closestDistanceSq = Infinity;
      for (let index = 0; index < this.spine.length; index++) {
        const distanceSq = anchor.position.distanceToSquared(this.spine[index]!);
        if (distanceSq < closestDistanceSq) {
          closestDistanceSq = distanceSq;
          closestIndex = index;
        }
      }
      return closestIndex;
    });
    let legIndex = 0;
    for (let index = 0; index < this.spine.length - 1; index++) {
      while (legIndex < anchorIndices.length && index > anchorIndices[legIndex]!) legIndex++;
      this.clearChannel.push({
        a: this.spine[index]!,
        b: this.spine[index + 1]!,
        radius: this.legClearance[Math.min(this.legClearance.length - 1, legIndex)]!,
      });
    }
  }

  /** Pose along the path at normalized `t`, for seeking and authored cameras. */
  poseAt(t: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const clamped = clamp01(t);
    this.curve.getPointAt(clamped, position);
    this.curve.getTangentAt(clamped, this.tangent).normalize();
    this.origin.set(0, 0, 0);
    this.poseMatrix.lookAt(this.origin, this.tangent, WORLD_UP);
    quaternion.setFromRotationMatrix(this.poseMatrix);
  }
}
