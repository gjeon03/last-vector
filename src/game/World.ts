import * as THREE from 'three';
import type { QualityProfile } from '../core/Settings.ts';
import type { AsteroidField } from '../render/Asteroids.ts';
import type { DustField } from '../render/Dust.ts';
import type { Planet } from '../render/Planet.ts';
import type { StageLandmarks } from '../render/StageLandmarks.ts';
import type { Star } from '../render/Star.ts';
import type { Starfield } from '../render/Starfield.ts';
import type { DerelictField, Terminus } from '../render/Structures.ts';
import type { Course } from './Course.ts';
import type { MissionWorldRuntime } from './MissionRuntime.ts';

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

export interface WorldPresentationFrame {
  readonly dt: number;
  readonly clock: number;
  readonly runTime: number;
  readonly camera: THREE.PerspectiveCamera;
  readonly farCamera: THREE.PerspectiveCamera;
  readonly pixelScale: number;
  readonly viewportHeight: number;
  readonly shipPosition: THREE.Vector3;
  readonly shipVelocity: THREE.Vector3;
  readonly speed01: number;
  readonly boostBlend: number;
}

/** Owns current mission render resources and world simulation, never objective or interface state. */
export class World implements MissionWorldRuntime {
  readonly colliderSets: readonly (readonly unknown[])[];
  readonly targetables: readonly unknown[] = Object.freeze([]);
  readonly components: WorldComponents;

  constructor(components: WorldComponents) {
    this.components = components;
    this.colliderSets = Object.freeze([
      components.asteroids.activeInstances,
      components.landmarks.colliders,
    ]);
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
