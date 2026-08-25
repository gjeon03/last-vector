import type {
  CourseDefinition,
  CourseLeg,
  FlightPathDefinition,
  RadioAuthoringDefinition,
} from '../../core/Courses.ts';
import { CURRENT_FLIGHT_RULESET_VERSION } from '../../core/Courses.ts';
import { hashSeed } from '../../core/rng.ts';

/**
 * A long authored ascent rather than an endless hazard field. The three strong bends centre the
 * three debris decisions; the long, shallow final legs open into the escape burn.
 */
const LAST_ASCENT_LEGS: readonly CourseLeg[] = [
  { turn: 0.03, climb: 0.09, length: 1.05, bank: 0.02, clearance: 620, label: 'launch rail' },
  { turn: -0.1, climb: 0.1, length: 1.1, bank: -0.08, clearance: 660, label: 'atmosphere break' },
  { turn: 0.2, climb: 0.04, length: 1.02, bank: 0.16, clearance: 560, label: 'debris line alpha' },
  { turn: -0.04, climb: -0.02, length: 1.08, bank: -0.04, clearance: 720, label: 'recovery one' },
  { turn: -0.24, climb: 0.16, length: 1.0, bank: -0.2, clearance: 540, label: 'debris line beta' },
  { turn: 0.05, climb: 0.01, length: 1.12, bank: 0.03, clearance: 740, label: 'recovery two' },
  { turn: 0.28, climb: -0.14, length: 1.04, bank: 0.22, clearance: 560, label: 'debris line gamma' },
  { turn: -0.04, climb: 0.04, length: 1.28, bank: -0.02, clearance: 820, label: 'recovery three' },
  { turn: -0.12, climb: 0.07, length: 1.45, bank: -0.08, clearance: 980, label: 'orbital arc' },
  { turn: 0.06, climb: 0.02, length: 1.55, bank: 0.04, clearance: 1100, label: 'escape burn' },
];

export const LAST_ASCENT_PATH: FlightPathDefinition = Object.freeze({
  legs: LAST_ASCENT_LEGS,
  gateSpacing: 7800,
  gateRadius: 320,
  finalGateRadiusScale: 1,
  leadInControlMetres: 2300,
  startOffsetMetres: 1750,
  runOutSteps: 5,
  runOutStepMetres: 1350,
  terminusStandoff: 0,
  sampleCount: 300,
});

export const LAST_ASCENT_RADIO: readonly RadioAuthoringDefinition[] = Object.freeze([
  { afterGate: 0, speaker: 'ACHRA CONTROL', messageKey: 'radio1', safeWindowSeconds: 12.2 },
  { afterGate: 1, speaker: 'KESTREL-C7', messageKey: 'radio2', safeWindowSeconds: 9.8 },
  { afterGate: 2, speaker: 'ACHRA CONTROL', messageKey: 'radio3', safeWindowSeconds: 9.6 },
  { afterGate: 3, speaker: 'KESTREL-C7', messageKey: 'radio4', safeWindowSeconds: 12.0 },
]);

export const LAST_ASCENT_DEFAULT_SEED = hashSeed('last-ascent-01');

/**
 * Temporary presentation projection for the foundation's locked WorldDefinition. Game reads
 * only its text, sun and path-scale fields; the selected LAST ASCENT factory never constructs a
 * Course, gates, asteroids, landmarks or terminus from it. Keeping the compatibility id as CAIRN
 * also keeps the retired Course catalog and every CAIRN hash byte-for-byte untouched.
 */
export const LAST_ASCENT_PRESENTATION_COURSE: CourseDefinition = Object.freeze({
  id: 'cairn-drift',
  rulesetVersion: CURRENT_FLIGHT_RULESET_VERSION,
  order: 0,
  defaultSeed: LAST_ASCENT_DEFAULT_SEED,
  text: {
    canonicalSector: 'LAST ASCENT',
    canonicalDestination: 'ORBITAL EXTRACTION',
    canonicalGatePrefix: 'SAFE CORRIDOR',
    canonicalFinalGate: 'EXTRACTION VECTOR',
    finalGateMessage: 'gate-name.terminus-approach' as const,
  },
  geometry: LAST_ASCENT_PATH,
  field: {
    corridor: 160,
    spreadFraction: 0.85,
    minRadius: 28,
    maxRadius: 108,
    hazardCount: 20,
    hazardBand: 0,
    startKeepClearRadius: 1800,
    gateKeepClearScale: 1,
  },
  rank: {
    par: 112,
    thresholds: { s: 0.965, a: 1.055, b: 1.145, c: 1.3 },
    sRequiresClean: true,
  },
  world: {
    sunDirection: [-0.32, 0.42, -0.85],
    planetDirection: [0.02, -0.52, -0.85],
    planetRings: false,
    derelictCount: 0,
    landmarkKind: 'cairn',
    shelf: {
      enabled: false,
      routeFraction: 0.15,
      rightOffset: 0,
      forwardOffset: 0,
      verticalOffset: 0,
    },
  },
  destination: {
    apertureRadius: 900,
    hullBase: 0x263643,
    hullAccent: 0x8fb6c4,
    window: 0x8ee9ff,
    aperture: 0xff8e58,
  },
  vantages: [],
  objectives: ['first-clear', 'highest-rank', 'clean-clear', 'precision'],
  pilot: { boostClearanceRadii: 10, brake: null },
  radio: LAST_ASCENT_RADIO,
} satisfies CourseDefinition);

/** Normalized path locations of the three authored decisions. */
export const LAST_ASCENT_CHECKPOINT_PROGRESS = [0.34, 0.51, 0.68] as const;
export const LAST_ASCENT_CHECKPOINT_REWARD = 25;
export const LAST_ASCENT_SHOCK_GRACE_SECONDS = 5;
export const LAST_ASCENT_SHOCK_TRANSITION_SECONDS = 80;
export const LAST_ASCENT_SHOCK_EXTRACTION_SECONDS = 108;
