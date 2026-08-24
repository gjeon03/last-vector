import type { RunResult } from './contracts.ts';
import type { CourseId, RankLetter } from './Courses.ts';
import { isCourseId, PRECISION_MAX_OFFSET } from './Courses.ts';
import { hasBestRunPrefix } from './Settings.ts';

export const PROGRESS_KEY = 'last-vector.progress.v1';
const HARNESS_SESSION_KEY = 'last-vector.progress.harness-session.v1';

const RANK_ORDER: readonly RankLetter[] = ['S', 'A', 'B', 'C', 'D'];

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CourseProgress {
  cleared: boolean;
  clearedAt: number | null;
  highestRank: RankLetter | null;
  cleanClear: boolean;
  precisionClear: boolean;
}

export interface ProgressV1 {
  version: 1;
  selectedCourse: CourseId;
  courses: Partial<Record<CourseId, CourseProgress>>;
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
  newlyUnlocked: CourseId | null;
  progress: ProgressV1;
  persistence: ProgressWriteOutcome;
}

export interface SelectCourseOutcome {
  accepted: boolean;
  progress: ProgressV1;
  persistence: ProgressWriteOutcome;
}

interface StoredProgress {
  present: boolean;
  parsed: ProgressV1 | null;
  newerVersion: boolean;
}

export interface ProgressStoreOptions {
  localStorage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
  hasLegacyCairnBest?: () => boolean;
  now?: () => number;
}

const emptyCourseProgress = (): CourseProgress => ({
  cleared: false,
  clearedAt: null,
  highestRank: null,
  cleanClear: false,
  precisionClear: false,
});

const emptyProgress = (): ProgressV1 => ({
  version: 1,
  selectedCourse: 'cairn-drift',
  courses: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRank = (value: unknown): value is RankLetter =>
  typeof value === 'string' && RANK_ORDER.includes(value as RankLetter);

function sanitizeCourseProgress(value: unknown): CourseProgress | null {
  if (!isRecord(value)) return null;
  return {
    cleared: value['cleared'] === true,
    clearedAt:
      value['clearedAt'] === null || value['clearedAt'] === undefined
        ? null
        : typeof value['clearedAt'] === 'number' && Number.isFinite(value['clearedAt']) && value['clearedAt'] >= 0
          ? value['clearedAt']
          : null,
    highestRank: isRank(value['highestRank']) ? value['highestRank'] : null,
    cleanClear: value['cleanClear'] === true,
    precisionClear: value['precisionClear'] === true,
  };
}

function sanitizeProgress(value: unknown): { progress: ProgressV1 | null; newerVersion: boolean } {
  if (!isRecord(value)) return { progress: null, newerVersion: false };
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { progress: null, newerVersion: false };
  }

  const courses: Partial<Record<CourseId, CourseProgress>> = {};
  const rawCourses = value['courses'];
  if (isRecord(rawCourses)) {
    for (const [id, raw] of Object.entries(rawCourses)) {
      if (!isCourseId(id)) continue;
      const parsed = sanitizeCourseProgress(raw);
      if (parsed) courses[id] = parsed;
    }
  }

  return {
    progress: {
      version: 1,
      selectedCourse: isCourseId(value['selectedCourse']) ? value['selectedCourse'] : 'cairn-drift',
      courses,
    },
    newerVersion: version > 1,
  };
}

function readStored(storage: StorageLike | null): StoredProgress {
  if (!storage) return { present: false, parsed: null, newerVersion: false };
  try {
    const raw = storage.getItem(PROGRESS_KEY);
    if (raw === null) return { present: false, parsed: null, newerVersion: false };
    const sanitized = sanitizeProgress(JSON.parse(raw) as unknown);
    return { present: true, parsed: sanitized.progress, newerVersion: sanitized.newerVersion };
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

function mergeCourse(a?: CourseProgress, b?: CourseProgress): CourseProgress | undefined {
  if (!a && !b) return undefined;
  const left = a ?? emptyCourseProgress();
  const right = b ?? emptyCourseProgress();
  return {
    cleared: left.cleared || right.cleared,
    clearedAt: earlierTime(left.clearedAt, right.clearedAt),
    highestRank: betterRank(left.highestRank, right.highestRank),
    cleanClear: left.cleanClear || right.cleanClear,
    precisionClear: left.precisionClear || right.precisionClear,
  };
}

function cloneProgress(progress: ProgressV1): ProgressV1 {
  const courses: Partial<Record<CourseId, CourseProgress>> = {};
  for (const id of ['cairn-drift', 'needle-grave'] as const) {
    const source = progress.courses[id];
    if (source) courses[id] = { ...source };
  }
  return { version: 1, selectedCourse: progress.selectedCourse, courses };
}

function defaultStorage(kind: 'localStorage' | 'sessionStorage'): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    return null;
  }
}

export function isCourseUnlocked(progress: ProgressV1, courseId: CourseId): boolean {
  return courseId === 'cairn-drift' || progress.courses['cairn-drift']?.cleared === true;
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
    this.session =
      options.sessionStorage === undefined ? defaultStorage('sessionStorage') : options.sessionStorage;
    this.legacyProbe = options.hasLegacyCairnBest ?? (() => hasBestRunPrefix('cairn-drift-'));
    this.now = options.now ?? (() => Date.now());
    this.reload();
  }

  reload(): ProgressV1 {
    this.sessionOnly = hasHarnessSession(this.session);
    const local = readStored(this.local);
    const session = readStored(this.session);
    this.localReadOnly = local.newerVersion;
    this.sessionReadOnly = session.newerVersion;

    const merged = emptyProgress();
    for (const id of ['cairn-drift', 'needle-grave'] as const) {
      const course = mergeCourse(local.parsed?.courses[id], session.parsed?.courses[id]);
      if (course) merged.courses[id] = course;
    }

    if (!local.present && !session.present && this.legacyProbe()) {
      merged.courses['cairn-drift'] = { ...emptyCourseProgress(), cleared: true };
    }

    const requested = session.parsed?.selectedCourse ?? local.parsed?.selectedCourse ?? 'cairn-drift';
    merged.selectedCourse = isCourseUnlocked(merged, requested) ? requested : 'cairn-drift';
    this.current = merged;
    return this.snapshot();
  }

  snapshot(): ProgressV1 {
    return cloneProgress(this.current);
  }

  isUnlocked(courseId: CourseId): boolean {
    return isCourseUnlocked(this.current, courseId);
  }

  selectCourse(courseId: CourseId): SelectCourseOutcome {
    if (!this.isUnlocked(courseId)) {
      return { accepted: false, progress: this.snapshot(), persistence: this.noWriteOutcome() };
    }
    this.current.selectedCourse = courseId;
    const persistence = this.persist();
    return { accepted: true, progress: this.snapshot(), persistence };
  }

  recordSuccessfulFinish(courseId: CourseId, result: RunResult): FinishProgressOutcome {
    const beforeNeedle = this.isUnlocked('needle-grave');
    const previous = this.current.courses[courseId] ?? emptyCourseProgress();
    const firstClear = !previous.cleared;
    const rank = isRank(result.rank) ? result.rank : null;
    const precise =
      typeof result.maxGateOffset === 'number' &&
      Number.isFinite(result.maxGateOffset) &&
      result.maxGateOffset < PRECISION_MAX_OFFSET;
    this.current.courses[courseId] = {
      cleared: true,
      clearedAt: previous.clearedAt ?? this.now(),
      highestRank: betterRank(previous.highestRank, rank),
      cleanClear: previous.cleanClear || result.cleanRun,
      precisionClear: previous.precisionClear || precise,
    };
    const persistence = this.persist();
    const afterNeedle = this.isUnlocked('needle-grave');
    return {
      firstClear,
      newlyUnlocked: !beforeNeedle && afterNeedle ? 'needle-grave' : null,
      progress: this.snapshot(),
      persistence,
    };
  }

  /**
   * Test-only validated installation. It is deliberately session-only: automation can prove a
   * reload without gaining a console-callable path that overwrites a player's durable progress.
   */
  install(value: unknown): ProgressWriteOutcome {
    const sanitized = sanitizeProgress(value).progress;
    this.current = sanitized ?? emptyProgress();
    if (!this.isUnlocked(this.current.selectedCourse)) this.current.selectedCourse = 'cairn-drift';
    this.sessionOnly = true;
    const markerWritten = this.write(
      this.session,
      '1',
      this.sessionReadOnly,
      HARNESS_SESSION_KEY,
    );
    const sessionWritten = markerWritten && this.write(
      this.session,
      JSON.stringify(this.current),
      this.sessionReadOnly,
    );
    return {
      sessionWritten,
      localWritten: false,
      reloadSafe: sessionWritten,
      sessionReadOnly: this.sessionReadOnly,
      localReadOnly: this.localReadOnly,
    };
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
