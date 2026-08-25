import * as THREE from 'three';
import type { QualityProfile } from '../../core/Settings.ts';
import { DustField } from '../../render/Dust.ts';
import {
  RelayHarvestField,
  type RelayHarvestFieldDebug,
  type RelayHarvestSourceView,
} from '../../render/RelayHarvestField.ts';
import { Star } from '../../render/Star.ts';
import { Starfield } from '../../render/Starfield.ts';
import type { LightingUniforms } from '../../render/lighting.ts';
import type {
  MissionWorldRuntime,
  WorldContact,
  WorldPresentationFrame,
} from '../MissionRuntime.ts';

export interface RelayHarvestWorldOptions {
  readonly farScene: THREE.Scene;
  readonly mainScene: THREE.Scene;
  readonly sources: readonly RelayHarvestSourceView[];
  readonly seed: number;
  readonly lighting: LightingUniforms;
  readonly initialQuality: QualityProfile;
  readonly maximumQuality: QualityProfile;
}

/** Static Chapter 02 world owner. Collection sources intentionally never enter contacts. */
export class RelayHarvestWorld implements MissionWorldRuntime {
  readonly contacts: readonly WorldContact[];
  readonly contactCapacity: number;
  readonly targetables: readonly unknown[] = Object.freeze([]);

  private readonly farScene: THREE.Scene;
  private readonly mainScene: THREE.Scene;
  private readonly previousBackground: THREE.Scene['background'];
  private readonly background = new THREE.Color(0x020b18);
  private readonly starfield: Starfield;
  private readonly star: Star;
  private readonly dust: DustField;
  private readonly field: RelayHarvestField;

  constructor(options: RelayHarvestWorldOptions) {
    this.farScene = options.farScene;
    this.mainScene = options.mainScene;
    this.previousBackground = options.farScene.background;
    this.starfield = new Starfield(
      options.maximumQuality.starCount,
      90,
      options.seed ^ 0x4b1ac7,
    );
    this.star = new Star(
      62,
      0.013,
      options.lighting.uSunDir.value,
    );
    this.dust = new DustField(
      options.maximumQuality.dustCount,
      1_150,
      options.seed ^ 0x7e1a9,
    );
    this.field = new RelayHarvestField({
      sources: options.sources,
      lighting: options.lighting,
    });
    this.contacts = Object.freeze(this.field.colliders.map((collider) => Object.freeze({
      id: collider.id,
      kind: 'landmark' as const,
      position: collider.position,
      radius: collider.radius,
    })));
    this.contactCapacity = this.contacts.length;

    options.farScene.background = this.background;
    options.farScene.add(this.starfield.object, this.star.object);
    options.mainScene.add(this.field.object, this.dust.object);
    this.applyQuality(options.initialQuality, options.maximumQuality);
  }

  reset(): void {
    this.field.reset();
  }

  updateSimulation(_dt: number, _shipPosition: THREE.Vector3): void {
    // The relay structure and its bounded contact proxies are static.
  }

  updatePresentation(frame: WorldPresentationFrame): void {
    this.starfield.setViewportHeight(frame.viewportHeight);
    this.starfield.update(frame.clock);
    this.star.update(frame.clock, frame.farCamera);
    this.field.update(frame.runTime, frame.camera.position);
    const stretch = 0.01 + frame.speed01 * 0.034 + frame.boostBlend * 0.066;
    const opacity = 0.025 + frame.speed01 * frame.speed01 * frame.speed01 * 0.32
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
    this.field.applyQuality(profile, maximum);
  }

  getRenderDebugState(): RelayHarvestFieldDebug {
    return this.field.getDebugState();
  }

  dispose(): void {
    this.farScene.remove(this.starfield.object, this.star.object);
    this.mainScene.remove(this.field.object, this.dust.object);
    if (this.farScene.background === this.background) {
      this.farScene.background = this.previousBackground;
    }
    this.starfield.dispose();
    this.star.dispose();
    this.dust.dispose();
    this.field.dispose();
  }
}
