import { SCALE } from './art.ts';
import { hashSeed } from './rng.ts';

export type CourseId = 'cairn-drift' | 'needle-grave' | 'wreckline' | 'ringfall';
export type RankLetter = 'S' | 'A' | 'B' | 'C' | 'D';
export type ObjectiveId = 'first-clear' | 'highest-rank' | 'clean-clear' | 'precision';
export type StageLandmarkKind = 'cairn' | 'wreckline' | 'ringfall';
export type FinalGateMessage =
  | 'gate-name.terminus-approach'
  | 'gate-name.nadir-approach'
  | 'gate-name.orison-approach';
export type RadioMessageKey = 'radio1' | 'radio2' | 'radio3' | 'radio4' | 'radio5';

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

export interface PilotBrakeDefinition {
  readonly distanceRadii: number;
  readonly alignmentMax: number;
  readonly minSpeed: number;
}

export interface PilotDefinition {
  readonly boostClearanceRadii: number;
  readonly brake: PilotBrakeDefinition | null;
}

export interface RadioAuthoringDefinition {
  /** Number of gates already cleared when the line becomes eligible; zero means approach. */
  readonly afterGate: number;
  readonly speaker: string;
  readonly messageKey: RadioMessageKey;
  /** Authored time to the next required steering/braking commitment on the reference trace. */
  readonly safeWindowSeconds: number;
}

export interface CourseDefinition {
  readonly id: CourseId;
  /** Stable position in the recognized catalog, including dormant definitions. */
  readonly order: number;
  readonly defaultSeed: number;
  readonly text: {
    readonly canonicalSector: string;
    readonly canonicalDestination: string;
    readonly canonicalGatePrefix: string;
    readonly canonicalFinalGate: string;
    readonly finalGateMessage: FinalGateMessage;
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
    readonly landmarkKind: StageLandmarkKind;
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
  readonly pilot: PilotDefinition;
  readonly radio: readonly RadioAuthoringDefinition[];
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

/**
 * Broad gates introduce TWIN KEELS before the compact FRACTURE reverse-S. The long fifth leg is
 * deliberate recovery room; the following climb/dive pair forms the fixed ENGINE SPINE slalom.
 */
const WRECKLINE_LEGS: readonly CourseLeg[] = [
  { turn: -0.08, climb: 0.02, length: 1.1, bank: -0.05, clearance: 320, label: 'twin keels', gateRadiusScale: 1.16 },
  { turn: 0.34, climb: -0.08, length: 0.96, bank: 0.28, clearance: 270, label: 'keel split' },
  { turn: -0.82, climb: -0.1, length: 0.72, bank: -0.72, clearance: 235, label: 'the fracture', gateRadiusScale: 1.22 },
  { turn: 1.0, climb: 0.16, length: 0.7, bank: 0.86, clearance: 225, label: 'reverse cut' },
  { turn: -0.16, climb: 0.05, length: 1.25, bank: -0.1, clearance: 330, label: 'recovery burn', gateRadiusScale: 1.14 },
  { turn: -0.44, climb: 0.42, length: 0.82, bank: -0.38, clearance: 245, label: 'engine spine high' },
  { turn: 0.52, climb: -0.44, length: 0.78, bank: 0.48, clearance: 235, label: 'engine spine low' },
  { turn: 0.12, climb: 0.08, length: 1.25, bank: 0.08, clearance: 330, label: 'nadir approach', gateRadiusScale: 1.18 },
];

const WRECKLINE_VANTAGES: readonly VantageDefinition[] = [
  { name: 'title', t: 0.03, offset: [-19, 5, 28], lookAhead: 32, fov: 49, exposureBias: 2.4 },
  { name: 'hull', t: 0.2, offset: [-27, 5.8, 40], lookAhead: 25, fov: 40, exposureBias: 1.4 },
  { name: 'chase', t: 0.34, offset: [0, 3.2, 16.5], lookAhead: 86, fov: 76, exposureBias: 1.4 },
  { name: 'drive-side', t: 0.34, offset: [26, 0.6, 6], lookAhead: 0, fov: 48, exposureBias: 1.18 },
  { name: 'gate-approach', t: 0, offset: [0, 6, 42], lookAhead: 720, fov: 64, gateIndex: 0, gateStandoff: 760 },
  { name: 'gate-close', t: 0, offset: [32, 11, 60], lookAhead: 270, fov: 58, gateIndex: 2, gateStandoff: 245 },
  { name: 'field-dive', t: 0, offset: [-58, 21, 122], lookAhead: 1100, fov: 70, gateIndex: 3, gateStandoff: 1550, exposureBias: 1.3 },
  { name: 'planet-rise', t: 0, offset: [82, -22, 165], lookAhead: 1250, fov: 72, gateIndex: 5, gateStandoff: 1850, exposureBias: 1.9 },
  { name: 'long-run', t: 0.62, offset: [-25, 8, 60], lookAhead: 1800, fov: 80, exposureBias: 1.22 },
  { name: 'shelf-edge', t: 0, offset: [105, 38, 210], lookAhead: 1300, fov: 62, gateIndex: 6, gateStandoff: 1750, exposureBias: 1.3 },
  { name: 'signature', t: 0, offset: [115, 44, 225], lookAhead: 1250, fov: 62, gateIndex: 3, gateStandoff: 1650, exposureBias: 1.32 },
  { name: 'terminus', t: 0, offset: [-56, 24, 440], lookAhead: 3000, fov: 55, terminusStandoff: 3700, exposureBias: 1.22 },
];

/**
 * RINGFALL spends its first three gates exposing the ring plane, commits to a descent/reversal at
 * TWIN SPIRES, then grants a broad climbing recovery before the low ORISON ARCH slalom.
 */
const RINGFALL_LEGS: readonly CourseLeg[] = [
  { turn: 0.12, climb: -0.18, length: 1.1, bank: 0.08, clearance: 340, label: 'high orbit', gateRadiusScale: 1.16 },
  { turn: -0.36, climb: -0.32, length: 0.95, bank: -0.28, clearance: 300, label: 'ring wall descent' },
  { turn: 0.48, climb: -0.22, length: 0.84, bank: 0.42, clearance: 270, label: 'plane approach' },
  { turn: -0.88, climb: -0.38, length: 0.74, bank: -0.76, clearance: 240, label: 'twin spires', gateRadiusScale: 1.24 },
  { turn: 1.02, climb: 0.3, length: 0.7, bank: 0.88, clearance: 230, label: 'below the plane' },
  { turn: -0.18, climb: 0.38, length: 1.2, bank: -0.12, clearance: 340, label: 'reversal climb', gateRadiusScale: 1.14 },
  { turn: -0.54, climb: -0.14, length: 0.82, bank: -0.46, clearance: 250, label: 'orison low' },
  { turn: 0.58, climb: 0.24, length: 0.84, bank: 0.5, clearance: 245, label: 'orison arch' },
  { turn: 0.08, climb: 0.16, length: 1.35, bank: 0.04, clearance: 350, label: 'orison approach', gateRadiusScale: 1.2 },
];

const RINGFALL_VANTAGES: readonly VantageDefinition[] = [
  { name: 'title', t: 0.03, offset: [-18, 5.2, 28], lookAhead: 33, fov: 49, exposureBias: 2.5 },
  { name: 'hull', t: 0.21, offset: [-27, 5.8, 40], lookAhead: 25, fov: 40, exposureBias: 1.42 },
  { name: 'chase', t: 0.35, offset: [0, 3.2, 16.5], lookAhead: 88, fov: 76, exposureBias: 1.42 },
  { name: 'drive-side', t: 0.35, offset: [26, 0.6, 6], lookAhead: 0, fov: 48, exposureBias: 1.2 },
  { name: 'gate-approach', t: 0, offset: [0, 7, 44], lookAhead: 740, fov: 65, gateIndex: 0, gateStandoff: 780 },
  { name: 'gate-close', t: 0, offset: [34, 13, 62], lookAhead: 280, fov: 59, gateIndex: 3, gateStandoff: 255 },
  { name: 'field-dive', t: 0, offset: [-62, 24, 132], lookAhead: 1180, fov: 72, gateIndex: 4, gateStandoff: 1650, exposureBias: 1.35 },
  { name: 'planet-rise', t: 0, offset: [90, -28, 178], lookAhead: 1400, fov: 74, gateIndex: 5, gateStandoff: 2050, exposureBias: 2.1 },
  { name: 'long-run', t: 0.66, offset: [-27, 9, 64], lookAhead: 1950, fov: 82, exposureBias: 1.24 },
  { name: 'shelf-edge', t: 0, offset: [112, 42, 224], lookAhead: 1450, fov: 63, gateIndex: 7, gateStandoff: 1900, exposureBias: 1.34 },
  { name: 'signature', t: 0, offset: [126, 50, 245], lookAhead: 1450, fov: 70, gateIndex: 4, gateStandoff: 1900, exposureBias: 1.5 },
  { name: 'terminus', t: 0, offset: [-62, 27, 470], lookAhead: 3250, fov: 56, terminusStandoff: 4000, exposureBias: 1.25 },
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
  text: {
    canonicalSector: 'THE CAIRN DRIFT',
    canonicalDestination: 'VESPER TERMINUS',
    canonicalGatePrefix: 'CAIRN',
    canonicalFinalGate: 'TERMINUS APPROACH',
    finalGateMessage: 'gate-name.terminus-approach',
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
    landmarkKind: 'cairn',
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
  pilot: {
    boostClearanceRadii: 12,
    brake: null,
  },
  radio: [
    { afterGate: 0, speaker: 'DRIFT CONTROL', messageKey: 'radio1', safeWindowSeconds: 10.6 },
    { afterGate: 4, speaker: 'VESPER TERMINUS', messageKey: 'radio3', safeWindowSeconds: 8.6 },
    { afterGate: 8, speaker: 'VESPER TERMINUS', messageKey: 'radio5', safeWindowSeconds: 9.0 },
  ],
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
    finalGateMessage: 'gate-name.nadir-approach',
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
    landmarkKind: 'cairn',
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
  pilot: {
    boostClearanceRadii: 28,
    brake: { distanceRadii: 46, alignmentMax: 0.985, minSpeed: 220 },
  },
  radio: [
    { afterGate: 0, speaker: 'NEEDLE CONTROL', messageKey: 'radio1', safeWindowSeconds: 10.5 },
    { afterGate: 2, speaker: 'NEEDLE CONTROL', messageKey: 'radio2', safeWindowSeconds: 8.8 },
    { afterGate: 3, speaker: 'NADIR RELAY', messageKey: 'radio3', safeWindowSeconds: 8.8 },
    { afterGate: 4, speaker: 'NADIR RELAY', messageKey: 'radio4', safeWindowSeconds: 8.7 },
    { afterGate: 5, speaker: 'NADIR RELAY', messageKey: 'radio5', safeWindowSeconds: 8.7 },
  ],
  shear: {
    gates: [2, 3, 4, 5],
    halfWidthRadians: (22 * Math.PI) / 180,
    hubRadiusFraction: 0.12,
    angularSpeedRange: [0.55, 0.95],
    aimOffsetFraction: 0.58,
    onBlocked: 'miss',
  },
};

export const WRECKLINE: CourseDefinition = {
  id: 'wreckline',
  order: 2,
  defaultSeed: hashSeed('wreckline-01'),
  text: {
    canonicalSector: 'THE WRECKLINE',
    canonicalDestination: 'NADIR RELAY',
    canonicalGatePrefix: 'WRECK',
    canonicalFinalGate: 'NADIR APPROACH',
    finalGateMessage: 'gate-name.nadir-approach',
  },
  geometry: {
    legs: WRECKLINE_LEGS,
    gateSpacing: 3900,
    gateRadius: 145,
    finalGateRadiusScale: 1.24,
    leadInControlMetres: 1600,
    startOffsetMetres: 1350,
    runOutSteps: 3,
    runOutStepMetres: 850,
    terminusStandoff: 1900,
    sampleCount: 210,
  },
  field: {
    corridor: 82,
    spreadFraction: 0.5,
    minRadius: 8,
    maxRadius: 132,
    hazardCount: 425,
    hazardBand: 108,
    startKeepClearRadius: 1050,
    gateKeepClearScale: 2.35,
  },
  rank: {
    par: 66,
    thresholds: { s: 0.92, a: 1.03, b: 1.16, c: 1.34 },
    sRequiresClean: true,
  },
  world: {
    sunDirection: [-0.5, 0.22, -0.84],
    planetDirection: [0.58, -0.32, -0.75],
    planetRings: false,
    derelictCount: 6,
    landmarkKind: 'wreckline',
    shelf: { enabled: false, routeFraction: 0.48, rightOffset: 4200, forwardOffset: 1500, verticalOffset: -620 },
  },
  destination: {
    apertureRadius: 380,
    hullBase: 0x3b4050,
    hullAccent: 0x8b93a5,
    window: 0xffb56f,
    aperture: 0x67dddc,
  },
  vantages: WRECKLINE_VANTAGES,
  objectives: OBJECTIVES,
  pilot: {
    boostClearanceRadii: 24,
    brake: { distanceRadii: 44, alignmentMax: 0.988, minSpeed: 245 },
  },
  radio: [
    { afterGate: 0, speaker: 'DRIFT CONTROL', messageKey: 'radio1', safeWindowSeconds: 11.2 },
    { afterGate: 4, speaker: 'KESTREL-C7', messageKey: 'radio2', safeWindowSeconds: 10.8 },
    { afterGate: 6, speaker: 'NADIR RELAY', messageKey: 'radio3', safeWindowSeconds: 10.8 },
  ],
};

export const RINGFALL: CourseDefinition = {
  id: 'ringfall',
  order: 3,
  defaultSeed: hashSeed('ringfall-01'),
  text: {
    canonicalSector: 'RINGFALL',
    canonicalDestination: 'ORISON ARRAY',
    canonicalGatePrefix: 'ORISON',
    canonicalFinalGate: 'ORISON APPROACH',
    finalGateMessage: 'gate-name.orison-approach',
  },
  geometry: {
    legs: RINGFALL_LEGS,
    gateSpacing: 3850,
    gateRadius: 150,
    finalGateRadiusScale: 1.26,
    leadInControlMetres: 1700,
    startOffsetMetres: 1450,
    runOutSteps: 3,
    runOutStepMetres: 900,
    terminusStandoff: 2100,
    sampleCount: 230,
  },
  field: {
    corridor: 86,
    spreadFraction: 0.52,
    minRadius: 8,
    maxRadius: 138,
    hazardCount: 435,
    hazardBand: 112,
    startKeepClearRadius: 1100,
    gateKeepClearScale: 2.4,
  },
  rank: {
    par: 72,
    thresholds: { s: 0.92, a: 1.03, b: 1.16, c: 1.34 },
    sRequiresClean: true,
  },
  world: {
    sunDirection: [-0.62, 0.34, -0.7],
    planetDirection: [0.72, -0.16, -0.67],
    planetRings: true,
    derelictCount: 4,
    landmarkKind: 'ringfall',
    shelf: { enabled: false, routeFraction: 0.56, rightOffset: 4700, forwardOffset: 1900, verticalOffset: -1100 },
  },
  destination: {
    apertureRadius: 420,
    hullBase: 0x424a5d,
    hullAccent: 0xa5afc4,
    window: 0xffd37f,
    aperture: 0x72e8ff,
  },
  vantages: RINGFALL_VANTAGES,
  objectives: OBJECTIVES,
  pilot: {
    boostClearanceRadii: 26,
    brake: { distanceRadii: 46, alignmentMax: 0.989, minSpeed: 235 },
  },
  radio: [
    { afterGate: 0, speaker: 'DRIFT CONTROL', messageKey: 'radio1', safeWindowSeconds: 11.4 },
    { afterGate: 5, speaker: 'KESTREL-C7', messageKey: 'radio2', safeWindowSeconds: 10.8 },
    { afterGate: 8, speaker: 'ORISON ARRAY', messageKey: 'radio3', safeWindowSeconds: 10.8 },
  ],
};

export const KNOWN_COURSE_ORDER = [
  'cairn-drift',
  'needle-grave',
  'wreckline',
  'ringfall',
] as const satisfies readonly CourseId[];
export const CHAPTER_ONE_STAGE_ORDER = [
  'cairn-drift',
  'wreckline',
  'ringfall',
] as const satisfies readonly CourseId[];
export const DEFAULT_COURSE_ID: CourseId = 'cairn-drift';

export const COURSE_CATALOG: Readonly<Record<CourseId, CourseDefinition>> = Object.freeze({
  'cairn-drift': CAIRN_DRIFT,
  'needle-grave': NEEDLE_GRAVE,
  wreckline: WRECKLINE,
  ringfall: RINGFALL,
});

export function isCourseId(value: unknown): value is CourseId {
  return typeof value === 'string' && KNOWN_COURSE_ORDER.includes(value as CourseId);
}

export function isCourseAvailable(id: CourseId): boolean {
  return CHAPTER_ONE_STAGE_ORDER.includes(id as typeof CHAPTER_ONE_STAGE_ORDER[number]);
}

export function getCourseDefinition(id: CourseId): CourseDefinition {
  return COURSE_CATALOG[id];
}

export function getNextCourse(id: CourseId): CourseId | null {
  const index = CHAPTER_ONE_STAGE_ORDER.indexOf(id as typeof CHAPTER_ONE_STAGE_ORDER[number]);
  return index >= 0 && index + 1 < CHAPTER_ONE_STAGE_ORDER.length
    ? CHAPTER_ONE_STAGE_ORDER[index + 1]!
    : null;
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
  if (!Number.isFinite(definition.pilot.boostClearanceRadii) || definition.pilot.boostClearanceRadii <= 0) {
    fail('pilot.boostClearanceRadii');
  }
  if (definition.pilot.brake !== null) {
    const { distanceRadii, alignmentMax, minSpeed } = definition.pilot.brake;
    if (!Number.isFinite(distanceRadii) || distanceRadii <= 0) fail('pilot.brake.distanceRadii');
    if (!(alignmentMax > 0 && alignmentMax < 1)) fail('pilot.brake.alignmentMax');
    if (!Number.isFinite(minSpeed) || minSpeed < 0) fail('pilot.brake.minSpeed');
  }
  let previousRadioGate = -1;
  for (const line of definition.radio) {
    if (!Number.isInteger(line.afterGate) || line.afterGate < 0 || line.afterGate >= definition.geometry.legs.length) {
      fail(`radio.${line.messageKey}.afterGate`);
    }
    if (line.afterGate <= previousRadioGate) fail(`radio.${line.messageKey}.order`);
    if (!line.speaker.trim()) fail(`radio.${line.messageKey}.speaker`);
    if (!Number.isFinite(line.safeWindowSeconds) || line.safeWindowSeconds <= 0) {
      fail(`radio.${line.messageKey}.safeWindowSeconds`);
    }
    previousRadioGate = line.afterGate;
  }
  const { s, a, b, c } = definition.rank.thresholds;
  if (!(s > 0 && s < a && a < b && b < c)) fail('rank.thresholds');
}

for (let index = 0; index < KNOWN_COURSE_ORDER.length; index++) {
  const id = KNOWN_COURSE_ORDER[index]!;
  const definition = COURSE_CATALOG[id];
  if (definition.order !== index || definition.id !== id) {
    throw new Error(`Invalid course catalog order at ${id}`);
  }
  validateDefinition(definition);
}

if (CHAPTER_ONE_STAGE_ORDER[0] !== DEFAULT_COURSE_ID) {
  throw new Error('Chapter 01 must begin with the default course');
}
for (const id of CHAPTER_ONE_STAGE_ORDER) {
  if (!KNOWN_COURSE_ORDER.includes(id)) throw new Error(`Unknown Chapter 01 stage: ${id}`);
}
