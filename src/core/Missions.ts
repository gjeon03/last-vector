import {
  CAIRN_DRIFT,
  KNOWN_COURSE_ORDER,
  type CourseDefinition,
  type CourseId,
  type FlightPathDefinition,
  type RadioAuthoringDefinition,
} from './Courses.ts';
import type { PaletteKey } from './art.ts';

export type MissionId = 'cairn-drift' | 'relay-harvest';
export type MissionChapter = 1 | 2;
/** Reserved for genuine player verbs shared across future objective implementations. */
export type MissionCapability = never;
export type MasteryId = 'precision';

export interface GateRaceObjectiveDefinition {
  readonly kind: 'gate-race';
  readonly path: FlightPathDefinition;
  readonly gates: CourseDefinition;
}

export interface CollectionObjectiveDefinition {
  readonly kind: 'collection';
  readonly path: FlightPathDefinition;
  readonly activeSources: 10;
  readonly requiredSources: 10;
  readonly chargePerSource: 10;
  readonly chargeRequired: 100;
}

export type ObjectiveDefinition = GateRaceObjectiveDefinition | CollectionObjectiveDefinition;

/**
 * Serializable presentation boundary. The selected runtime remains the sole owner of render
 * objects and collision arrays; the optional source course exists only for the legacy CAIRN
 * adapter and is never used to fake another mission into a gate race.
 */
export interface WorldDefinition {
  readonly kind: 'frontier' | 'relay-field';
  readonly sourceCourse: CourseDefinition | null;
  readonly canonicalSector: string;
  readonly canonicalDestination: string;
  readonly sunDirection: readonly [number, number, number];
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly palette?: Partial<Record<PaletteKey, number>>;
  readonly attractLoopDistance: number;
}

export interface MissionDefinition {
  readonly id: MissionId;
  readonly chapter: MissionChapter;
  readonly rulesetVersion: number;
  readonly defaultSeed: number;
  readonly world: WorldDefinition;
  readonly objective: ObjectiveDefinition;
  readonly mastery: readonly MasteryId[];
  readonly radio: readonly RadioAuthoringDefinition[];
  readonly capabilities: readonly MissionCapability[];
}

export const CAIRN_MISSION: MissionDefinition = {
  id: 'cairn-drift',
  chapter: 1,
  rulesetVersion: CAIRN_DRIFT.rulesetVersion,
  defaultSeed: CAIRN_DRIFT.defaultSeed,
  world: {
    kind: 'frontier',
    sourceCourse: CAIRN_DRIFT,
    canonicalSector: CAIRN_DRIFT.text.canonicalSector,
    canonicalDestination: CAIRN_DRIFT.text.canonicalDestination,
    sunDirection: CAIRN_DRIFT.world.sunDirection,
    sunColor: 0xffe2bd,
    sunIntensity: 2.7,
    attractLoopDistance: CAIRN_DRIFT.geometry.gateSpacing * 2.2,
  },
  objective: { kind: 'gate-race', path: CAIRN_DRIFT.geometry, gates: CAIRN_DRIFT },
  mastery: ['precision'],
  radio: CAIRN_DRIFT.radio,
  capabilities: [],
};

/** THE SPLINTER's compressed broken lane. HARVEST uses it as terrain, not as a gate race. */
export const RELAY_HARVEST_PATH: FlightPathDefinition = Object.freeze({
  legs: Object.freeze([
    Object.freeze({ turn: 0.14, climb: -0.06, length: 1, bank: 0, clearance: 225, label: 'lane mouth' }),
    Object.freeze({ turn: -0.86, climb: 0.1, length: 0.72, bank: 0.7, clearance: 170, label: 'first shear' }),
    Object.freeze({ turn: 0.94, climb: -0.22, length: 0.66, bank: -0.8, clearance: 152, label: 'counter shear' }),
    Object.freeze({ turn: -0.42, climb: -0.52, length: 0.58, bank: -0.45, clearance: 145, label: 'the drop' }),
    Object.freeze({ turn: 1.18, climb: 0.18, length: 0.62, bank: 1, clearance: 158, label: 'the hook' }),
    Object.freeze({ turn: -1.24, climb: 0.08, length: 0.6, bank: -1.05, clearance: 140, label: 'reverse hook' }),
    Object.freeze({ turn: 0.16, climb: 0.28, length: 1.15, bank: 0.15, clearance: 210, label: 'the gap' }),
    Object.freeze({ turn: -0.7, climb: -0.34, length: 0.54, bank: -0.75, clearance: 138, label: 'under the spar' }),
    Object.freeze({ turn: 1.06, climb: 0.14, length: 0.56, bank: 0.9, clearance: 148, label: 'the crush' }),
    Object.freeze({ turn: -0.58, climb: 0.4, length: 0.7, bank: -0.55, clearance: 165, label: 'up the fracture' }),
    Object.freeze({ turn: 0.82, climb: -0.26, length: 0.6, bank: 0.8, clearance: 150, label: 'the tilt' }),
    Object.freeze({ turn: -1.02, climb: -0.12, length: 0.52, bank: -0.95, clearance: 142, label: 'last shear' }),
    Object.freeze({ turn: 0.24, climb: 0.1, length: 0.95, bank: 0.2, clearance: 200, label: 'dock approach' }),
  ]),
  gateSpacing: 2_900,
  gateRadius: 68,
  finalGateRadiusScale: 1,
  leadInControlMetres: 1_400,
  startOffsetMetres: -1_100,
  runOutSteps: 3,
  runOutStepMetres: 900,
  terminusStandoff: 1_400,
  sampleCount: 220,
});

const RELAY_RADIO: readonly RadioAuthoringDefinition[] = Object.freeze([
  Object.freeze({
    afterGate: 0,
    speaker: 'Control',
    messageKey: 'radio1',
    safeWindowSeconds: 8,
  }),
  Object.freeze({
    afterGate: 1,
    speaker: 'Control',
    messageKey: 'radio2',
    safeWindowSeconds: 8,
  }),
  Object.freeze({
    afterGate: 5,
    speaker: 'Control',
    messageKey: 'radio3',
    safeWindowSeconds: 8,
  }),
  Object.freeze({
    afterGate: 10,
    speaker: 'Control',
    messageKey: 'radio4',
    safeWindowSeconds: 8,
  }),
]);

export const RELAY_HARVEST_MISSION: MissionDefinition = Object.freeze({
  id: 'relay-harvest',
  chapter: 2,
  // v3 is the shipped HARVEST loop over THE SPLINTER terrain. Old relay-arena times are not
  // comparable with a continuously repopulated ten-cell hunt through dense debris.
  rulesetVersion: 3,
  defaultSeed: 0x52454c59,
  world: Object.freeze({
    kind: 'relay-field',
    sourceCourse: null,
    canonicalSector: 'THE BLACKOUT RELAY',
    canonicalDestination: 'RELAY HEART',
    // Low, cold back-light: the relay's splinter field reads as a dense broken lane rather than
    // CAIRN DRIFT's open, warm shelf.
    sunDirection: Object.freeze([-0.55, -0.18, -0.81] as const),
    sunColor: 0xd8ecff,
    sunIntensity: 2.35,
    palette: Object.freeze({
      voidNear: 0x03080a,
      voidFar: 0x081a1c,
      starCore: 0xf2fbff,
      starGlow: 0x9fd8ff,
      starRim: 0x4f93d6,
      nebulaTeal: 0x8fd94a,
      nebulaIndigo: 0x1d5e57,
      nebulaMagenta: 0xd6e34a,
      nebulaDust: 0x14231c,
      planetLit: 0x7d8a72,
      planetShadow: 0x0b1414,
      planetAtmo: 0x9fe8c4,
      rockLit: 0x6f7a70,
      rockShadow: 0x0d1414,
      rockMineral: 0xc7ff5e,
      gateIdle: 0x2f4a3a,
      gateArmed: 0xa8ff5e,
      gateCleared: 0xe8ff9c,
    }),
    attractLoopDistance: 8_000,
  }),
  objective: Object.freeze({
    kind: 'collection',
    path: RELAY_HARVEST_PATH,
    activeSources: 10,
    requiredSources: 10,
    chargePerSource: 10,
    chargeRequired: 100,
  }),
  mastery: Object.freeze([]),
  radio: RELAY_RADIO,
  capabilities: Object.freeze([]),
});

export const ACTIVE_MISSION_ORDER = [
  'cairn-drift',
  'relay-harvest',
] as const satisfies readonly MissionId[];

export const DORMANT_COURSE_ORDER = KNOWN_COURSE_ORDER.filter(
  (id): id is Exclude<CourseId, MissionId> => id !== 'cairn-drift',
);

export const MISSION_CATALOG: Readonly<Record<MissionId, MissionDefinition>> = Object.freeze({
  'cairn-drift': CAIRN_MISSION,
  'relay-harvest': RELAY_HARVEST_MISSION,
});

export const DEFAULT_MISSION_ID: MissionId = 'cairn-drift';

export function isMissionId(value: unknown): value is MissionId {
  return typeof value === 'string' && ACTIVE_MISSION_ORDER.includes(value as MissionId);
}

export function getMissionDefinition(id: MissionId): MissionDefinition {
  return MISSION_CATALOG[id];
}

export function getNextMission(id: MissionId): MissionId | null {
  const index = ACTIVE_MISSION_ORDER.indexOf(id);
  return index >= 0 && index + 1 < ACTIVE_MISSION_ORDER.length
    ? ACTIVE_MISSION_ORDER[index + 1]!
    : null;
}

export function missionRecordId(definition: MissionDefinition, seed: number): string {
  return `${definition.id}-r${definition.rulesetVersion}-${seed >>> 0}`;
}

for (const id of ACTIVE_MISSION_ORDER) {
  const definition = MISSION_CATALOG[id];
  if (definition.id !== id) throw new Error(`Invalid mission catalog entry: ${id}`);
  if (!Number.isInteger(definition.rulesetVersion) || definition.rulesetVersion < 1) {
    throw new Error(`Invalid mission ruleset version: ${id}`);
  }
  if (definition.objective.kind === 'gate-race'
    && definition.objective.path !== definition.objective.gates.geometry) {
    throw new Error(`Gate-race path must be the authored course path: ${id}`);
  }
}
