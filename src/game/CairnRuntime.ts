import * as THREE from 'three';
import { SCALE } from '../core/art.ts';
import { clamp01 } from '../core/mathx.ts';
import type { HazardReport, HarnessStageLandmarkState } from '../core/harness.ts';
import { AsteroidField } from '../render/Asteroids.ts';
import { DustField } from '../render/Dust.ts';
import { bakeNebula } from '../render/Nebula.ts';
import { Planet } from '../render/Planet.ts';
import {
  StageLandmarks,
  STAGE_LANDMARK_ANCHORS,
  type StageLandmarkAnchorFrame,
  type StageLandmarkAnchorSpec,
} from '../render/StageLandmarks.ts';
import { Star } from '../render/Star.ts';
import { Starfield } from '../render/Starfield.ts';
import { DerelictField, Terminus } from '../render/Structures.ts';
import { Course } from './Course.ts';
import { GateRaceObjective } from './GateRaceObjective.ts';
import type { FlightPath } from './FlightPath.ts';
import {
  MissionRuntime,
  type GameMissionRuntimeFactory,
  type LegacyGateFrame,
  type LegacyMissionAdapter,
  type LegacyStagedContact,
  type WorldContact,
} from './MissionRuntime.ts';
import { World } from './World.ts';

function buildStageLandmarkAnchors(
  path: FlightPath,
  definition: Course['definition'],
): StageLandmarkAnchorFrame[] {
  const kind = definition.world.landmarkKind;
  let specs: readonly StageLandmarkAnchorSpec[] = STAGE_LANDMARK_ANCHORS[kind];
  if (kind === 'cairn') {
    const shelf = definition.world.shelf;
    const base = STAGE_LANDMARK_ANCHORS.cairn[0]!;
    specs = [{
      id: base.id,
      routeFraction: shelf.routeFraction,
      rightOffset: shelf.rightOffset,
      forwardOffset: shelf.forwardOffset,
      verticalOffset: shelf.verticalOffset,
    }];
  }

  const anchors: StageLandmarkAnchorFrame[] = [];
  const worldUp = new THREE.Vector3(0, 1, 0);
  for (const spec of specs) {
    const index = Math.min(
      path.spine.length - 1,
      Math.max(0, Math.floor(path.spine.length * spec.routeFraction)),
    );
    const anchor = path.spine[index]!;
    const ahead = path.spine[Math.min(path.spine.length - 1, index + 6)]!;
    const forward = new THREE.Vector3().subVectors(ahead, anchor).normalize();
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const position = anchor.clone()
      .addScaledVector(right, spec.rightOffset)
      .addScaledVector(forward, spec.forwardOffset)
      .addScaledVector(worldUp, spec.verticalOffset);
    anchors.push({ position, forward, right, up });
  }
  return anchors;
}

class CairnLegacyAdapter implements LegacyMissionAdapter {
  private readonly course: Course;
  private readonly world: World;
  private readonly scratch = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();

  constructor(course: Course, world: World) {
    this.course = course;
    this.world = world;
  }

  autopilotTarget(
    position: THREE.Vector3,
    target: THREE.Vector3,
    elapsed: number,
    speed: number,
  ): THREE.Vector3 {
    return this.course.autopilotTarget(position, target, elapsed, speed);
  }

  currentGate(): LegacyGateFrame | null {
    return this.course.nextGate;
  }

  remainingDistance(position: THREE.Vector3): number {
    return this.course.remainingDistance(position);
  }

  autopilotControls(
    frame: Parameters<LegacyMissionAdapter['autopilotControls']>[0],
  ): ReturnType<LegacyMissionAdapter['autopilotControls']> {
    const gate = this.course.nextGate;
    const pilot = this.course.definition.pilot;
    const far = gate
      ? frame.position.distanceTo(gate.position) > gate.radius * pilot.boostClearanceRadii
      : true;
    const brake = pilot.brake;
    const shouldBrake = brake !== null
      && gate !== null
      && frame.targetDistance < gate.radius * brake.distanceRadii
      && frame.alignment < brake.alignmentMax
      && frame.speed > brake.minSpeed;
    return {
      brake: shouldBrake,
      boost: !shouldBrake
        && frame.skill > 0.75
        && frame.alignment > 0.985
        && far
        && frame.energy > 0.45,
    };
  }

  vantages(): ReturnType<LegacyMissionAdapter['vantages']> {
    return this.course.definition.vantages;
  }

  bindGateEvents(handlers: Parameters<LegacyMissionAdapter['bindGateEvents']>[0]): void {
    this.course.onPass = handlers.onPass;
    this.course.onMiss = (gate, event) => {
      handlers.onMiss({ gateIndex: gate.index, blockedBy: event.blockedBy });
    };
  }

  resetMotion(): void {
    this.world.components.asteroids.resetMotion();
  }

  clearVantage(point: THREE.Vector3, shipRadius: number, margin: number): void {
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const contact of this.world.contacts) {
        const clearance = contact.radius + shipRadius + margin;
        const distanceSq = contact.position.distanceToSquared(point);
        if (distanceSq >= clearance * clearance) continue;
        const distance = Math.sqrt(distanceSq) || 1;
        this.scratch.copy(point).sub(contact.position).divideScalar(distance);
        point.copy(contact.position).addScaledVector(this.scratch, clearance);
        moved = true;
      }
      if (!moved) break;
    }
  }

  poseGate(
    index: number,
    standoff: number,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
  ): boolean {
    const gate = this.course.gates[index];
    if (!gate) return false;
    position.copy(gate.position).addScaledVector(gate.normal, -standoff);
    quaternion.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(position, gate.position, new THREE.Vector3(0, 1, 0)),
    );
    return true;
  }

  seek(t: number): void {
    this.course.reset();
    const index = Math.min(
      this.course.gates.length - 1,
      Math.floor(clamp01(t) * this.course.gates.length),
    );
    for (let gateIndex = 0; gateIndex < index; gateIndex++) {
      this.course.gates[gateIndex]!.setState('cleared');
    }
    this.course.nextIndex = index;
    this.course.gates[index]?.setState('armed');
  }

  setVantageState(gateIndex: number | undefined, atTerminus: boolean): void {
    if (gateIndex !== undefined) {
      this.course.reset();
      for (let index = 0; index < gateIndex; index++) {
        this.course.gates[index]!.setState('cleared');
      }
      this.course.nextIndex = gateIndex;
      this.course.gates[gateIndex]?.setState('armed');
    } else if (atTerminus) {
      this.course.reset();
      for (const gate of this.course.gates) gate.setState('cleared');
      this.course.nextIndex = this.course.gates.length;
    }
  }

  stageContact(kind: LegacyStagedContact['kind']): LegacyStagedContact | null {
    if (kind === 'debris') this.resetMotion();
    for (let index = this.world.contacts.length - 1; index >= 0; index--) {
      const contact = this.world.contacts[index]!;
      if (contact.kind !== kind) continue;
      const rawId = kind === 'debris'
        ? Number(contact.id.slice('debris:'.length))
        : contact.id.slice('landmark:'.length);
      return {
        id: rawId,
        kind,
        position: contact.position,
        radius: contact.radius,
      };
    }
    return null;
  }

  hazard(samples: number, consumedContacts: readonly WorldContact[] | null): HazardReport {
    const nodes = [
      this.course.startPosition.clone(),
      ...this.course.gates.map((gate) => gate.position.clone()),
      this.course.terminusPosition.clone(),
    ];
    const asteroids = this.world.components.asteroids;
    const rocks = asteroids.activeInstances;
    const point = new THREE.Vector3();
    const clearances: number[] = [];
    const perSegment = Math.max(2, Math.floor(samples / (nodes.length - 1)));

    for (let index = 0; index < nodes.length - 1; index++) {
      for (let sample = 0; sample < perSegment; sample++) {
        point.lerpVectors(nodes[index]!, nodes[index + 1]!, sample / (perSegment - 1));
        let nearest = Infinity;
        for (const rock of rocks) {
          nearest = Math.min(nearest, point.distanceTo(rock.position) - rock.radius);
        }
        clearances.push(nearest);
      }
    }

    const sorted = [...clearances].sort((a, b) => a - b);
    const at = (fraction: number): number => sorted[
      Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
    ]!;
    return {
      activeRocks: rocks.length,
      gameplayRocks: asteroids.instances.filter((rock) => rock.gameplay).length,
      totalRocks: asteroids.instances.length,
      minClearance: +sorted[0]!.toFixed(1),
      p05Clearance: +at(0.05).toFixed(1),
      medianClearance: +at(0.5).toFixed(1),
      tightFraction: +(clearances.filter((clearance) => clearance < 200).length
        / clearances.length).toFixed(3),
      colliderSharesDrawnList: consumedContacts === null
        ? null
        : consumedContacts === this.world.contacts,
      motion: asteroids.getMotionReport(),
    };
  }

  crossings(): ReturnType<LegacyMissionAdapter['crossings']> {
    return this.course.crossings.map((event) => ({
      index: event.index,
      time: event.time,
      radialDistance: event.radialDistance,
      normalizedOffset: event.offset,
      speed: event.speed,
      cleared: event.cleared,
      blockedBy: event.blockedBy,
    }));
  }

  stageShearBlock(elapsed: number, speed: number): ReturnType<LegacyMissionAdapter['stageShearBlock']> {
    const gate = this.course.nextGate;
    if (!gate || !this.course.shear || this.course.shear.phaseAt(gate.index, elapsed) === null) {
      return null;
    }
    this.scratch.copy(gate.position).addScaledVector(gate.normal, -2);
    this.scratchB.copy(gate.position).addScaledVector(gate.normal, 2);
    this.course.update(this.scratch, speed, elapsed);
    this.course.update(this.scratchB, speed, elapsed);
    const crossing = this.crossings().at(-1);
    return crossing?.blockedBy === 'shear' ? crossing : null;
  }

  shearState(elapsed: number): ReturnType<LegacyMissionAdapter['shearState']> {
    return this.course.getShearDebug(elapsed);
  }

  landmarkState(): HarnessStageLandmarkState {
    return this.world.components.landmarks.getDebugState();
  }
}

/** Default shipped world factory. A custom factory bypasses this function entirely. */
export const createCairnMissionRuntime: GameMissionRuntimeFactory = (context) => {
  const definition = context.definition;
  if (definition.objective.kind !== 'gate-race') {
    throw new Error('The shipped CAIRN factory requires a gate-race definition');
  }
  const courseDefinition = definition.objective.gates;
  const sunDirection = context.lighting.uSunDir.value.clone();
  const nebula = bakeNebula(context.renderer, {
    resolution: context.initialQuality.nebulaSteps >= 20
      ? 1024
      : context.initialQuality.nebulaSteps >= 12 ? 768 : 512,
    octaves: context.initialQuality.nebulaSteps >= 20
      ? 6
      : context.initialQuality.nebulaSteps >= 12 ? 5 : 4,
    seed: (context.seed % 97) * 0.37,
    sunDirection,
  });
  context.farScene.background = nebula.texture;

  const starfield = new Starfield(context.maximumQuality.starCount, 90, context.seed ^ 0x51ed);
  context.farScene.add(starfield.object);
  const star = new Star(60, Math.atan(SCALE.starRadius / SCALE.starDistance), sunDirection);
  context.farScene.add(star.object);

  const planetDirection = courseDefinition.world.planetDirection;
  const planet = new Planet({
    distance: 40,
    angularRadius: Math.atan(SCALE.planetRadius / SCALE.planetDistance),
    direction: new THREE.Vector3(
      planetDirection[0],
      planetDirection[1],
      planetDirection[2],
    ).normalize(),
    sunDirection,
    rings: courseDefinition.world.planetRings,
  });
  context.farScene.add(planet.object);

  const course = new Course(courseDefinition, context.seed, context.lighting);
  context.mainScene.add(course.object);
  const terminus = new Terminus({
    position: course.terminusPosition,
    normal: course.terminusNormal,
    lighting: context.lighting,
    seed: context.seed ^ 0x7f31,
    apertureRadius: courseDefinition.destination.apertureRadius,
    palette: courseDefinition.destination,
  });
  context.mainScene.add(terminus.object);

  const landmarks = new StageLandmarks({
    kind: courseDefinition.world.landmarkKind,
    lighting: context.lighting,
    seed: context.seed ^ 0x5bd1,
    anchors: buildStageLandmarkAnchors(course.path, courseDefinition),
    protectedChannel: course.clearChannel,
  });
  context.mainScene.add(landmarks.object);

  const asteroids = new AsteroidField({
    count: context.maximumQuality.asteroidCount,
    lighting: context.lighting,
    spine: course.spine,
    spread: SCALE.asteroidFieldRadius * courseDefinition.field.spreadFraction,
    corridor: courseDefinition.field.corridor,
    minRadius: courseDefinition.field.minRadius,
    maxRadius: courseDefinition.field.maxRadius,
    hazardCount: courseDefinition.field.hazardCount,
    hazardBand: courseDefinition.field.hazardBand,
    keepClearSegments: course.clearChannel,
    keepClear: [
      {
        center: course.startPosition.clone(),
        radius: courseDefinition.field.startKeepClearRadius,
      },
      ...course.gates.map((gate) => ({
        center: gate.position.clone(),
        radius: gate.radius * courseDefinition.field.gateKeepClearScale,
      })),
      ...landmarks.colliders.map((collider) => ({
        center: new THREE.Vector3(collider.center[0], collider.center[1], collider.center[2]),
        radius: collider.radius + courseDefinition.field.minRadius,
      })),
    ],
    seed: context.seed ^ 0x2f19,
  });
  context.mainScene.add(asteroids.object);

  const derelicts = new DerelictField({
    lighting: context.lighting,
    spine: course.spine,
    seed: context.seed ^ 0x1a77,
    count: courseDefinition.world.derelictCount,
  });
  context.mainScene.add(derelicts.object);
  const dust = new DustField(context.maximumQuality.dustCount, 1100, context.seed ^ 0x99ab);
  context.mainScene.add(dust.object);

  const objective = new GateRaceObjective(
    course,
    terminus.apertureRadius * 2.4,
    definition,
  );
  const world = new World({
    starfield,
    star,
    planet,
    nebulaTarget: nebula.target,
    asteroids,
    derelicts,
    landmarks,
    dust,
    terminus,
    course,
  });
  return new MissionRuntime({
    definition,
    path: course.path,
    world,
    objective,
    legacy: new CairnLegacyAdapter(course, world),
  });
};
