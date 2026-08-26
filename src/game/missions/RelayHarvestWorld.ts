import * as THREE from 'three';
import { SCALE } from '../../core/art.ts';
import type { QualityProfile } from '../../core/Settings.ts';
import type { AsteroidField, AsteroidInstance } from '../../render/Asteroids.ts';
import { DustField } from '../../render/Dust.ts';
import {
  HarvestCellField,
  type HarvestCellFieldDebug,
  type HarvestCellSourceView,
} from '../../render/HarvestCellField.ts';
import { bakeNebula } from '../../render/Nebula.ts';
import { Planet } from '../../render/Planet.ts';
import { Star } from '../../render/Star.ts';
import { Starfield } from '../../render/Starfield.ts';
import { DerelictField, ShelfSpan } from '../../render/Structures.ts';
import type { LightingUniforms } from '../../render/lighting.ts';
import type { FlightPath } from '../FlightPath.ts';
import type {
  MissionWorldRuntime,
  WorldContact,
  WorldPresentationFrame,
} from '../MissionRuntime.ts';

export interface RelayHarvestWorldOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly farScene: THREE.Scene;
  readonly mainScene: THREE.Scene;
  readonly path: FlightPath;
  readonly asteroids: AsteroidField;
  readonly sources: readonly HarvestCellSourceView[];
  readonly seed: number;
  readonly lighting: LightingUniforms;
  readonly initialQuality: QualityProfile;
  readonly maximumQuality: QualityProfile;
}

/** HARVEST over THE SPLINTER terrain: one dense world, ten live cells, no arena wreck banks. */
export class RelayHarvestWorld implements MissionWorldRuntime {
  readonly contacts: WorldContact[] = [];
  readonly contactCapacity: number;
  readonly targetables: readonly unknown[] = Object.freeze([]);

  private readonly farScene: THREE.Scene;
  private readonly mainScene: THREE.Scene;
  private readonly previousBackground: THREE.Scene['background'];
  private readonly nebulaTarget: THREE.WebGLCubeRenderTarget;
  private readonly starfield: Starfield;
  private readonly star: Star;
  private readonly planet: Planet;
  private readonly asteroids: AsteroidField;
  private readonly derelicts: DerelictField;
  private readonly shelfSpan: ShelfSpan;
  private readonly dust: DustField;
  private readonly cells: HarvestCellField;
  private readonly asteroidContacts = new Map<AsteroidInstance, WorldContact>();
  private readonly sources: readonly HarvestCellSourceView[];

  constructor(options: RelayHarvestWorldOptions) {
    this.farScene = options.farScene;
    this.mainScene = options.mainScene;
    this.previousBackground = options.farScene.background;
    this.sources = options.sources;
    this.asteroids = options.asteroids;

    const sunDirection = options.lighting.uSunDir.value.clone();
    const nebula = bakeNebula(options.renderer, {
      resolution: options.initialQuality.nebulaSteps >= 20
        ? 1024
        : options.initialQuality.nebulaSteps >= 12 ? 768 : 512,
      octaves: options.initialQuality.nebulaSteps >= 20
        ? 6
        : options.initialQuality.nebulaSteps >= 12 ? 5 : 4,
      seed: ((options.seed + 61) % 97) * 0.37,
      sunDirection,
    });
    this.nebulaTarget = nebula.target;
    options.farScene.background = nebula.texture;

    this.starfield = new Starfield(
      options.maximumQuality.starCount,
      90,
      options.seed ^ 0x51ed,
    );
    this.star = new Star(
      60,
      Math.atan(SCALE.starRadius / SCALE.starDistance) * 0.62,
      sunDirection,
    );
    // THE SPLINTER reference hid VESPER, but this chapter keeps the ringed planet because the
    // requested HARVEST composition explicitly calls for a planetary landmark in the field.
    this.planet = new Planet({
      distance: 40,
      angularRadius: Math.atan(SCALE.planetRadius / SCALE.planetDistance),
      direction: new THREE.Vector3(0.68, -0.2, -0.7).normalize(),
      sunDirection,
      rings: true,
    });

    this.derelicts = new DerelictField({
      lighting: options.lighting,
      spine: options.path.spine,
      seed: options.seed ^ 0x1a77,
      count: 7,
    });
    const spanIndex = Math.floor(options.path.spine.length * 0.5);
    const spanAnchor = options.path.spine[spanIndex]!;
    const spanAhead = options.path.spine[Math.min(options.path.spine.length - 1, spanIndex + 6)]!;
    const spanForward = new THREE.Vector3().subVectors(spanAhead, spanAnchor).normalize();
    const spanRight = new THREE.Vector3()
      .crossVectors(spanForward, new THREE.Vector3(0, 1, 0))
      .normalize();
    this.shelfSpan = new ShelfSpan({
      lighting: options.lighting,
      position: spanAnchor.clone()
        .addScaledVector(spanRight, 5_200)
        .addScaledVector(spanForward, 2_600)
        .add(new THREE.Vector3(0, -900, 0)),
      seed: options.seed ^ 0x5bd1,
    });
    this.dust = new DustField(options.maximumQuality.dustCount, 1_100, options.seed ^ 0x99ab);
    this.cells = new HarvestCellField(options.sources.length);

    for (const asteroid of this.asteroids.instances) {
      this.asteroidContacts.set(asteroid, {
        id: `debris:${asteroid.id}`,
        kind: 'debris',
        position: asteroid.position,
        radius: asteroid.radius,
      });
    }
    this.contactCapacity = this.asteroids.instances.length;

    options.farScene.add(this.starfield.object, this.star.object, this.planet.object);
    options.mainScene.add(
      this.asteroids.object,
      this.derelicts.object,
      this.shelfSpan.object,
      this.dust.object,
      this.cells.object,
    );
    this.applyQuality(options.initialQuality, options.maximumQuality);
  }

  reset(): void {
    this.asteroids.resetMotion();
    this.cells.reset();
  }

  updateSimulation(_dt: number, _shipPosition: THREE.Vector3): void {
    // Reference HARVEST rocks are static collision geometry; only their cosmetic tumble updates.
  }

  updatePresentation(frame: WorldPresentationFrame): void {
    this.starfield.setViewportHeight(frame.viewportHeight);
    this.starfield.update(frame.clock);
    this.star.update(frame.clock, frame.farCamera);
    this.planet.update(frame.clock);
    this.asteroids.update(frame.dt, frame.camera.position);
    this.derelicts.update(frame.clock, frame.camera.position);
    this.shelfSpan.update(frame.clock, frame.camera.position);
    this.cells.update(
      this.sources,
      frame.dt,
      frame.camera.position,
      frame.viewportHeight,
      THREE.MathUtils.degToRad(frame.camera.fov),
    );

    const stretch = 0.008 + frame.speed01 * 0.026 + frame.boostBlend * 0.055;
    const opacity = 0.02
      + frame.speed01 * frame.speed01 * frame.speed01 * 0.34
      + frame.boostBlend * 0.34;
    this.dust.update(
      frame.shipPosition,
      frame.shipVelocity,
      frame.camera.position,
      stretch,
      opacity,
    );
  }

  applyQuality(profile: QualityProfile, maximum: QualityProfile): void {
    this.starfield.setVisibleCount(profile.starCount);
    this.dust.setVisibleCount(profile.dustCount);
    this.asteroids.setVisibleFraction(profile.asteroidCount / maximum.asteroidCount);
    this.syncContacts();
  }

  getRenderDebugState(): HarvestCellFieldDebug {
    return this.cells.getDebugState();
  }

  dispose(): void {
    this.farScene.remove(this.starfield.object, this.star.object, this.planet.object);
    this.mainScene.remove(
      this.asteroids.object,
      this.derelicts.object,
      this.shelfSpan.object,
      this.dust.object,
      this.cells.object,
    );
    if (this.farScene.background === this.nebulaTarget.texture) {
      this.farScene.background = this.previousBackground;
    }
    this.starfield.dispose();
    this.star.dispose();
    this.planet.dispose();
    this.nebulaTarget.dispose();
    this.asteroids.dispose();
    this.derelicts.dispose();
    this.shelfSpan.dispose();
    this.dust.dispose();
    this.cells.dispose();
  }

  private syncContacts(): void {
    this.contacts.length = 0;
    for (const asteroid of this.asteroids.activeInstances) {
      const contact = this.asteroidContacts.get(asteroid);
      if (contact) this.contacts.push(contact);
    }
  }
}
