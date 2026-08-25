import {
  CAIRN_DRIFT,
  KNOWN_COURSE_ORDER,
  type CourseDefinition,
  type CourseId,
  type FlightPathDefinition,
  type RadioAuthoringDefinition,
} from './Courses.ts';

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
  readonly activeSources: 5;
  readonly requiredSources: 3;
  readonly chargePerSource: 20;
  readonly chargeRequired: 60;
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
    attractLoopDistance: CAIRN_DRIFT.geometry.gateSpacing * 2.2,
  },
  objective: { kind: 'gate-race', path: CAIRN_DRIFT.geometry, gates: CAIRN_DRIFT },
  mastery: ['precision'],
  radio: CAIRN_DRIFT.radio,
  capabilities: [],
};

/** A short straight launch corridor. The collection objective, not this line, owns navigation. */
export const RELAY_HARVEST_PATH: FlightPathDefinition = Object.freeze({
  legs: Object.freeze([
    Object.freeze({
      turn: 0,
      climb: 0,
      length: 4.6,
      bank: 0,
      clearance: 5_500,
      label: 'relay field',
    }),
  ]),
  gateSpacing: 10_000,
  gateRadius: 220,
  finalGateRadiusScale: 1,
  leadInControlMetres: 1_000,
  startOffsetMetres: -1_000,
  runOutSteps: 3,
  runOutStepMetres: 2_000,
  terminusStandoff: 2_000,
  sampleCount: 96,
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
    afterGate: 2,
    speaker: 'Control',
    messageKey: 'radio3',
    safeWindowSeconds: 8,
  }),
]);

export const RELAY_HARVEST_MISSION: MissionDefinition = Object.freeze({
  id: 'relay-harvest',
  chapter: 2,
  rulesetVersion: 1,
  defaultSeed: 0x52454c59,
  world: Object.freeze({
    kind: 'relay-field',
    sourceCourse: null,
    canonicalSector: 'THE BLACKOUT RELAY',
    canonicalDestination: 'RELAY HEART',
    sunDirection: Object.freeze([0.48, 0.22, -0.85] as const),
    attractLoopDistance: 18_000,
  }),
  objective: Object.freeze({
    kind: 'collection',
    path: RELAY_HARVEST_PATH,
    activeSources: 5,
    requiredSources: 3,
    chargePerSource: 20,
    chargeRequired: 60,
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
