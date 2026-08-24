/**
 * Browser- and renderer-free rules for the meteor survival mode.
 *
 * The scheduler consumes absolute run time, not render-frame deltas. Every pattern and meteor is
 * derived from `(ruleset, seed, pattern index, ordinal)`, so a 60 Hz and 120 Hz client produces
 * the same directives. Rendering owns the fixed object pool; this module only respects its
 * reported free capacity and never builds an unbounded catch-up queue.
 */

export const SURVIVAL_RULESET_ID = 'meteor-survival-v1' as const;

export type SurvivalPatternKind = 'single' | 'pair' | 'cross' | 'burst' | 'lane-wall';

export interface SurvivalRuleset {
  readonly id: typeof SURVIVAL_RULESET_ID;
  readonly graceSeconds: number;
  readonly maxDifficultySeconds: number;
  readonly maxActiveMeteors: number;
  readonly geometryVariants: number;
  readonly maxPatternSize: number;
  readonly maxPatternsPerAdvance: number;
  readonly maxSpawnsPerAdvance: number;
  readonly slowPatternIntervalSeconds: number;
  readonly fastPatternIntervalSeconds: number;
  readonly slowMeteorSpeed: number;
  readonly fastMeteorSpeed: number;
  readonly generousReactionSeconds: number;
  readonly minimumReactionSeconds: number;
  readonly minimumRadius: number;
  readonly maximumRadius: number;
  readonly maximumEntryAzimuthRadians: number;
  readonly maximumEntryElevationRadians: number;
}

export const SURVIVAL_RULESET_V1: Readonly<SurvivalRuleset> = Object.freeze({
  id: SURVIVAL_RULESET_ID,
  graceSeconds: 10,
  maxDifficultySeconds: 300,
  maxActiveMeteors: 128,
  geometryVariants: 8,
  maxPatternSize: 5,
  maxPatternsPerAdvance: 8,
  maxSpawnsPerAdvance: 24,
  slowPatternIntervalSeconds: 2.25,
  fastPatternIntervalSeconds: 0.68,
  slowMeteorSpeed: 170,
  fastMeteorSpeed: 520,
  generousReactionSeconds: 4.2,
  minimumReactionSeconds: 2.4,
  minimumRadius: 4.5,
  maximumRadius: 14,
  maximumEntryAzimuthRadians: 1.15,
  maximumEntryElevationRadians: 0.55,
});

export type SurvivalDifficultyTier = 0 | 1 | 2 | 3 | 4 | 5;

export interface SurvivalDifficulty {
  /** Absolute seconds since the run began. */
  elapsedSeconds: number;
  /** Linear 0..1 progress between the end of grace and the five-minute ceiling. */
  progress: number;
  /** Smooth 0..1 value used for continuously changing speed and cadence. */
  intensity: number;
  tier: SurvivalDifficultyTier;
  patternIntervalSeconds: number;
  meteorSpeed: number;
  reactionSeconds: number;
  maxPatternSize: number;
}

export interface SurvivalSpawnDirective {
  /** Stable run-local identity. It does not depend on whether earlier pool requests succeeded. */
  spawnId: number;
  patternIndex: number;
  patternKind: SurvivalPatternKind;
  ordinal: number;
  patternSize: number;
  scheduledAt: number;
  /** Ship-local entry direction; zero azimuth/elevation is directly ahead. */
  entryAzimuthRadians: number;
  entryElevationRadians: number;
  /** Normalized intended crossing point in the survival play volume. */
  targetOffsetX: number;
  targetOffsetY: number;
  speed: number;
  reactionSeconds: number;
  radius: number;
  geometryVariant: number;
  spinAxis: readonly [number, number, number];
  spinRate: number;
}

export interface SurvivalPatternDirective {
  patternIndex: number;
  kind: SurvivalPatternKind;
  scheduledAt: number;
  difficulty: SurvivalDifficulty;
  spawns: readonly SurvivalSpawnDirective[];
}

export interface SurvivalRunStats {
  patternsScheduled: number;
  patternsEmitted: number;
  patternsDropped: number;
  meteorsScheduled: number;
  meteorsSpawned: number;
  meteorsDodged: number;
  nearMisses: number;
  collisions: number;
  peakActive: number;
}

export interface SurvivalAdvance {
  elapsedSeconds: number;
  difficulty: SurvivalDifficulty;
  patterns: readonly SurvivalPatternDirective[];
  droppedPatterns: number;
  droppedSpawns: number;
  nextPatternAt: number;
  stats: SurvivalRunStats;
}

export interface SurvivalResult {
  rulesetId: typeof SURVIVAL_RULESET_ID;
  seed: number;
  /** The only competitive score. Ancillary stats never alter ordering. */
  scoreSeconds: number;
  stats: SurvivalRunStats;
}

export interface SurvivalRunOptions {
  seed?: number;
  ruleset?: Readonly<SurvivalRuleset>;
}

const UINT32_MAX = 0xffff_ffff;
const SPAWN_ID_STRIDE = 8;
const DUE_EPSILON_SECONDS = 1e-9;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const lerp = (from: number, to: number, amount: number): number =>
  from + (to - from) * amount;

const smoothstep = (value: number): number => value * value * (3 - 2 * value);

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? value : 0;

export function normalizeSurvivalSeed(value: unknown, fallback = 0x51a7_0f1d): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback >>> 0;
  return Math.trunc(value) >>> 0;
}

/** A stateless uint32 avalanche; salts keep independently-derived fields decorrelated. */
function hashWord(seed: number, index: number, salt: number): number {
  let word = (seed ^ Math.imul((index + 1) | 0, 0x9e37_79b1) ^ salt) >>> 0;
  word = Math.imul(word ^ (word >>> 16), 0x7feb_352d) >>> 0;
  word = Math.imul(word ^ (word >>> 15), 0x846c_a68b) >>> 0;
  return (word ^ (word >>> 16)) >>> 0;
}

function unit(seed: number, index: number, salt: number): number {
  return hashWord(seed, index, salt) / (UINT32_MAX + 1);
}

function signed(seed: number, index: number, salt: number): number {
  return unit(seed, index, salt) * 2 - 1;
}

export function survivalDifficultyAt(
  elapsedSeconds: number,
  ruleset: Readonly<SurvivalRuleset> = SURVIVAL_RULESET_V1,
): SurvivalDifficulty {
  const elapsed = finiteNonNegative(elapsedSeconds);
  const rampDuration = Math.max(1, ruleset.maxDifficultySeconds - ruleset.graceSeconds);
  const progress = clamp((elapsed - ruleset.graceSeconds) / rampDuration, 0, 1);
  const intensity = smoothstep(progress);
  const tier = Math.min(5, Math.floor(progress * 5 + (progress >= 1 ? 1 : 0))) as SurvivalDifficultyTier;

  let maxPatternSize = 1;
  if (progress >= 0.18) maxPatternSize = 2;
  if (progress >= 0.42) maxPatternSize = 3;
  if (progress >= 0.68) maxPatternSize = 4;

  return {
    elapsedSeconds: elapsed,
    progress,
    intensity,
    tier,
    patternIntervalSeconds: lerp(
      ruleset.slowPatternIntervalSeconds,
      ruleset.fastPatternIntervalSeconds,
      intensity,
    ),
    meteorSpeed: lerp(ruleset.slowMeteorSpeed, ruleset.fastMeteorSpeed, intensity),
    reactionSeconds: lerp(
      ruleset.generousReactionSeconds,
      ruleset.minimumReactionSeconds,
      intensity,
    ),
    maxPatternSize: Math.min(ruleset.maxPatternSize, maxPatternSize),
  };
}

function patternKind(seed: number, patternIndex: number, difficulty: SurvivalDifficulty): SurvivalPatternKind {
  const roll = unit(seed, patternIndex, 0x1425_a37d);
  if (difficulty.maxPatternSize <= 1) return 'single';
  if (difficulty.maxPatternSize === 2) return roll < 0.48 ? 'single' : roll < 0.82 ? 'pair' : 'cross';
  if (difficulty.maxPatternSize === 3) {
    return roll < 0.25 ? 'single' : roll < 0.52 ? 'pair' : roll < 0.75 ? 'cross' : 'burst';
  }
  return roll < 0.14
    ? 'single'
    : roll < 0.32
      ? 'pair'
      : roll < 0.52
        ? 'cross'
        : roll < 0.75
          ? 'burst'
          : 'lane-wall';
}

function patternSize(kind: SurvivalPatternKind): number {
  switch (kind) {
    case 'single': return 1;
    case 'pair':
    case 'cross': return 2;
    case 'burst': return 3;
    case 'lane-wall': return 4;
  }
}

function targetFor(
  seed: number,
  patternIndex: number,
  kind: SurvivalPatternKind,
  ordinal: number,
): readonly [number, number] {
  const baseX = signed(seed, patternIndex, 0x4c13_56af) * 0.34;
  const baseY = signed(seed, patternIndex, 0x87a9_203d) * 0.28;
  switch (kind) {
    case 'single':
      return [baseX + signed(seed, patternIndex, 0xa91c_0873) * 0.34, baseY];
    case 'pair': {
      const gap = 0.3 + unit(seed, patternIndex, 0x273e_79b9) * 0.18;
      return [baseX + (ordinal === 0 ? -gap : gap), baseY + (ordinal === 0 ? -0.08 : 0.08)];
    }
    case 'cross': {
      const sign = ordinal === 0 ? -1 : 1;
      return [baseX + sign * 0.42, baseY - sign * 0.35];
    }
    case 'burst': {
      const angle = unit(seed, patternIndex, 0xc84a_6197) * Math.PI * 2 + ordinal * (Math.PI * 2 / 3);
      return [baseX + Math.cos(angle) * 0.4, baseY + Math.sin(angle) * 0.34];
    }
    case 'lane-wall': {
      // Five evenly spaced lanes with one deterministic opening. Four rocks make the gap real,
      // rather than asking a later collision layer to infer whether a random wall is survivable.
      const safeLane = hashWord(seed, patternIndex, 0x62d5_3f81) % 5;
      const occupiedLane = ordinal >= safeLane ? ordinal + 1 : ordinal;
      return [-0.8 + occupiedLane * 0.4, baseY * 0.55];
    }
  }
}

function normalizedAxis(seed: number, spawnId: number): readonly [number, number, number] {
  let x = signed(seed, spawnId, 0x18ed_a321);
  let y = signed(seed, spawnId, 0xd390_47cf);
  let z = signed(seed, spawnId, 0x6ab7_5e09);
  const length = Math.hypot(x, y, z);
  if (length < 1e-6) return [0, 1, 0];
  x /= length;
  y /= length;
  z /= length;
  return [x, y, z];
}

/** Pure derivation used both by the live scheduler and browser-free contract probes. */
export function deriveSurvivalPattern(
  seedValue: number,
  patternIndex: number,
  scheduledAt: number,
  ruleset: Readonly<SurvivalRuleset> = SURVIVAL_RULESET_V1,
): SurvivalPatternDirective {
  const seed = normalizeSurvivalSeed(seedValue);
  const safeIndex = Math.max(0, Math.trunc(patternIndex));
  const safeScheduledAt = finiteNonNegative(scheduledAt);
  const difficulty = survivalDifficultyAt(safeScheduledAt, ruleset);
  const kind = patternKind(seed, safeIndex, difficulty);
  const count = Math.min(patternSize(kind), difficulty.maxPatternSize, ruleset.maxPatternSize);
  const spawns: SurvivalSpawnDirective[] = [];

  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const spawnId = safeIndex * SPAWN_ID_STRIDE + ordinal;
    const target = targetFor(seed, safeIndex, kind, ordinal);
    const speedVariance = lerp(0.92, 1.08, unit(seed, spawnId, 0x709d_b2c5));
    const reactionVariance = lerp(0.97, 1.08, unit(seed, spawnId, 0xf37a_64e1));
    spawns.push({
      spawnId,
      patternIndex: safeIndex,
      patternKind: kind,
      ordinal,
      patternSize: count,
      scheduledAt: safeScheduledAt,
      entryAzimuthRadians:
        signed(seed, spawnId, 0x01f6_cad3) * ruleset.maximumEntryAzimuthRadians,
      entryElevationRadians:
        signed(seed, spawnId, 0x9bd2_1a77) * ruleset.maximumEntryElevationRadians,
      targetOffsetX: clamp(target[0], -0.92, 0.92),
      targetOffsetY: clamp(target[1], -0.82, 0.82),
      speed: difficulty.meteorSpeed * speedVariance,
      reactionSeconds: Math.max(
        ruleset.minimumReactionSeconds,
        difficulty.reactionSeconds * reactionVariance,
      ),
      radius: lerp(
        ruleset.minimumRadius,
        ruleset.maximumRadius,
        unit(seed, spawnId, 0x5ee7_49ad) ** 1.7,
      ),
      geometryVariant: hashWord(seed, spawnId, 0x44c8_2f15) % ruleset.geometryVariants,
      spinAxis: normalizedAxis(seed, spawnId),
      spinRate: lerp(-1.15, 1.15, unit(seed, spawnId, 0xba31_8de9)),
    });
  }

  return { patternIndex: safeIndex, kind, scheduledAt: safeScheduledAt, difficulty, spawns };
}

function patternInterval(
  seed: number,
  patternIndex: number,
  scheduledAt: number,
  ruleset: Readonly<SurvivalRuleset>,
): number {
  const base = survivalDifficultyAt(scheduledAt, ruleset).patternIntervalSeconds;
  return Math.max(
    ruleset.fastPatternIntervalSeconds,
    base * lerp(0.9, 1.1, unit(seed, patternIndex, 0xe269_3b47)),
  );
}

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

const copyStats = (stats: SurvivalRunStats): SurvivalRunStats => ({ ...stats });

function boundedCount(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

export class SurvivalRun {
  readonly ruleset: Readonly<SurvivalRuleset>;
  private runSeed: number;
  private runElapsed = 0;
  private nextPatternIndex = 0;
  private nextPatternTime: number;
  private runStats = emptyStats();

  constructor(options: SurvivalRunOptions = {}) {
    this.ruleset = options.ruleset ?? SURVIVAL_RULESET_V1;
    this.runSeed = normalizeSurvivalSeed(options.seed);
    this.nextPatternTime = this.ruleset.graceSeconds;
  }

  get seed(): number {
    return this.runSeed;
  }

  get elapsedSeconds(): number {
    return this.runElapsed;
  }

  get nextPatternAt(): number {
    return this.nextPatternTime;
  }

  reset(seed: number = this.runSeed): void {
    this.runSeed = normalizeSurvivalSeed(seed);
    this.runElapsed = 0;
    this.nextPatternIndex = 0;
    this.nextPatternTime = this.ruleset.graceSeconds;
    this.runStats = emptyStats();
  }

  /**
   * Advance to an absolute run time. Pool pressure drops complete patterns; partial walls or
   * bursts are never emitted. A large tab-resume jump is capped and resynchronised instead of
   * creating an unbounded catch-up queue.
   */
  advanceTo(elapsedSeconds: number, availableSlots = this.ruleset.maxActiveMeteors): SurvivalAdvance {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < this.runElapsed) {
      throw new RangeError('survival elapsed time must be finite and monotonic; call reset() for a new run');
    }

    this.runElapsed = Math.max(0, elapsedSeconds);
    let capacity = boundedCount(availableSlots, this.ruleset.maxActiveMeteors);
    let processedPatterns = 0;
    let emittedSpawns = 0;
    let droppedPatterns = 0;
    let droppedSpawns = 0;
    const patterns: SurvivalPatternDirective[] = [];

    while (
      this.nextPatternTime <= this.runElapsed + DUE_EPSILON_SECONDS
      && processedPatterns < this.ruleset.maxPatternsPerAdvance
    ) {
      const pattern = deriveSurvivalPattern(
        this.runSeed,
        this.nextPatternIndex,
        this.nextPatternTime,
        this.ruleset,
      );
      const spawnCount = pattern.spawns.length;
      const withinSpawnBudget = emittedSpawns + spawnCount <= this.ruleset.maxSpawnsPerAdvance;

      this.runStats.patternsScheduled += 1;
      this.runStats.meteorsScheduled += spawnCount;
      if (spawnCount <= capacity && withinSpawnBudget) {
        patterns.push(pattern);
        capacity -= spawnCount;
        emittedSpawns += spawnCount;
        this.runStats.patternsEmitted += 1;
        this.runStats.meteorsSpawned += spawnCount;
      } else {
        droppedPatterns += 1;
        droppedSpawns += spawnCount;
        this.runStats.patternsDropped += 1;
      }

      this.nextPatternTime += patternInterval(
        this.runSeed,
        this.nextPatternIndex,
        this.nextPatternTime,
        this.ruleset,
      );
      this.nextPatternIndex += 1;
      processedPatterns += 1;
    }

    if (this.nextPatternTime <= this.runElapsed + DUE_EPSILON_SECONDS) {
      // One bounded accounting event represents all stale work. The next live pattern starts in
      // the future, so a resumed tab cannot leak backlog over many subsequent frames.
      const stale = deriveSurvivalPattern(
        this.runSeed,
        this.nextPatternIndex,
        this.nextPatternTime,
        this.ruleset,
      );
      droppedPatterns += 1;
      droppedSpawns += stale.spawns.length;
      this.runStats.patternsScheduled += 1;
      this.runStats.meteorsScheduled += stale.spawns.length;
      this.runStats.patternsDropped += 1;
      this.nextPatternIndex += 1;
      this.nextPatternTime = this.runElapsed + patternInterval(
        this.runSeed,
        this.nextPatternIndex,
        this.runElapsed,
        this.ruleset,
      );
    }

    return {
      elapsedSeconds: this.runElapsed,
      difficulty: survivalDifficultyAt(this.runElapsed, this.ruleset),
      patterns,
      droppedPatterns,
      droppedSpawns,
      nextPatternAt: this.nextPatternTime,
      stats: copyStats(this.runStats),
    };
  }

  observeActiveCount(activeCount: number): void {
    this.runStats.peakActive = Math.max(
      this.runStats.peakActive,
      boundedCount(activeCount, this.ruleset.maxActiveMeteors),
    );
  }

  recordMeteorDodged(count = 1): void {
    this.runStats.meteorsDodged += boundedCount(count);
  }

  recordNearMiss(count = 1): void {
    this.runStats.nearMisses += boundedCount(count);
  }

  recordCollision(count = 1): void {
    this.runStats.collisions += boundedCount(count);
  }

  snapshotStats(out?: SurvivalRunStats): SurvivalRunStats {
    const snapshot = out ?? emptyStats();
    snapshot.patternsScheduled = this.runStats.patternsScheduled;
    snapshot.patternsEmitted = this.runStats.patternsEmitted;
    snapshot.patternsDropped = this.runStats.patternsDropped;
    snapshot.meteorsScheduled = this.runStats.meteorsScheduled;
    snapshot.meteorsSpawned = this.runStats.meteorsSpawned;
    snapshot.meteorsDodged = this.runStats.meteorsDodged;
    snapshot.nearMisses = this.runStats.nearMisses;
    snapshot.collisions = this.runStats.collisions;
    snapshot.peakActive = this.runStats.peakActive;
    return snapshot;
  }

  finish(elapsedSeconds = this.runElapsed): SurvivalResult {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new RangeError('survival score must be a finite non-negative duration');
    }
    const scoreSeconds = Math.round(elapsedSeconds * 1000) / 1000;
    return {
      rulesetId: this.ruleset.id,
      seed: this.runSeed,
      scoreSeconds,
      stats: copyStats(this.runStats),
    };
  }
}
