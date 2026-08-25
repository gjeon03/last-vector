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
import type { FlightPath } from '../FlightPath.ts';
import type { DeadSignalState } from './DeadSignalState.ts';

interface DisposableTarget {
  dispose(): void;
}

export const DEAD_SIGNAL_STRUCTURE_CONTACT_COUNT = 32;
const STRUCTURE_BANKS = 8;
const STRUCTURE_ARMS = 4;
const STRUCTURE_RADIUS = 150;

/** Fixed spherical proxies for the major ring/pylon masses, leaving the centre opening clear. */
export function buildDeadSignalStructureContacts(path: FlightPath): readonly WorldContact[] {
  const contacts: WorldContact[] = [];
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const radial = new THREE.Vector3();
  for (let bank = 0; bank < STRUCTURE_BANKS; bank++) {
    const pathT = 0.27 + bank * 0.069;
    path.poseAt(pathT, position, quaternion);
    right.set(1, 0, 0).applyQuaternion(quaternion).normalize();
    up.set(0, 1, 0).applyQuaternion(quaternion).normalize();
    for (let arm = 0; arm < STRUCTURE_ARMS; arm++) {
      const angle = arm * Math.PI * 0.5 + bank * 0.22;
      const ringRadius = 720 + (bank % 2) * 120;
      radial.copy(right).multiplyScalar(Math.cos(angle) * ringRadius)
        .addScaledVector(up, Math.sin(angle) * ringRadius);
      contacts.push(Object.freeze({
        id: `black-array-structure-${bank + 1}-${arm + 1}`,
        kind: 'landmark' as const,
        position: position.clone().add(radial),
        radius: STRUCTURE_RADIUS,
      }));
    }
  }
  if (contacts.length !== DEAD_SIGNAL_STRUCTURE_CONTACT_COUNT) {
    throw new Error('DEAD SIGNAL structure contact authoring drifted');
  }
  return Object.freeze(contacts);
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
    path: FlightPath;
  }) {
    this.starfield = options.starfield;
    this.star = options.star;
    this.planet = options.planet;
    this.nebulaTarget = options.nebulaTarget;
    this.dust = options.dust;
    this.facility = options.facility;
    this.effects = options.effects;
    this.targetables = options.state.targets;
    // Damageable targets stay non-colliding so correct centreline aim is viable. Major ring/pylon
    // masses publish fixed off-axis proxies around the openings instead of making the whole array
    // intangible.
    this.contacts = buildDeadSignalStructureContacts(options.path);
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
