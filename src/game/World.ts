import * as THREE from 'three';
import type { QualityProfile } from '../core/Settings.ts';
import type { AsteroidField, AsteroidInstance } from '../render/Asteroids.ts';
import type { DustField } from '../render/Dust.ts';
import type { Planet } from '../render/Planet.ts';
import type { StageLandmarks } from '../render/StageLandmarks.ts';
import type { Star } from '../render/Star.ts';
import type { Starfield } from '../render/Starfield.ts';
import type { DerelictField, Terminus } from '../render/Structures.ts';
import type { Course } from './Course.ts';
import type {
  MissionWorldRuntime,
  WorldContact,
  WorldPresentationFrame,
} from './MissionRuntime.ts';

interface Disposable {
  dispose(): void;
}

export interface WorldComponents {
  readonly starfield: Starfield;
  readonly star: Star;
  readonly planet: Planet;
  readonly nebulaTarget: Disposable;
  readonly asteroids: AsteroidField;
  readonly derelicts: DerelictField;
  readonly landmarks: StageLandmarks;
  readonly dust: DustField;
  readonly terminus: Terminus;
  readonly course: Course;
}

/** Owns current mission render resources and world simulation, never objective or interface state. */
export class World implements MissionWorldRuntime {
  readonly contacts: WorldContact[] = [];
  readonly contactCapacity: number;
  readonly targetables: readonly unknown[] = Object.freeze([]);
  readonly components: WorldComponents;

  private readonly asteroidContacts = new Map<AsteroidInstance, WorldContact>();
  private readonly landmarkContacts: readonly WorldContact[];

  constructor(components: WorldComponents) {
    this.components = components;
    for (const asteroid of components.asteroids.instances) {
      this.asteroidContacts.set(asteroid, {
        id: `debris:${asteroid.id}`,
        kind: 'debris',
        position: asteroid.position,
        radius: asteroid.radius,
      });
    }
    this.landmarkContacts = components.landmarks.colliders.map((collider) => ({
      id: `landmark:${collider.id}`,
      kind: 'landmark',
      position: new THREE.Vector3(collider.center[0], collider.center[1], collider.center[2]),
      radius: collider.radius,
    }));
    this.contactCapacity = components.asteroids.instances.length + this.landmarkContacts.length;
    this.syncContacts();
  }

  private syncContacts(): void {
    this.contacts.length = 0;
    for (const asteroid of this.components.asteroids.activeInstances) {
      const contact = this.asteroidContacts.get(asteroid);
      if (contact) this.contacts.push(contact);
    }
    this.contacts.push(...this.landmarkContacts);
  }

  reset(): void {
    this.components.asteroids.resetMotion();
  }

  updateSimulation(dt: number, shipPosition: THREE.Vector3): void {
    this.components.asteroids.updateMotion(dt, shipPosition);
  }

  updatePresentation(frame: WorldPresentationFrame): void {
    const world = this.components;
    world.starfield.setViewportHeight(frame.viewportHeight);
    world.starfield.update(frame.clock);
    world.star.update(frame.clock, frame.farCamera);
    world.planet.update(frame.clock);
    world.asteroids.update(frame.dt, frame.camera.position);
    world.derelicts.update(frame.clock, frame.camera.position);
    world.landmarks.update(frame.clock, frame.camera.position);
    world.landmarks.setPixelScale(frame.pixelScale);
    world.terminus.update(frame.clock, frame.camera.position, frame.pixelScale);
    world.course.update3d(
      frame.dt,
      frame.clock,
      frame.runTime,
      frame.camera.position,
      frame.pixelScale,
    );
    const stretch = 0.008 + frame.speed01 * 0.026 + frame.boostBlend * 0.055;
    const opacity = 0.02
      + frame.speed01 * frame.speed01 * frame.speed01 * 0.34
      + frame.boostBlend * 0.34;
    world.dust.update(
      frame.shipPosition,
      frame.shipVelocity,
      frame.camera.position,
      stretch,
      opacity,
    );
  }

  applyQuality(profile: QualityProfile, maximum: QualityProfile): void {
    this.components.starfield.setVisibleCount(profile.starCount);
    this.components.dust.setVisibleCount(profile.dustCount);
    this.components.asteroids.setVisibleFraction(profile.asteroidCount / maximum.asteroidCount);
    this.syncContacts();
  }

  dispose(): void {
    const world = this.components;
    world.starfield.dispose();
    world.star.dispose();
    world.planet.dispose();
    world.nebulaTarget.dispose();
    world.asteroids.dispose();
    world.derelicts.dispose();
    world.landmarks.dispose();
    world.dust.dispose();
    world.terminus.dispose();
  }
}
