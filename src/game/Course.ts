import * as THREE from 'three';
import { Gate } from '../render/Gate.ts';
import type { LightingUniforms } from '../render/lighting.ts';
import { Rng } from '../core/rng.ts';
import { SCALE } from '../core/art.ts';
import { clamp01 } from '../core/mathx.ts';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * The course through THE CAIRN DRIFT.
 *
 * The spine is authored as a sequence of *legs* with deliberate character rather than random
 * noise, because pacing is what makes a route memorable: an easy opener to teach the controls,
 * a hard turn that punishes carrying too much speed, a dive through the thick of the shelf, a
 * long straight that exists purely so the player boosts and feels the frame tear, then a
 * tightening approach to the terminus.
 */

export interface CoursePassEvent {
  gate: Gate;
  index: number;
  time: number;
  radialDistance: number;
  speed: number;
  /** Fraction of the aperture radius; 0 is dead centre. */
  offset: number;
}

interface Leg {
  /** Radians of yaw applied across the leg. */
  turn: number;
  /** Radians of pitch applied across the leg. */
  climb: number;
  /** Multiplier on the nominal gate spacing. */
  length: number;
  /** Roll of the gate aperture about the flight axis, in radians. */
  bank: number;
  /**
   * Half-width in metres of the debris-free channel along the leg's racing line.
   *
   * This is the lever that decides whether a leg asks anything of the pilot. Turn angle over
   * leg length cannot: at a 288 m minimum turn radius, even the tightest leg here needs a
   * radius of about 3.2 km, an order of magnitude inside the ship's capability, and shortening
   * legs enough to close that gap would collapse a nine-gate course to a few hundred metres a
   * leg. Measured on the reviewed build, a whole lap held the stick under 0.086 for 90% of its
   * frames and asked for more than a quarter stick in 5.1% of them.
   *
   * Rock in the line is what converts a wide-open arc into continuous work.
   *
   * Sized against the reference pilot's MEASURED overshoot, not against an authored ideal. A
   * proportional follower swings wide in proportion to how hard the leg turns — 110 m outside
   * the channel on the 1.02 rad leg — so the channel has to carry that or the course is unfair
   * to anything that is not a perfect path follower.
   */
  clearance: number;
  label: string;
}

/**
 * Pacing.
 *
 * The first cut of this course demanded nothing. At a 288 m steady-state turn radius against
 * 6.2 km legs, a naive proportional controller reading nothing but the on-screen gate marker
 * flew all nine apertures dead centre on its first attempt and beat the built-in autopilot.
 * Every leg was inside the ship's capability by more than an order of magnitude, so the
 * authored differences between "hard right" and "the long run" were invisible in the hand.
 *
 * The fix is not more turn — it is less room. `length` now varies from 0.52 to 1.4, so the
 * tight legs put a real turn inside a distance where the ship's inertia is the binding
 * constraint, while the long ones stay long precisely so the contrast is felt. The aperture
 * came down too: 210 m across is still forgiving at 420 m/s, but it is no longer a barn door.
 */
const LEGS: Leg[] = [
  // Wide on purpose: the opening leg is where a first-time pilot learns that the stick has
  // inertia behind it, and learning that against a rock is not teaching.
  { turn: 0.1, climb: -0.04, length: 1.0, bank: 0.0, clearance: 320, label: 'open' },
  { turn: -0.62, climb: 0.14, length: 0.95, bank: 0.5, clearance: 240, label: 'first bend' },
  { turn: 0.52, climb: -0.4, length: 0.6, bank: -0.35, clearance: 150, label: 'the dive' },
  { turn: 1.02, climb: 0.06, length: 0.78, bank: 0.85, clearance: 275, label: 'hard right' },
  { turn: -0.5, climb: 0.34, length: 1.05, bank: -0.6, clearance: 210, label: 'climb out' },
  { turn: -0.92, climb: -0.16, length: 0.56, bank: -0.9, clearance: 145, label: 'the shelf cut' },
  // The long run is the rest bar: it is where the reserve refills and where a player can look
  // up at the sky. Taking that away would make the course relentless rather than paced.
  { turn: 0.2, climb: -0.14, length: 1.4, bank: 0.2, clearance: 300, label: 'the long run' },
  { turn: 0.78, climb: 0.2, length: 0.52, bank: 0.7, clearance: 175, label: 'the pinch' },
  { turn: -0.3, climb: -0.08, length: 1.0, bank: -0.2, clearance: 260, label: 'terminus approach' },
];

export class Course {
  readonly object = new THREE.Group();
  readonly gates: Gate[] = [];
  readonly spine: THREE.Vector3[] = [];
  readonly curve: THREE.CatmullRomCurve3;
  readonly startPosition = new THREE.Vector3();
  readonly startQuaternion = new THREE.Quaternion();
  readonly terminusPosition = new THREE.Vector3();
  readonly terminusNormal = new THREE.Vector3();
  readonly totalLength: number;
  /**
   * Half-width of the debris-free channel for each racing-line segment, in order:
   * start->gate0, gate0->gate1, ... , lastGate->terminus.
   */
  readonly legClearance: number[] = [];
  /**
   * The volume that must stay free of debris: the union of the curved spine the ship actually
   * flies and the gate-to-gate chords a fast pilot cuts to.
   *
   * Protecting only the chords put a rock inside the arc on the tightest leg — the flown path
   * bulges outside a straight chord, and at 100 m of clearance that bulge is larger than the
   * channel. The autopilot took a hull strike at gate 5 flying the line exactly as authored.
   */
  readonly clearChannel: { a: THREE.Vector3; b: THREE.Vector3; radius: number }[] = [];
  readonly id: string;

  /** Index of the gate the player must clear next; equals `gates.length` once all are done. */
  nextIndex = 0;
  readonly passes: CoursePassEvent[] = [];

  private previousSigned = -1;
  private readonly previousPosition = new THREE.Vector3();
  private hasPrevious = false;
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly crossing = new THREE.Vector3();
  private readonly poseMatrix = new THREE.Matrix4();

  onPass: ((event: CoursePassEvent) => void) | null = null;
  onMiss: ((gate: Gate) => void) | null = null;

  constructor(seed: number, lighting: LightingUniforms) {
    this.id = `cairn-drift-${seed}`;
    const rng = new Rng(seed);

    const controlPoints: THREE.Vector3[] = [];
    const gateAnchors: { position: THREE.Vector3; tangent: THREE.Vector3; bank: number }[] = [];

    const heading = new THREE.Quaternion();
    const cursor = new THREE.Vector3(0, 0, 0);
    const forward = new THREE.Vector3(0, 0, -1);

    // A short lead-in so the player is already moving when the first gate appears.
    controlPoints.push(cursor.clone().addScaledVector(forward, -1800));
    controlPoints.push(cursor.clone());
    this.startPosition.copy(cursor).addScaledVector(forward, 1500);
    this.startQuaternion.copy(heading);

    for (let i = 0; i < LEGS.length; i++) {
      const leg = LEGS[i];
      const distance = SCALE.gateSpacing * leg.length * rng.range(0.94, 1.06);
      const turn = leg.turn * rng.range(0.9, 1.1);
      const climb = leg.climb * rng.range(0.88, 1.12);

      // Walk the leg in steps so the spine curves smoothly instead of kinking at each gate.
      const steps = 6;
      for (let s = 0; s < steps; s++) {
        const q = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(climb / steps, turn / steps, 0, 'YXZ'),
        );
        heading.multiply(q).normalize();
        forward.set(0, 0, -1).applyQuaternion(heading);
        cursor.addScaledVector(forward, distance / steps);
        controlPoints.push(cursor.clone());
      }

      gateAnchors.push({
        position: cursor.clone(),
        tangent: forward.clone().normalize(),
        bank: leg.bank,
      });
      // One entry per segment ENTERING this gate, so the channel narrows on the approach to
      // the gate that terminates the leg rather than after it.
      this.legClearance.push(leg.clearance);
    }

    // The run-out to the terminus inherits the last leg's channel.
    this.legClearance.push(LEGS[LEGS.length - 1].clearance);

    // Run-out past the final gate, where the terminus sits.
    for (let s = 0; s < 4; s++) {
      cursor.addScaledVector(forward, 900);
      controlPoints.push(cursor.clone());
    }
    this.terminusPosition.copy(cursor).addScaledVector(forward, 3200);
    this.terminusNormal.copy(forward).normalize();

    this.curve = new THREE.CatmullRomCurve3(controlPoints, false, 'centripetal', 0.5);
    this.totalLength = this.curve.getLength();

    const sampleCount = 220;
    for (let i = 0; i <= sampleCount; i++) {
      this.spine.push(this.curve.getPointAt(i / sampleCount));
    }

    // Chords first: start -> each gate -> terminus, at that leg's clearance.
    const chordNodes = [this.startPosition.clone(), ...gateAnchors.map((a) => a.position.clone())];
    chordNodes.push(this.terminusPosition.clone());
    for (let i = 0; i < chordNodes.length - 1; i++) {
      this.clearChannel.push({
        a: chordNodes[i],
        b: chordNodes[i + 1],
        radius: this.legClearance[i] ?? 320,
      });
    }
    // Then the curve itself, at the clearance of whichever leg each sample falls in.
    for (let i = 0; i < this.spine.length - 1; i++) {
      const legIndex = Math.min(
        this.legClearance.length - 1,
        Math.floor((i / (this.spine.length - 1)) * this.legClearance.length),
      );
      this.clearChannel.push({
        a: this.spine[i],
        b: this.spine[i + 1],
        radius: this.legClearance[legIndex],
      });
    }

    for (let i = 0; i < gateAnchors.length; i++) {
      const anchor = gateAnchors[i];
      // Final gate is wider: the approach is fast and the run should not end on a technicality.
      const radius = i === gateAnchors.length - 1 ? SCALE.gateRadius * 1.3 : SCALE.gateRadius;
      const gate = new Gate({
        index: i,
        total: gateAnchors.length,
        position: anchor.position,
        normal: anchor.tangent,
        radius,
        lighting,
        seed: seed + i * 7919,
      });
      gate.object.rotateZ(anchor.bank);
      this.gates.push(gate);
      this.object.add(gate.object);
    }

    this.gates[0].setState('armed');
  }

  get nextGate(): Gate | null {
    return this.gates[this.nextIndex] ?? null;
  }

  get complete(): boolean {
    return this.nextIndex >= this.gates.length;
  }

  /** 0..1 along the whole route including the terminus run-out. */
  progress(position: THREE.Vector3): number {
    const total = this.gates.length + 1;
    let done = this.nextIndex;
    const target = this.nextGate?.position ?? this.terminusPosition;
    const previous = this.nextIndex === 0 ? this.startPosition : this.gates[this.nextIndex - 1].position;
    const legLength = previous.distanceTo(target);
    if (legLength > 1) {
      done += clamp01(1 - position.distanceTo(target) / legLength);
    }
    return clamp01(done / total);
  }

  /** Straight-line metres remaining: next gate, then every gate after it, then the terminus. */
  remainingDistance(position: THREE.Vector3): number {
    let total = 0;
    let from = position;
    for (let i = this.nextIndex; i < this.gates.length; i++) {
      total += from.distanceTo(this.gates[i].position);
      from = this.gates[i].position;
    }
    total += from.distanceTo(this.terminusPosition);
    return total;
  }

  reset(): void {
    this.nextIndex = 0;
    this.passes.length = 0;
    this.hasPrevious = false;
    this.previousSigned = -1;
    for (const gate of this.gates) gate.setState('dormant');
    this.gates[0].setState('armed');
  }

  /**
   * Detects gate crossings by watching the signed distance to the aperture plane flip. The
   * crossing point is interpolated between the two sampled positions, so detection is exact
   * even at 1000 m/s with a 16 ms step — no tunnelling, no swept-sphere cost.
   */
  update(position: THREE.Vector3, speed: number, time: number): void {
    const gate = this.nextGate;
    if (!gate) {
      this.hasPrevious = false;
      return;
    }

    const signed = gate.signedDistance(position);

    if (!this.hasPrevious) {
      this.previousSigned = signed;
      this.previousPosition.copy(position);
      this.hasPrevious = true;
      return;
    }

    // A crossing in EITHER direction counts. Watching only negative-to-positive meant that
    // after an overshoot the natural recovery — turn round, fly back through it — crossed the
    // plane the wrong way and registered nothing at all: no pass, no miss, no callout. Combined
    // with a director that could not point you back, a single missed cairn ended the run.
    const crossedForward = this.previousSigned < 0 && signed >= 0;
    const crossedBackward = this.previousSigned > 0 && signed <= 0;
    if (crossedForward || crossedBackward) {
      const denominator = signed - this.previousSigned;
      const t = denominator === 0 ? 0 : -this.previousSigned / denominator;
      this.crossing.lerpVectors(this.previousPosition, position, clamp01(t));

      const radial = gate.radialDistance(this.crossing, this.scratchA);
      if (radial <= gate.radius) {
        const event: CoursePassEvent = {
          gate,
          index: gate.index,
          time,
          radialDistance: radial,
          speed,
          offset: clamp01(radial / gate.radius),
        };
        this.passes.push(event);
        gate.setState('cleared');
        this.nextIndex++;
        this.gates[this.nextIndex]?.setState('armed');
        this.hasPrevious = false;
        this.onPass?.(event);
        return;
      }

      // Crossed the plane outside the aperture: the cairn stays armed and has to be re-flown.
      gate.setState('missed');
      this.onMiss?.(gate);
      // Re-arm on the next frame so the visual flash lands before the colour returns.
      window.setTimeout(() => {
        if (this.gates[this.nextIndex] === gate) gate.setState('armed');
      }, 420);
    }

    this.previousSigned = signed;
    this.previousPosition.copy(position);
  }

  /**
   * A racing line target for the autopilot: aim at the next gate, but bias toward the gate
   * *after* it once close, so the AI carves through rather than stopping at each aperture.
   */
  /**
   * Where the autopilot should point.
   *
   * Pure pursuit against the next gate. A spine-lookahead follower was tried instead, on the
   * theory that a waypoint jumping the instant a gate clears is what makes the path bulge
   * outside the turn — it was worse on every measure: the run did not finish and the excursion
   * outside the debris-free channel went from 110 m to 732 m, because aiming at a point far
   * ahead on the curve while the ship is off the curve cuts the corner instead of rejoining it.
   * Left as pure pursuit, and the corridor is sized against its MEASURED overshoot instead.
   */
  autopilotTarget(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const gate = this.nextGate;
    if (!gate) return out.copy(this.terminusPosition);

    const distance = position.distanceTo(gate.position);
    out.copy(gate.position);

    // Approach along the gate normal so the crossing is square rather than oblique.
    const approach = Math.min(distance * 0.55, gate.radius * 6);
    out.addScaledVector(gate.normal, -approach * clamp01(1 - distance / 3000));

    const following = this.gates[gate.index + 1];
    if (distance < gate.radius * 5) {
      const beyond = following ? following.position : this.terminusPosition;
      out.lerp(beyond, clamp01(1 - distance / (gate.radius * 5)) * 0.45);
    }
    return out;
  }

  /** Pose along the course at normalised `t`, for seeking and cinematic vantages. */
  poseAt(t: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    const clamped = clamp01(t);
    this.curve.getPointAt(clamped, position);
    this.curve.getTangentAt(clamped, this.scratchB).normalize();
    // three's Matrix4.lookAt puts +Z along (eye - target), and an object's forward is -Z, so
    // forward ends up as normalize(target - eye). The target is therefore the tangent itself:
    // negating it here pointed the ship back down the course, which is why a seek or a
    // cinematic vantage started with the nose facing the way it had come.
    this.scratchA.set(0, 0, 0);
    this.poseMatrix.lookAt(this.scratchA, this.scratchB, WORLD_UP);
    quaternion.setFromRotationMatrix(this.poseMatrix);
  }

  update3d(dt: number, time: number, cameraPosition: THREE.Vector3, pixelScale: number): void {
    for (const gate of this.gates) {
      // Skip gates that are far behind the player; they are neither visible nor animating.
      if (gate.state === 'cleared' && gate.position.distanceToSquared(cameraPosition) > 36_000_000) continue;
      gate.update(dt, time, cameraPosition, pixelScale);
    }
  }

  dispose(): void {
    for (const gate of this.gates) gate.dispose();
  }
}
