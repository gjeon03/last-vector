import type { CourseDefinition, FlightPathDefinition } from '../../core/Courses.ts';
import { CURRENT_FLIGHT_RULESET_VERSION, RINGFALL, WRECKLINE } from '../../core/Courses.ts';
import type { MissionDefinition, StrikeObjectiveDefinition } from '../../core/Missions.ts';
import { hashSeed } from '../../core/rng.ts';

export type DeadSignalTargetKind = 'calibration' | 'shield' | 'core';

export interface DeadSignalTargetDefinition {
  readonly id: string;
  readonly kind: DeadSignalTargetKind;
  readonly required: boolean;
  readonly hitPoints: number;
  readonly pathT: number;
  readonly rightOffset: number;
  readonly upOffset: number;
  readonly forwardOffset: number;
  readonly radius: number;
}

export interface DeadSignalStrikeDefinition extends StrikeObjectiveDefinition {
  readonly targets: readonly DeadSignalTargetDefinition[];
  readonly shieldRequired: number;
  readonly coreBoundaryProgress: number;
  readonly coreWindowEndProgress: number;
  readonly finalBlastDeadlineSeconds: number;
}

export interface DeadSignalMissionDefinition extends Omit<MissionDefinition, 'objective'> {
  readonly objective: DeadSignalStrikeDefinition;
}

/**
 * A 69 km forward line: broad ingress, six offset node presentations, a straight core pass,
 * then two authored extraction turns. The renderer uses the same retained industrial scale and
 * palette vocabulary as WRECKLINE/RINGFALL without constructing either retired world.
 */
export const DEAD_SIGNAL_PATH: FlightPathDefinition = Object.freeze({
  legs: Object.freeze([
    { turn: 0.04, climb: -0.02, length: 1.05, bank: 0.02, clearance: 520, label: 'eclipse ingress' },
    { turn: -0.12, climb: 0.06, length: 1.0, bank: -0.08, clearance: 500, label: 'calibration' },
    { turn: 0.18, climb: -0.08, length: 1.08, bank: 0.14, clearance: 470, label: 'shield one' },
    { turn: -0.22, climb: 0.1, length: 1.0, bank: -0.18, clearance: 460, label: 'shield two' },
    { turn: 0.16, climb: 0.06, length: 1.12, bank: 0.12, clearance: 470, label: 'shield three' },
    { turn: -0.2, climb: -0.1, length: 1.0, bank: -0.16, clearance: 455, label: 'shield four' },
    { turn: 0.22, climb: -0.04, length: 1.08, bank: 0.18, clearance: 460, label: 'shield five' },
    { turn: -0.12, climb: 0.08, length: 1.05, bank: -0.08, clearance: 480, label: 'shield six' },
    { turn: 0.04, climb: 0.02, length: 1.15, bank: 0.02, clearance: 520, label: 'core attack' },
    { turn: 0.62, climb: -0.12, length: 0.9, bank: 0.52, clearance: 430, label: 'extract turn one' },
    { turn: -0.78, climb: 0.2, length: 0.88, bank: -0.66, clearance: 420, label: 'extract turn two' },
  ]),
  gateSpacing: 5_050,
  gateRadius: 180,
  finalGateRadiusScale: 1.4,
  leadInControlMetres: 2_000,
  startOffsetMetres: 1_650,
  runOutSteps: 3,
  runOutStepMetres: 1_050,
  terminusStandoff: 2_300,
  sampleCount: 260,
});

/** Metadata consumed by common flight/title/HUD adapters; no gate-race world is constructed. */
export const DEAD_SIGNAL_COURSE_SHELL: CourseDefinition = Object.freeze({
  ...RINGFALL,
  id: 'ringfall',
  rulesetVersion: CURRENT_FLIGHT_RULESET_VERSION,
  defaultSeed: hashSeed('dead-signal-01'),
  text: Object.freeze({
    ...RINGFALL.text,
    canonicalSector: 'BLACK ARRAY',
    canonicalDestination: 'DEAD SIGNAL EXTRACTION',
    canonicalGatePrefix: 'ARRAY',
    canonicalFinalGate: 'EXTRACTION VECTOR',
  }),
  geometry: DEAD_SIGNAL_PATH,
  field: Object.freeze({
    ...WRECKLINE.field,
    corridor: 110,
    hazardCount: 0,
    hazardBand: 0,
  }),
  rank: Object.freeze({
    par: 116,
    thresholds: Object.freeze({ s: 0.94, a: 1.04, b: 1.14, c: 1.28 }),
    sRequiresClean: true,
  }),
  world: Object.freeze({
    ...RINGFALL.world,
    sunDirection: [-0.18, 0.12, -0.976] as const,
    planetDirection: [0.1, -0.08, -0.992] as const,
    planetRings: false,
    derelictCount: 0,
  }),
  destination: Object.freeze({
    apertureRadius: 520,
    hullBase: 0x171c28,
    hullAccent: 0x566274,
    window: 0xff4c38,
    aperture: 0x7cecff,
  }),
  vantages: Object.freeze([]),
  radio: Object.freeze([]),
});

const TARGETS: readonly DeadSignalTargetDefinition[] = Object.freeze([
  Object.freeze({ id: 'calibration', kind: 'calibration', required: false, hitPoints: 44, pathT: 0.205, rightOffset: 0, upOffset: 18, forwardOffset: 0, radius: 34 }),
  Object.freeze({ id: 'shield-01', kind: 'shield', required: true, hitPoints: 66, pathT: 0.335, rightOffset: -92, upOffset: 38, forwardOffset: 0, radius: 38 }),
  Object.freeze({ id: 'shield-02', kind: 'shield', required: true, hitPoints: 66, pathT: 0.405, rightOffset: 108, upOffset: -42, forwardOffset: 0, radius: 38 }),
  Object.freeze({ id: 'shield-03', kind: 'shield', required: true, hitPoints: 66, pathT: 0.475, rightOffset: -118, upOffset: -54, forwardOffset: 0, radius: 38 }),
  Object.freeze({ id: 'shield-04', kind: 'shield', required: true, hitPoints: 66, pathT: 0.545, rightOffset: 126, upOffset: 58, forwardOffset: 0, radius: 38 }),
  Object.freeze({ id: 'shield-05', kind: 'shield', required: true, hitPoints: 66, pathT: 0.615, rightOffset: -104, upOffset: 68, forwardOffset: 0, radius: 38 }),
  Object.freeze({ id: 'shield-06', kind: 'shield', required: true, hitPoints: 66, pathT: 0.685, rightOffset: 96, upOffset: -62, forwardOffset: 0, radius: 38 }),
  Object.freeze({ id: 'array-core', kind: 'core', required: true, hitPoints: 132, pathT: 0.79, rightOffset: 0, upOffset: 0, forwardOffset: 0, radius: 72 }),
]);

export const DEAD_SIGNAL_MISSION: DeadSignalMissionDefinition = Object.freeze({
  id: 'dead-signal',
  chapter: 3,
  rulesetVersion: CURRENT_FLIGHT_RULESET_VERSION,
  defaultSeed: DEAD_SIGNAL_COURSE_SHELL.defaultSeed,
  world: Object.freeze({ kind: 'frontier', sourceCourse: DEAD_SIGNAL_COURSE_SHELL }),
  objective: Object.freeze({
    kind: 'strike',
    path: DEAD_SIGNAL_PATH,
    targets: TARGETS,
    shieldRequired: 3,
    coreBoundaryProgress: 0.755,
    coreWindowEndProgress: 0.865,
    finalBlastDeadlineSeconds: 120,
    extraction: Object.freeze({ startProgress: 0.82, timeoutSeconds: 30 }),
  }),
  mastery: Object.freeze(['all-nodes', 'accuracy'] as const),
  radio: Object.freeze([
    Object.freeze({
      afterGate: 0,
      speaker: 'DRIFT CONTROL',
      messageKey: 'radio1',
      safeWindowSeconds: 12,
    }),
  ]),
  capabilities: Object.freeze(['fire'] as const),
});
