import {
  CAIRN_DRIFT,
  KNOWN_COURSE_ORDER,
  type CourseDefinition,
  type CourseId,
  type FlightPathDefinition,
  type RadioAuthoringDefinition,
} from './Courses.ts';
import {
  LAST_ASCENT_DEFAULT_SEED,
  LAST_ASCENT_PATH,
  LAST_ASCENT_PRESENTATION_COURSE,
  LAST_ASCENT_RADIO,
} from '../game/missions/LastAscentDefinition.ts';
import { DEAD_SIGNAL_MISSION } from '../game/missions/DeadSignalMission.ts';

export type MissionId = 'cairn-drift' | 'last-ascent' | 'dead-signal';
export type MissionChapter = 1 | 2 | 3;
export type MissionCapability = 'fire';
export type MasteryId = 'precision' | 'all-nodes' | 'accuracy';

export interface GateRaceObjectiveDefinition {
  readonly kind: 'gate-race';
  readonly path: FlightPathDefinition;
  readonly gates: CourseDefinition;
}

/** Contract only. A chapter branch supplies authored values when its mission exists. */
export interface EscapeObjectiveDefinition {
  readonly kind: 'escape';
  readonly path: FlightPathDefinition;
  readonly shockwave: {
    readonly speed: number;
    readonly startProgress: number;
    readonly catchProgress: number;
  };
}

/** Contract only. The foundation does not ship target groups or weapon capability. */
export interface StrikeObjectiveDefinition {
  readonly kind: 'strike';
  readonly path: FlightPathDefinition;
  readonly targets: readonly {
    readonly id: string;
    readonly required: boolean;
    readonly hitPoints: number;
  }[];
  readonly extraction: {
    readonly startProgress: number;
    readonly timeoutSeconds: number;
  };
}

export type ObjectiveDefinition =
  | GateRaceObjectiveDefinition
  | EscapeObjectiveDefinition
  | StrikeObjectiveDefinition;

/**
 * Serializable authoring boundary. Render objects and collision arrays belong to World at
 * runtime; storage, interface and success state never do.
 */
export interface WorldDefinition {
  readonly kind: 'frontier';
  readonly sourceCourse: CourseDefinition;
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
  world: { kind: 'frontier', sourceCourse: CAIRN_DRIFT },
  objective: { kind: 'gate-race', path: CAIRN_DRIFT.geometry, gates: CAIRN_DRIFT },
  mastery: ['precision'],
  radio: CAIRN_DRIFT.radio,
  capabilities: [],
};

export const LAST_ASCENT_MISSION: MissionDefinition = {
  id: 'last-ascent',
  chapter: 2,
  rulesetVersion: 1,
  defaultSeed: LAST_ASCENT_DEFAULT_SEED,
  world: { kind: 'frontier', sourceCourse: LAST_ASCENT_PRESENTATION_COURSE },
  objective: {
    kind: 'escape',
    path: LAST_ASCENT_PATH,
    shockwave: {
      speed: 0.0055,
      startProgress: -0.08,
      catchProgress: 0.3325,
    },
  },
  mastery: ['precision'],
  radio: LAST_ASCENT_RADIO,
  capabilities: [],
};

export const ACTIVE_MISSION_ORDER = [
  'cairn-drift',
  'last-ascent',
  'dead-signal',
] as const satisfies readonly MissionId[];
export const DORMANT_COURSE_ORDER = KNOWN_COURSE_ORDER.filter(
  (id): id is Exclude<CourseId, MissionId> => id !== 'cairn-drift',
);

export const MISSION_CATALOG: Readonly<Record<MissionId, MissionDefinition>> = {
  'cairn-drift': CAIRN_MISSION,
  'last-ascent': LAST_ASCENT_MISSION,
  'dead-signal': DEAD_SIGNAL_MISSION,
};

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
