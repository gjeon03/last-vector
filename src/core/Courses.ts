import { SCALE } from './art.ts';
import { hashSeed } from './rng.ts';

export type CourseId = 'cairn-drift' | 'needle-grave';
export type RankLetter = 'S' | 'A' | 'B' | 'C' | 'D';
export type ObjectiveId = 'first-clear' | 'highest-rank' | 'clean-clear' | 'precision';

/**
 * Largest normalized gate offset allowed by the route-wide precision mastery objective.
 * One exported owner keeps progress evaluation and the result explanation from drifting.
 */
export const PRECISION_MAX_OFFSET = 0.4;

export interface CourseLeg {
  readonly turn: number;
  readonly climb: number;
  readonly length: number;
  readonly bank: number;
  readonly clearance: number;
  readonly label: string;
  /** Optional authored aperture relief for a specific approach; one means the route baseline. */
  readonly gateRadiusScale?: number;
}

export interface VantageDefinition {
  readonly name: string;
  readonly t: number;
  readonly offset: readonly [number, number, number];
  readonly lookAhead: number;
  readonly fov: number;
  readonly exposureBias?: number;
  readonly gateIndex?: number;
  readonly gateStandoff?: number;
  readonly terminusStandoff?: number;
}

export interface ShearGateDefinition {
  readonly gates: readonly number[];
  readonly halfWidthRadians: number;
  readonly hubRadiusFraction: number;
  readonly angularSpeedRange: readonly [number, number];
  readonly aimOffsetFraction: number;
  readonly onBlocked: 'miss';
}

export interface CourseDefinition {
  readonly id: CourseId;
  readonly order: number;
  readonly defaultSeed: number;
  readonly unlocks?: CourseId;
  readonly text: {
    readonly canonicalSector: string;
    readonly canonicalDestination: string;
    readonly canonicalGatePrefix: string;
    readonly canonicalFinalGate: string;
  };
  readonly geometry: {
    readonly legs: readonly CourseLeg[];
    readonly gateSpacing: number;
    readonly gateRadius: number;
    readonly finalGateRadiusScale: number;
    readonly leadInControlMetres: number;
    readonly startOffsetMetres: number;
    readonly runOutSteps: number;
    readonly runOutStepMetres: number;
    readonly terminusStandoff: number;
    readonly sampleCount: number;
  };
  readonly field: {
    readonly corridor: number;
    readonly spreadFraction: number;
    readonly minRadius: number;
    readonly maxRadius: number;
    readonly hazardCount: number;
    readonly hazardBand: number;
    readonly startKeepClearRadius: number;
    readonly gateKeepClearScale: number;
  };
  readonly rank: {
    readonly par: number | 'derived';
    readonly thresholds: {
      readonly s: number;
      readonly a: number;
      readonly b: number;
      readonly c: number;
    };
    readonly sRequiresClean: boolean;
  };
  readonly world: {
    readonly sunDirection: readonly [number, number, number];
    readonly planetDirection: readonly [number, number, number];
    readonly planetRings: boolean;
    readonly derelictCount: number;
    readonly shelf: {
      readonly enabled: boolean;
      readonly routeFraction: number;
      readonly rightOffset: number;
      readonly forwardOffset: number;
      readonly verticalOffset: number;
    };
  };
  readonly destination: {
    readonly apertureRadius: number;
    readonly hullBase: number;
    readonly hullAccent: number;
    readonly window: number;
    readonly aperture: number;
  };
  readonly vantages: readonly VantageDefinition[];
  readonly objectives: readonly ObjectiveId[];
  readonly shear?: ShearGateDefinition;
}

const CAIRN_LEGS: readonly CourseLeg[] = [
  { turn: 0.1, climb: -0.04, length: 1.0, bank: 0.0, clearance: 320, label: 'open' },
  { turn: -0.62, climb: 0.14, length: 0.95, bank: 0.5, clearance: 240, label: 'first bend' },
  { turn: 0.52, climb: -0.4, length: 0.6, bank: -0.35, clearance: 150, label: 'the dive' },
  { turn: 1.02, climb: 0.06, length: 0.78, bank: 0.85, clearance: 275, label: 'hard right' },
  { turn: -0.5, climb: 0.34, length: 1.05, bank: -0.6, clearance: 210, label: 'climb out' },
  { turn: -0.92, climb: -0.16, length: 0.56, bank: -0.9, clearance: 145, label: 'the shelf cut' },
  { turn: 0.2, climb: -0.14, length: 1.4, bank: 0.2, clearance: 300, label: 'the long run' },
  { turn: 0.78, climb: 0.2, length: 0.52, bank: 0.7, clearance: 175, label: 'the pinch' },
  { turn: -0.3, climb: -0.08, length: 1.0, bank: -0.2, clearance: 260, label: 'terminus approach' },
];

const CAIRN_VANTAGES: readonly VantageDefinition[] = [
  { name: 'title', t: 0.02, offset: [-17, 4.4, 24], lookAhead: 34, fov: 50, exposureBias: 3.0 },
  { name: 'hull', t: 0.2, offset: [-26, 5.5, 38], lookAhead: 26, fov: 40, exposureBias: 1.45 },
  { name: 'chase', t: 0.34, offset: [0, 3.2, 16.5], lookAhead: 90, fov: 76, exposureBias: 1.5 },
  { name: 'drive-side', t: 0.34, offset: [26, 0.6, 6], lookAhead: 0, fov: 48, exposureBias: 1.2 },
  { name: 'gate-approach', t: 0, offset: [0, 6, 40], lookAhead: 700, fov: 64, gateIndex: 0, gateStandoff: 760 },
  { name: 'gate-close', t: 0, offset: [34, 12, 62], lookAhead: 260, fov: 58, gateIndex: 2, gateStandoff: 230 },
  { name: 'field-dive', t: 0, offset: [-60, 22, 130], lookAhead: 1200, fov: 70, gateIndex: 3, gateStandoff: 1900, exposureBias: 1.3 },
  { name: 'planet-rise', t: 0, offset: [90, -26, 180], lookAhead: 1500, fov: 74, gateIndex: 5, gateStandoff: 2600, exposureBias: 2.4 },
  { name: 'long-run', t: 0.7, offset: [-26, 8, 62], lookAhead: 2200, fov: 82, exposureBias: 1.25 },
  { name: 'shelf-edge', t: 0, offset: [120, 44, 240], lookAhead: 1600, fov: 62, gateIndex: 7, gateStandoff: 2100, exposureBias: 1.35 },
  { name: 'terminus', t: 0, offset: [-60, 26, 480], lookAhead: 3400, fov: 56, terminusStandoff: 4200, exposureBias: 1.25 },
];

const NEEDLE_LEGS: readonly CourseLeg[] = [
  { turn: -0.18, climb: 0.05, length: 0.95, bank: -0.15, clearance: 220, label: 'relay vector' },
  // A broad calibration plane after the first hard turn; the four following SHEAR apertures
  // return to the compact baseline.
  { turn: 0.72, climb: -0.18, length: 0.82, bank: 0.62, clearance: 240, label: 'first needle', gateRadiusScale: 2 },
  { turn: -0.96, climb: 0.28, length: 0.7, bank: -0.78, clearance: 220, label: 'shear entry' },
  { turn: 0.82, climb: -0.34, length: 0.78, bank: 0.9, clearance: 210, label: 'crosscut' },
  { turn: -0.7, climb: 0.12, length: 0.9, bank: -0.68, clearance: 220, label: 'broken antenna' },
  { turn: 0.44, climb: 0.1, length: 0.92, bank: 0.35, clearance: 230, label: 'nadir approach' },
];

const NEEDLE_VANTAGES: readonly VantageDefinition[] = [
  { name: 'title', t: 0.04, offset: [-20, 5, 29], lookAhead: 28, fov: 48, exposureBias: 2.25 },
  { name: 'hull', t: 0.24, offset: [-28, 6, 42], lookAhead: 24, fov: 40, exposureBias: 1.35 },
  { name: 'chase', t: 0.38, offset: [0, 3.2, 16.5], lookAhead: 80, fov: 76, exposureBias: 1.35 },
  { name: 'drive-side', t: 0.38, offset: [26, 0.6, 6], lookAhead: 0, fov: 48, exposureBias: 1.15 },
  { name: 'gate-approach', t: 0, offset: [0, 5, 38], lookAhead: 620, fov: 62, gateIndex: 0, gateStandoff: 680 },
  { name: 'gate-close', t: 0, offset: [26, 10, 54], lookAhead: 220, fov: 54, gateIndex: 2, gateStandoff: 205 },
  { name: 'field-dive', t: 0, offset: [-48, 18, 110], lookAhead: 900, fov: 68, gateIndex: 3, gateStandoff: 1250, exposureBias: 1.2 },
  { name: 'planet-rise', t: 0, offset: [76, -20, 150], lookAhead: 1100, fov: 70, gateIndex: 4, gateStandoff: 1750, exposureBias: 1.8 },
  { name: 'long-run', t: 0.68, offset: [-22, 7, 58], lookAhead: 1600, fov: 78, exposureBias: 1.2 },
  { name: 'shelf-edge', t: 0, offset: [92, 34, 190], lookAhead: 1100, fov: 60, gateIndex: 5, gateStandoff: 1500, exposureBias: 1.25 },
  { name: 'terminus', t: 0, offset: [-52, 22, 410], lookAhead: 2800, fov: 54, terminusStandoff: 3400, exposureBias: 1.2 },
];

const OBJECTIVES = [
  'first-clear',
  'highest-rank',
  'clean-clear',
  'precision',
] as const satisfies readonly ObjectiveId[];

export const CAIRN_DRIFT: CourseDefinition = {
  id: 'cairn-drift',
  order: 0,
  defaultSeed: hashSeed('cairn-drift-01'),
  unlocks: 'needle-grave',
  text: {
    canonicalSector: 'THE CAIRN DRIFT',
    canonicalDestination: 'VESPER TERMINUS',
    canonicalGatePrefix: 'CAIRN',
    canonicalFinalGate: 'TERMINUS APPROACH',
  },
  geometry: {
    legs: CAIRN_LEGS,
    gateSpacing: SCALE.gateSpacing,
    gateRadius: SCALE.gateRadius,
    finalGateRadiusScale: 1.3,
    leadInControlMetres: 1800,
    startOffsetMetres: 1500,
    runOutSteps: 4,
    runOutStepMetres: 900,
    terminusStandoff: 3200,
    sampleCount: 220,
  },
  field: {
    corridor: 84,
    spreadFraction: 0.55,
    minRadius: 9,
    maxRadius: 160,
    hazardCount: 460,
    hazardBand: 120,
    startKeepClearRadius: 1100,
    gateKeepClearScale: 2.4,
  },
  rank: {
    par: 'derived',
    thresholds: { s: 0.74, a: 0.84, b: 0.96, c: 1.18 },
    sRequiresClean: true,
  },
  world: {
    sunDirection: [-0.58, 0.3, -0.76],
    planetDirection: [0.68, -0.2, -0.7],
    planetRings: true,
    derelictCount: 7,
    shelf: { enabled: true, routeFraction: 0.5, rightOffset: 5200, forwardOffset: 2600, verticalOffset: -900 },
  },
  destination: {
    apertureRadius: 430,
    hullBase: 0x49525f,
    hullAccent: 0x9aa6b4,
    window: 0xffcf92,
    aperture: 0x64e8ff,
  },
  vantages: CAIRN_VANTAGES,
  objectives: OBJECTIVES,
};

export const NEEDLE_GRAVE: CourseDefinition = {
  id: 'needle-grave',
  order: 1,
  defaultSeed: hashSeed('needle-grave-01'),
  text: {
    canonicalSector: 'THE NEEDLE GRAVE',
    canonicalDestination: 'NADIR RELAY',
    canonicalGatePrefix: 'NEEDLE',
    canonicalFinalGate: 'NADIR APPROACH',
  },
  geometry: {
    legs: NEEDLE_LEGS,
    gateSpacing: 4270,
    // Compact versus CAIRN once the rotating 44-degree blocked sector and central hub are
    // subtracted, while retaining enough open area for a recoverable high-speed line.
    gateRadius: 120,
    finalGateRadiusScale: 1.22,
    leadInControlMetres: 1450,
    startOffsetMetres: 1200,
    runOutSteps: 3,
    runOutStepMetres: 900,
    // Leaves the deterministic full run safely inside the 45–55 s route target without
    // changing any gate approach or SHEAR timing.
    terminusStandoff: 1650,
    sampleCount: 180,
  },
  field: {
    corridor: 74,
    spreadFraction: 0.46,
    minRadius: 7,
    maxRadius: 118,
    hazardCount: 410,
    hazardBand: 92,
    startKeepClearRadius: 900,
    gateKeepClearScale: 2.2,
  },
  rank: {
    par: 50,
    thresholds: { s: 0.92, a: 1.02, b: 1.14, c: 1.3 },
    sRequiresClean: true,
  },
  world: {
    sunDirection: [-0.42, 0.16, -0.89],
    planetDirection: [0.52, -0.38, -0.76],
    planetRings: false,
    derelictCount: 12,
    shelf: { enabled: true, routeFraction: 0.52, rightOffset: 3400, forwardOffset: 900, verticalOffset: -480 },
  },
  destination: {
    apertureRadius: 360,
    hullBase: 0x332f4b,
    hullAccent: 0x756b91,
    window: 0xff5f66,
    aperture: 0xd15b77,
  },
  vantages: NEEDLE_VANTAGES,
  objectives: OBJECTIVES,
  shear: {
    gates: [2, 3, 4, 5],
    halfWidthRadians: (22 * Math.PI) / 180,
    hubRadiusFraction: 0.12,
    angularSpeedRange: [0.55, 0.95],
    aimOffsetFraction: 0.58,
    onBlocked: 'miss',
  },
};

export const COURSE_ORDER = ['cairn-drift', 'needle-grave'] as const satisfies readonly CourseId[];
export const DEFAULT_COURSE_ID: CourseId = 'cairn-drift';
export const COURSE_CATALOG: Readonly<Record<CourseId, CourseDefinition>> = Object.freeze({
  'cairn-drift': CAIRN_DRIFT,
  'needle-grave': NEEDLE_GRAVE,
});

export function isCourseId(value: unknown): value is CourseId {
  return value === 'cairn-drift' || value === 'needle-grave';
}

export function getCourseDefinition(id: CourseId): CourseDefinition {
  return COURSE_CATALOG[id];
}

export function getNextCourse(id: CourseId): CourseId | null {
  const index = COURSE_ORDER.indexOf(id);
  return index >= 0 && index + 1 < COURSE_ORDER.length ? COURSE_ORDER[index + 1]! : null;
}

export function courseRecordId(definition: CourseDefinition, seed: number): string {
  return `${definition.id}-${seed >>> 0}`;
}

export function calculateCourseRank(
  definition: CourseDefinition,
  elapsed: number,
  courseLength: number,
  cruiseSpeed: number,
  clean: boolean,
): RankLetter {
  const par = definition.rank.par === 'derived'
    ? (courseLength / cruiseSpeed) * 1.06
    : definition.rank.par;
  const ratio = elapsed / par;
  const { s, a, b, c } = definition.rank.thresholds;
  if (ratio < s && (!definition.rank.sRequiresClean || clean)) return 'S';
  if (ratio < a) return 'A';
  if (ratio < b) return 'B';
  if (ratio < c) return 'C';
  return 'D';
}

function validateDefinition(definition: CourseDefinition): void {
  const fail = (field: string): never => {
    throw new Error(`Invalid course definition ${definition.id}: ${field}`);
  };
  if (definition.geometry.legs.length < 1) fail('geometry.legs');
  if (!Number.isFinite(definition.geometry.gateSpacing) || definition.geometry.gateSpacing <= 0) {
    fail('geometry.gateSpacing');
  }
  if (!Number.isFinite(definition.geometry.gateRadius) || definition.geometry.gateRadius <= 0) {
    fail('geometry.gateRadius');
  }
  for (const vantage of definition.vantages) {
    if (vantage.gateIndex !== undefined &&
      (!Number.isInteger(vantage.gateIndex) || vantage.gateIndex < 0 || vantage.gateIndex >= definition.geometry.legs.length)) {
      fail(`vantages.${vantage.name}.gateIndex`);
    }
  }
  for (const gateIndex of definition.shear?.gates ?? []) {
    if (!Number.isInteger(gateIndex) || gateIndex < 0 || gateIndex >= definition.geometry.legs.length) {
      fail(`shear.gates.${gateIndex}`);
    }
  }
  const { s, a, b, c } = definition.rank.thresholds;
  if (!(s > 0 && s < a && a < b && b < c)) fail('rank.thresholds');
}

for (let index = 0; index < COURSE_ORDER.length; index++) {
  const id = COURSE_ORDER[index]!;
  const definition = COURSE_CATALOG[id];
  if (definition.order !== index || definition.id !== id) {
    throw new Error(`Invalid course catalog order at ${id}`);
  }
  validateDefinition(definition);
}
