import type { MissionResult } from './contracts.ts';
import type { CourseId, RankLetter } from './Courses.ts';
import { KNOWN_COURSE_ORDER, PRECISION_MAX_OFFSET, isCourseId } from './Courses.ts';
import {
  ACTIVE_MISSION_ORDER,
  DEFAULT_MISSION_ID,
  DORMANT_COURSE_ORDER,
  getMissionDefinition,
  isMissionId,
  type MasteryId,
  type MissionId,
} from './Missions.ts';
import { hasBestRunPrefix } from './Settings.ts';

export const PROGRESS_KEY = 'last-vector.progress.v2';
export const LEGACY_PROGRESS_KEY = 'last-vector.progress.v1';
const HARNESS_SESSION_KEY = 'last-vector.progress.harness-session.v2';

const RANK_ORDER: readonly RankLetter[] = ['S', 'A', 'B', 'C', 'D'];

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MissionProgress {
  cleared: boolean;
  /** Earliest known successful finish timestamp; null when legacy data cannot establish it. */
  clearedAt: number | null;
  highestRank: RankLetter | null;
  cleanClear: boolean;
  mastery: Partial<Record<MasteryId, true>>;
}

/** Recognized retired facts. They never participate in mission clear or unlock derivation. */
export interface DormantCourseProgress {
  cleared: boolean;
  clearedAt: number | null;
  highestRank: RankLetter | null;
  cleanClear: boolean;
  precisionClear: boolean;
}

export interface ProgressV2 {
  version: 2;
  selectedMission: MissionId;
  missions: Partial<Record<MissionId, MissionProgress>>;
  dormantCourses: Partial<Record<Exclude<CourseId, MissionId>, DormantCourseProgress>>;
}

export interface ProgressWriteOutcome {
  sessionWritten: boolean;
  localWritten: boolean;
  reloadSafe: boolean;
  sessionReadOnly: boolean;
  localReadOnly: boolean;
}

export interface FinishProgressOutcome {
  firstClear: boolean;
  newlyUnlocked: MissionId | null;
  progress: ProgressV2;
  persistence: ProgressWriteOutcome;
}

export interface SelectMissionOutcome {
  accepted: boolean;
  progress: ProgressV2;
  persistence: ProgressWriteOutcome;
}

interface StoredProgress {
  present: boolean;
  parsed: ProgressV2 | null;
  newerVersion: boolean;
}

export interface ProgressStoreOptions {
  localStorage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
  hasLegacyCairnBest?: () => boolean;
  now?: () => number;
}

const emptyMissionProgress = (): MissionProgress => ({
  cleared: false,
  clearedAt: null,
  highestRank: null,
  cleanClear: false,
  mastery: {},
});

const emptyDormantProgress = (): DormantCourseProgress => ({
  cleared: false,
  clearedAt: null,
  highestRank: null,
  cleanClear: false,
  precisionClear: false,
});

const emptyProgress = (): ProgressV2 => ({
  version: 2,
  selectedMission: DEFAULT_MISSION_ID,
  missions: {},
  dormantCourses: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRank = (value: unknown): value is RankLetter =>
  typeof value === 'string' && RANK_ORDER.includes(value as RankLetter);

function clearedAt(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
}

function sanitizeMissionProgress(missionId: MissionId, value: unknown): MissionProgress | null {
  if (!isRecord(value)) return null;
  const mastery: Partial<Record<MasteryId, true>> = {};
  const rawMastery = value['mastery'];
  if (isRecord(rawMastery)) {
    for (const id of getMissionDefinition(missionId).mastery) {
      if (rawMastery[id] === true) mastery[id] = true;
    }
  }
  return {
    cleared: value['cleared'] === true,
    clearedAt: clearedAt(value['clearedAt']),
    highestRank: isRank(value['highestRank']) ? value['highestRank'] : null,
    cleanClear: value['cleanClear'] === true,
    mastery,
  };
}

function sanitizeDormantProgress(value: unknown): DormantCourseProgress | null {
  if (!isRecord(value)) return null;
  return {
    cleared: value['cleared'] === true,
    clearedAt: clearedAt(value['clearedAt']),
    highestRank: isRank(value['highestRank']) ? value['highestRank'] : null,
    cleanClear: value['cleanClear'] === true,
    precisionClear: value['precisionClear'] === true,
  };
}

function sanitizeV2(value: unknown): { progress: ProgressV2 | null; newerVersion: boolean } {
  if (!isRecord(value)) return { progress: null, newerVersion: false };
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 2) {
    return { progress: null, newerVersion: false };
  }
  const progress = emptyProgress();
  const rawMissions = value['missions'];
  if (isRecord(rawMissions)) {
    for (const [id, raw] of Object.entries(rawMissions)) {
      if (!isMissionId(id)) continue;
      const parsed = sanitizeMissionProgress(id, raw);
      if (parsed) progress.missions[id] = parsed;
    }
  }
  const rawDormant = value['dormantCourses'];
  if (isRecord(rawDormant)) {
    for (const [id, raw] of Object.entries(rawDormant)) {
      if (!isCourseId(id) || isMissionId(id)) continue;
      const parsed = sanitizeDormantProgress(raw);
      if (parsed) progress.dormantCourses[id] = parsed;
    }
  }
  progress.selectedMission = isMissionId(value['selectedMission'])
    ? value['selectedMission']
    : DEFAULT_MISSION_ID;
  return { progress, newerVersion: version > 2 };
}

function migrateV1(value: unknown): { progress: ProgressV2 | null; newerVersion: boolean } {
  if (!isRecord(value)) return { progress: null, newerVersion: false };
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { progress: null, newerVersion: false };
  }
  if (version > 1) return { progress: null, newerVersion: true };
  const progress = emptyProgress();
  const courses = value['courses'];
  if (isRecord(courses)) {
    const cairn = sanitizeDormantProgress(courses[DEFAULT_MISSION_ID]);
    if (cairn) {
      progress.missions[DEFAULT_MISSION_ID] = {
        cleared: cairn.cleared,
        clearedAt: cairn.clearedAt,
        highestRank: cairn.highestRank,
        cleanClear: cairn.cleanClear,
        mastery: cairn.precisionClear ? { precision: true } : {},
      };
    }
    for (const id of DORMANT_COURSE_ORDER) {
      const dormant = sanitizeDormantProgress(courses[id]);
      if (dormant) progress.dormantCourses[id] = dormant;
    }
  }
  return { progress, newerVersion: false };
}

function readStored(storage: StorageLike | null): StoredProgress {
  if (!storage) return { present: false, parsed: null, newerVersion: false };
  try {
    const current = storage.getItem(PROGRESS_KEY);
    if (current !== null) {
      const sanitized = sanitizeV2(JSON.parse(current) as unknown);
      return { present: true, parsed: sanitized.progress, newerVersion: sanitized.newerVersion };
    }
    const legacy = storage.getItem(LEGACY_PROGRESS_KEY);
    if (legacy === null) return { present: false, parsed: null, newerVersion: false };
    const migrated = migrateV1(JSON.parse(legacy) as unknown);
    return { present: true, parsed: migrated.progress, newerVersion: migrated.newerVersion };
  } catch {
    return { present: true, parsed: null, newerVersion: false };
  }
}

function hasHarnessSession(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(HARNESS_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function betterRank(a: RankLetter | null, b: RankLetter | null): RankLetter | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK_ORDER.indexOf(a) <= RANK_ORDER.indexOf(b) ? a : b;
}

function earlierTime(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function mergeMission(
  missionId: MissionId,
  a?: MissionProgress,
  b?: MissionProgress,
): MissionProgress | undefined {
  if (!a && !b) return undefined;
  const left = a ?? emptyMissionProgress();
  const right = b ?? emptyMissionProgress();
  const mastery: Partial<Record<MasteryId, true>> = {};
  for (const id of getMissionDefinition(missionId).mastery) {
    if (left.mastery[id] || right.mastery[id]) mastery[id] = true;
  }
  return {
    cleared: left.cleared || right.cleared,
    clearedAt: earlierTime(left.clearedAt, right.clearedAt),
    highestRank: betterRank(left.highestRank, right.highestRank),
    cleanClear: left.cleanClear || right.cleanClear,
    mastery,
  };
}

function mergeDormant(
  a?: DormantCourseProgress,
  b?: DormantCourseProgress,
): DormantCourseProgress | undefined {
  if (!a && !b) return undefined;
  const left = a ?? emptyDormantProgress();
  const right = b ?? emptyDormantProgress();
  return {
    cleared: left.cleared || right.cleared,
    clearedAt: earlierTime(left.clearedAt, right.clearedAt),
    highestRank: betterRank(left.highestRank, right.highestRank),
    cleanClear: left.cleanClear || right.cleanClear,
    precisionClear: left.precisionClear || right.precisionClear,
  };
}

function cloneProgress(progress: ProgressV2): ProgressV2 {
  const clone = emptyProgress();
  clone.selectedMission = progress.selectedMission;
  for (const id of ACTIVE_MISSION_ORDER) {
    const source = progress.missions[id];
    if (source) clone.missions[id] = { ...source, mastery: { ...source.mastery } };
  }
  for (const id of DORMANT_COURSE_ORDER) {
    const source = progress.dormantCourses[id];
    if (source) clone.dormantCourses[id] = { ...source };
  }
  return clone;
}

function defaultStorage(kind: 'localStorage' | 'sessionStorage'): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    return null;
  }
}

export function isMissionUnlocked(progress: ProgressV2, missionId: MissionId): boolean {
  const index = ACTIVE_MISSION_ORDER.indexOf(missionId);
  if (index < 0) return false;
  for (let prior = 0; prior < index; prior++) {
    if (progress.missions[ACTIVE_MISSION_ORDER[prior]!]?.cleared !== true) return false;
  }
  return true;
}

export class ProgressStore {
  private readonly local: StorageLike | null;
  private readonly session: StorageLike | null;
  private readonly legacyProbe: () => boolean;
  private readonly now: () => number;
  private current = emptyProgress();
  private localReadOnly = false;
  private sessionReadOnly = false;
  private sessionOnly = false;

  constructor(options: ProgressStoreOptions = {}) {
    this.local = options.localStorage === undefined ? defaultStorage('localStorage') : options.localStorage;
    this.session = options.sessionStorage === undefined
      ? defaultStorage('sessionStorage')
      : options.sessionStorage;
    this.legacyProbe = options.hasLegacyCairnBest ?? (() => hasBestRunPrefix('cairn-drift-'));
    this.now = options.now ?? (() => Date.now());
    this.reload();
  }

  reload(): ProgressV2 {
    this.sessionOnly = hasHarnessSession(this.session);
    const local = readStored(this.local);
    const session = readStored(this.session);
    this.localReadOnly = local.newerVersion;
    this.sessionReadOnly = session.newerVersion;
    const merged = this.merge(local.parsed, session.parsed);
    if (!local.present && !session.present && this.legacyProbe()) {
      merged.missions[DEFAULT_MISSION_ID] = { ...emptyMissionProgress(), cleared: true };
    }
    const requested = session.parsed?.selectedMission
      ?? local.parsed?.selectedMission
      ?? DEFAULT_MISSION_ID;
    merged.selectedMission = isMissionUnlocked(merged, requested) ? requested : DEFAULT_MISSION_ID;
    this.current = merged;
    return this.snapshot();
  }

  snapshot(): ProgressV2 {
    return cloneProgress(this.current);
  }

  isUnlocked(missionId: MissionId): boolean {
    return isMissionUnlocked(this.current, missionId);
  }

  selectMission(missionId: MissionId): SelectMissionOutcome {
    if (!this.isUnlocked(missionId)) {
      return { accepted: false, progress: this.snapshot(), persistence: this.noWriteOutcome() };
    }
    this.current.selectedMission = missionId;
    const persistence = this.persist();
    return { accepted: true, progress: this.snapshot(), persistence };
  }

  recordSuccessfulFinish(missionId: MissionId, result: MissionResult): FinishProgressOutcome {
    const unlockedBefore = new Set(ACTIVE_MISSION_ORDER.filter((id) => this.isUnlocked(id)));
    const previous = this.current.missions[missionId] ?? emptyMissionProgress();
    const rank = isRank(result.rank) ? result.rank : null;
    const mastery = { ...previous.mastery };
    if (result.kind === 'gate-race'
      && result.maxGateOffset < PRECISION_MAX_OFFSET
      && getMissionDefinition(missionId).mastery.includes('precision')) {
      mastery.precision = true;
    }
    this.current.missions[missionId] = {
      cleared: true,
      clearedAt: previous.clearedAt ?? this.now(),
      highestRank: betterRank(previous.highestRank, rank),
      cleanClear: previous.cleanClear || result.cleanRun,
      mastery,
    };
    const persistence = this.persist();
    const newlyUnlocked = ACTIVE_MISSION_ORDER.find(
      (id) => !unlockedBefore.has(id) && this.isUnlocked(id),
    ) ?? null;
    return { firstClear: !previous.cleared, newlyUnlocked, progress: this.snapshot(), persistence };
  }

  install(value: unknown): ProgressWriteOutcome {
    const sanitized = sanitizeV2(value).progress;
    this.current = sanitized ?? emptyProgress();
    if (!this.isUnlocked(this.current.selectedMission)) {
      this.current.selectedMission = DEFAULT_MISSION_ID;
    }
    this.sessionOnly = true;
    const markerWritten = this.write(this.session, '1', this.sessionReadOnly, HARNESS_SESSION_KEY);
    const sessionWritten = markerWritten
      && this.write(this.session, JSON.stringify(this.current), this.sessionReadOnly);
    return {
      sessionWritten,
      localWritten: false,
      reloadSafe: sessionWritten,
      sessionReadOnly: this.sessionReadOnly,
      localReadOnly: this.localReadOnly,
    };
  }

  private merge(a: ProgressV2 | null, b: ProgressV2 | null): ProgressV2 {
    const merged = emptyProgress();
    for (const id of ACTIVE_MISSION_ORDER) {
      const mission = mergeMission(id, a?.missions[id], b?.missions[id]);
      if (mission) merged.missions[id] = mission;
    }
    for (const id of DORMANT_COURSE_ORDER) {
      const dormant = mergeDormant(a?.dormantCourses[id], b?.dormantCourses[id]);
      if (dormant) merged.dormantCourses[id] = dormant;
    }
    return merged;
  }

  private noWriteOutcome(): ProgressWriteOutcome {
    return {
      sessionWritten: false,
      localWritten: false,
      reloadSafe: false,
      sessionReadOnly: this.sessionReadOnly,
      localReadOnly: this.localReadOnly,
    };
  }

  private persist(): ProgressWriteOutcome {
    this.mergeLatestForPersist();
    const serialized = JSON.stringify(this.current);
    const sessionWritten = this.write(this.session, serialized, this.sessionReadOnly);
    const localWritten = this.sessionOnly
      ? false
      : this.write(this.local, serialized, this.localReadOnly);
    return {
      sessionWritten,
      localWritten,
      reloadSafe: sessionWritten || localWritten,
      sessionReadOnly: this.sessionReadOnly,
      localReadOnly: this.localReadOnly,
    };
  }

  private mergeLatestForPersist(): void {
    this.sessionOnly = this.sessionOnly || hasHarnessSession(this.session);
    const local = this.sessionOnly
      ? { present: false, parsed: null, newerVersion: false }
      : readStored(this.local);
    const session = readStored(this.session);
    this.localReadOnly = this.localReadOnly || local.newerVersion;
    this.sessionReadOnly = this.sessionReadOnly || session.newerVersion;
    const stored = this.merge(local.parsed, session.parsed);
    const merged = this.merge(stored, this.current);
    const requested = this.current.selectedMission;
    merged.selectedMission = isMissionUnlocked(merged, requested) ? requested : DEFAULT_MISSION_ID;
    this.current = merged;
  }

  private write(
    storage: StorageLike | null,
    value: string,
    readOnly: boolean,
    key = PROGRESS_KEY,
  ): boolean {
    if (!storage || readOnly) return false;
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
}

// Deliberately referenced here so a catalog contraction cannot make dormant data silently vanish.
if (KNOWN_COURSE_ORDER.length !== ACTIVE_MISSION_ORDER.length + DORMANT_COURSE_ORDER.length) {
  throw new Error('Mission and dormant course catalogs do not partition recognized data');
}
