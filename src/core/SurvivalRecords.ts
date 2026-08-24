import type { SurvivalResult, SurvivalRunStats } from '../game/SurvivalRun.ts';
import { SURVIVAL_RULESET_ID } from '../game/SurvivalRun.ts';

export const SURVIVAL_RECORDS_KEY = 'last-vector.survival-records.v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface SurvivalBestRecord {
  rulesetId: string;
  seed: number;
  scoreSeconds: number;
  achievedAt: number;
  stats: SurvivalRunStats;
}

export interface SurvivalRecordsV1 {
  version: 1;
  bests: Record<string, SurvivalBestRecord>;
}

export interface SurvivalRecordPersistence {
  written: boolean;
  reloadSafe: boolean;
  readOnly: boolean;
}

export interface RecordSurvivalOutcome {
  accepted: boolean;
  isNewBest: boolean;
  best: SurvivalBestRecord | null;
  records: SurvivalRecordsV1;
  persistence: SurvivalRecordPersistence;
}

export interface SurvivalRecordStoreOptions {
  storage?: StorageLike | null;
  now?: () => number;
}

interface StoredRecords {
  records: SurvivalRecordsV1 | null;
  newerVersion: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const emptyRecords = (): SurvivalRecordsV1 => ({ version: 1, bests: {} });

const emptyStats = (): SurvivalRunStats => ({
  patternsScheduled: 0,
  patternsEmitted: 0,
  patternsDropped: 0,
  meteorsScheduled: 0,
  meteorsSpawned: 0,
  meteorsDodged: 0,
  nearMisses: 0,
  collisions: 0,
  peakActive: 0,
});

const cloneStats = (stats: SurvivalRunStats): SurvivalRunStats => ({ ...stats });

function cloneBest(best: SurvivalBestRecord): SurvivalBestRecord {
  return { ...best, stats: cloneStats(best.stats) };
}

function cloneRecords(records: SurvivalRecordsV1): SurvivalRecordsV1 {
  const bests: Record<string, SurvivalBestRecord> = {};
  for (const [id, best] of Object.entries(records.bests)) bests[id] = cloneBest(best);
  return { version: 1, bests };
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
      ? value
      : null;
}

function safeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeRulesetId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

function sanitizeStats(value: unknown): SurvivalRunStats | null {
  if (!isRecord(value)) return null;
  const stats = emptyStats();
  for (const key of Object.keys(stats) as (keyof SurvivalRunStats)[]) {
    const parsed = safeInteger(value[key]);
    if (parsed === null) return null;
    stats[key] = parsed;
  }
  return stats;
}

function sanitizeBest(value: unknown, key: string): SurvivalBestRecord | null {
  if (!isRecord(value)) return null;
  const rulesetId = safeRulesetId(value['rulesetId']);
  const seed = safeInteger(value['seed']);
  const scoreSeconds = safeFinite(value['scoreSeconds']);
  const achievedAt = safeFinite(value['achievedAt']);
  const stats = sanitizeStats(value['stats']);
  if (
    rulesetId === null
    || rulesetId !== key
    || seed === null
    || seed > 0xffff_ffff
    || scoreSeconds === null
    || achievedAt === null
    || stats === null
  ) return null;
  return { rulesetId, seed, scoreSeconds, achievedAt, stats };
}

function sanitizeRecords(value: unknown): StoredRecords {
  if (!isRecord(value)) return { records: null, newerVersion: false };
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { records: null, newerVersion: false };
  }

  const records = emptyRecords();
  if (isRecord(value['bests'])) {
    for (const [key, rawBest] of Object.entries(value['bests'])) {
      if (safeRulesetId(key) === null) continue;
      const best = sanitizeBest(rawBest, key);
      if (best) records.bests[key] = best;
    }
  }
  return { records, newerVersion: version > 1 };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function validResult(value: SurvivalResult): boolean {
  return safeRulesetId(value.rulesetId) !== null
    && safeFinite(value.scoreSeconds) !== null
    && safeInteger(value.seed) !== null
    && value.seed <= 0xffff_ffff
    && sanitizeStats(value.stats) !== null;
}

export class SurvivalRecordStore {
  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private current = emptyRecords();
  private readOnly = false;

  constructor(options: SurvivalRecordStoreOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.now = options.now ?? (() => Date.now());
    this.reload();
  }

  reload(): SurvivalRecordsV1 {
    let stored: StoredRecords = { records: null, newerVersion: false };
    try {
      const raw = this.storage?.getItem(SURVIVAL_RECORDS_KEY) ?? null;
      if (raw !== null) stored = sanitizeRecords(JSON.parse(raw) as unknown);
    } catch {
      stored = { records: null, newerVersion: false };
    }
    this.current = stored.records ?? emptyRecords();
    this.readOnly = stored.newerVersion;
    return this.snapshot();
  }

  snapshot(): SurvivalRecordsV1 {
    return cloneRecords(this.current);
  }

  getBest(rulesetId = SURVIVAL_RULESET_ID): SurvivalBestRecord | null {
    const best = this.current.bests[rulesetId];
    return best ? cloneBest(best) : null;
  }

  record(result: SurvivalResult): RecordSurvivalOutcome {
    if (!validResult(result)) {
      return {
        accepted: false,
        isNewBest: false,
        best: this.getBest(result.rulesetId),
        records: this.snapshot(),
        persistence: this.persistence(false),
      };
    }

    const previous = this.current.bests[result.rulesetId];
    // Ordering is deliberately score-only. Stats and seed are evidence, never tie-breakers.
    if (previous && previous.scoreSeconds >= result.scoreSeconds) {
      return {
        accepted: true,
        isNewBest: false,
        best: cloneBest(previous),
        records: this.snapshot(),
        persistence: this.persistence(false),
      };
    }

    const achievedAt = this.now();
    const record: SurvivalBestRecord = {
      rulesetId: result.rulesetId,
      seed: result.seed >>> 0,
      scoreSeconds: Math.round(result.scoreSeconds * 1000) / 1000,
      achievedAt: Number.isFinite(achievedAt) && achievedAt >= 0 ? achievedAt : 0,
      stats: sanitizeStats(result.stats) ?? emptyStats(),
    };
    this.current.bests[result.rulesetId] = record;
    const written = this.write();
    return {
      accepted: true,
      isNewBest: true,
      best: cloneBest(record),
      records: this.snapshot(),
      persistence: this.persistence(written),
    };
  }

  private persistence(written: boolean): SurvivalRecordPersistence {
    return { written, reloadSafe: written, readOnly: this.readOnly };
  }

  private write(): boolean {
    if (!this.storage || this.readOnly) return false;
    try {
      this.storage.setItem(SURVIVAL_RECORDS_KEY, JSON.stringify(this.current));
      return true;
    } catch {
      return false;
    }
  }
}
