import * as THREE from 'three';
import type { QualityProfile } from '../../core/Settings.ts';
import { DustField } from '../../render/Dust.ts';
import { LastAscentCelestials } from '../../render/LastAscentCelestials.ts';
import { LastAscentDebris } from '../../render/LastAscentDebris.ts';
import {
  LastAscentLaunchStructure,
  LastAscentShockfront,
} from '../../render/LastAscentStructures.ts';
import { Star } from '../../render/Star.ts';
import { Starfield } from '../../render/Starfield.ts';
import type {
  MissionWorldRuntime,
  WorldContact,
  WorldPresentationFrame,
} from '../MissionRuntime.ts';
import type { FlightPath } from '../FlightPath.ts';
import type { MissionDefinition } from '../../core/Missions.ts';
import type { LastAscentCheckpointFrame } from './LastAscentObjective.ts';

interface LastAscentWorldOptions {
  readonly farScene: THREE.Scene;
  readonly mainScene: THREE.Scene;
  readonly definition: MissionDefinition;
  readonly path: FlightPath;
  readonly checkpoints: readonly LastAscentCheckpointFrame[];
  readonly seed: number;
  readonly maximumQuality: QualityProfile;
}

/** Selected Chapter 02 world only; it never owns objective, storage or interface state. */
export class LastAscentWorld implements MissionWorldRuntime {
  readonly contacts: readonly WorldContact[];
  readonly contactCapacity = 20;
  readonly targetables: readonly unknown[] = Object.freeze([]);

  private readonly farScene: THREE.Scene;
  private readonly mainScene: THREE.Scene;
  private readonly starfield: Starfield;
  private readonly star: Star;
  private readonly celestials: LastAscentCelestials;
  private readonly debris: LastAscentDebris;
  private readonly launch: LastAscentLaunchStructure;
  private readonly shockfront: LastAscentShockfront;
  private readonly dust: DustField;
  private readonly maximumQuality: QualityProfile;

  constructor(options: LastAscentWorldOptions) {
    this.farScene = options.farScene;
    this.mainScene = options.mainScene;
    this.maximumQuality = options.maximumQuality;
    this.starfield = new Starfield(options.maximumQuality.starCount, 90, options.seed ^ 0x27ac);
    this.star = new Star(
      65,
      0.012,
      new THREE.Vector3(-0.32, 0.42, -0.85).normalize(),
    );
    this.celestials = new LastAscentCelestials();
    this.debris = new LastAscentDebris(options.path, options.checkpoints, options.seed);
    this.launch = new LastAscentLaunchStructure(options.path);
    this.shockfront = new LastAscentShockfront(options.path, options.definition);
    this.dust = new DustField(options.maximumQuality.dustCount, 1250, options.seed ^ 0x440f);
    this.contacts = this.debris.contacts;
    if (this.contacts.length !== this.contactCapacity || this.debris.collisionBatchCount > 4) {
      throw new Error('LAST ASCENT debris contract exceeded its fixed limits');
    }

    this.farScene.background = new THREE.Color(0x020814);
    this.farScene.add(this.starfield.object, this.star.object, this.celestials.object);
    this.mainScene.add(
      this.launch.object,
      this.debris.object,
      this.shockfront.object,
      this.dust.object,
    );
  }

  reset(): void {
    this.debris.reset();
  }

  updateSimulation(dt: number, _shipPosition: THREE.Vector3): void {
    this.debris.updateSimulation(dt);
  }

  updatePresentation(frame: WorldPresentationFrame): void {
    this.starfield.setViewportHeight(frame.viewportHeight);
    this.starfield.update(frame.clock);
    this.star.update(frame.clock, frame.farCamera);
    this.celestials.update(frame.clock);
    this.debris.updatePresentation();
    this.launch.update(frame.clock);
    this.shockfront.update(frame.runTime);
    const stretch = 0.012 + frame.speed01 * 0.034 + frame.boostBlend * 0.07;
    const opacity = 0.025 + frame.speed01 ** 3 * 0.36 + frame.boostBlend * 0.38;
    this.dust.update(
      frame.shipPosition,
      frame.shipVelocity,
      frame.camera.position,
      stretch,
      opacity,
    );
  }

  applyQuality(profile: QualityProfile, _maximum: QualityProfile): void {
    this.starfield.setVisibleCount(profile.starCount);
    this.dust.setVisibleCount(profile.dustCount);
    this.debris.setDecorativeFraction(
      profile.asteroidCount / Math.max(1, this.maximumQuality.asteroidCount),
    );
  }

  dispose(): void {
    this.farScene.remove(this.starfield.object, this.star.object, this.celestials.object);
    this.mainScene.remove(
      this.launch.object,
      this.debris.object,
      this.shockfront.object,
      this.dust.object,
    );
    this.starfield.dispose();
    this.star.dispose();
    this.celestials.dispose();
    this.debris.dispose();
    this.launch.dispose();
    this.shockfront.dispose();
    this.dust.dispose();
  }
}
