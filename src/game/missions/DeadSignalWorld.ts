import * as THREE from 'three';
import type { QualityProfile } from '../../core/Settings.ts';
import { DustField } from '../../render/Dust.ts';
import type { DeadSignalEffects } from '../../render/DeadSignalEffects.ts';
import type { DeadSignalFacility } from '../../render/DeadSignalFacility.ts';
import type { Planet } from '../../render/Planet.ts';
import type { Star } from '../../render/Star.ts';
import type { Starfield } from '../../render/Starfield.ts';
import type {
  MissionWorldRuntime,
  WorldContact,
  WorldPresentationFrame,
} from '../MissionRuntime.ts';
import type { DeadSignalState } from './DeadSignalState.ts';

interface DisposableTarget {
  dispose(): void;
}

/** Chapter03-only world owner. It constructs no CAIRN/WRECKLINE/RINGFALL runtime. */
export class DeadSignalWorld implements MissionWorldRuntime {
  readonly contacts: readonly WorldContact[];
  readonly contactCapacity: number;
  readonly targetables: DeadSignalState['targets'];

  private readonly starfield: Starfield;
  private readonly star: Star;
  private readonly planet: Planet;
  private readonly nebulaTarget: DisposableTarget;
  private readonly dust: DustField;
  private readonly facility: DeadSignalFacility;
  private readonly effects: DeadSignalEffects;

  constructor(options: {
    starfield: Starfield;
    star: Star;
    planet: Planet;
    nebulaTarget: DisposableTarget;
    dust: DustField;
    facility: DeadSignalFacility;
    effects: DeadSignalEffects;
    state: DeadSignalState;
  }) {
    this.starfield = options.starfield;
    this.star = options.star;
    this.planet = options.planet;
    this.nebulaTarget = options.nebulaTarget;
    this.dust = options.dust;
    this.facility = options.facility;
    this.effects = options.effects;
    this.targetables = options.state.targets;
    // Target housings sit on the authored centreline so a clean pulse pass can read and hit them.
    // Making that same centre point a hull collider turns correct aim into a mandatory collision;
    // the fixed facility is therefore presentation/weapon geometry, not a rigid-body field.
    this.contacts = Object.freeze([]);
    this.contactCapacity = this.contacts.length;
  }

  reset(): void {
    this.effects.reset();
  }

  updateSimulation(_dt: number, _shipPosition: THREE.Vector3): void {
    // The array and every target are fixed. Only pooled presentation effects move.
  }

  updatePresentation(frame: WorldPresentationFrame): void {
    this.starfield.setViewportHeight(frame.viewportHeight);
    this.starfield.update(frame.clock);
    this.star.update(frame.clock, frame.farCamera);
    this.planet.update(frame.clock);
    this.facility.update(frame.clock, frame.camera.position, frame.shipPosition);
    this.effects.update(frame.dt);
    const stretch = 0.012 + frame.speed01 * 0.035 + frame.boostBlend * 0.06;
    const opacity = 0.035 + frame.speed01 * 0.28 + frame.boostBlend * 0.3;
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
  }

  dispose(): void {
    this.starfield.dispose();
    this.star.dispose();
    this.planet.dispose();
    this.nebulaTarget.dispose();
    this.dust.dispose();
    this.facility.dispose();
    this.effects.dispose();
  }
}
