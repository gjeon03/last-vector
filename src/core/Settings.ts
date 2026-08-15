import { DEFAULT_SETTINGS, type QualityLevel, type Settings } from './contracts.ts';
import { clamp, clamp01 } from './mathx.ts';

const STORAGE_KEY = 'last-vector.settings.v1';
const BEST_KEY = 'last-vector.best.v1';

/** Per-quality knobs that the renderer reads. Kept here so one dial moves everything. */
export interface QualityProfile {
  renderScale: number;
  bloom: boolean;
  bloomStrength: number;
  godrays: boolean;
  godraySamples: number;
  motionBlurSamples: number;
  starCount: number;
  dustCount: number;
  asteroidCount: number;
  debrisCount: number;
  nebulaSteps: number;
  shadowMap: boolean;
  anisotropy: number;
  ssao: 'low' | 'medium' | 'high' | 'ultra';
}

const PROFILES: Record<QualityLevel, QualityProfile> = {
  low: {
    renderScale: 0.72,
    bloom: true,
    bloomStrength: 0.5,
    godrays: false,
    godraySamples: 0,
    motionBlurSamples: 0,
    starCount: 5000,
    dustCount: 900,
    asteroidCount: 420,
    debrisCount: 60,
    nebulaSteps: 0,
    shadowMap: false,
    anisotropy: 2,
    ssao: 'low',
  },
  medium: {
    renderScale: 0.86,
    bloom: true,
    bloomStrength: 0.62,
    godrays: true,
    godraySamples: 18,
    motionBlurSamples: 4,
    starCount: 9000,
    dustCount: 1600,
    asteroidCount: 620,
    debrisCount: 130,
    nebulaSteps: 12,
    shadowMap: false,
    anisotropy: 4,
    ssao: 'medium',
  },
  high: {
    renderScale: 1,
    bloom: true,
    bloomStrength: 0.72,
    godrays: true,
    godraySamples: 26,
    motionBlurSamples: 6,
    starCount: 16000,
    dustCount: 2600,
    asteroidCount: 950,
    debrisCount: 240,
    nebulaSteps: 20,
    shadowMap: true,
    anisotropy: 8,
    ssao: 'high',
  },
  ultra: {
    renderScale: 1,
    bloom: true,
    bloomStrength: 0.78,
    godrays: true,
    godraySamples: 40,
    motionBlurSamples: 8,
    starCount: 24000,
    dustCount: 4200,
    asteroidCount: 1500,
    debrisCount: 380,
    nebulaSteps: 28,
    shadowMap: true,
    anisotropy: 16,
    ssao: 'ultra',
  },
};

export function qualityProfile(level: QualityLevel): QualityProfile {
  return PROFILES[level];
}

/**
 * Render scale to use when the player changes quality.
 *
 * Taking the new profile unconditionally threw away the one setting round 6 made durable. A player
 * who lowers render scale — as this row's own hint tells them to, "Drop it before you drop
 * quality" — and then lowers quality had 0.60 raised to 0.72: +44% pixels, and their explicit
 * choice destroyed, permanently, because the result is written straight back to storage. Never
 * taking it would pin a player who has never touched the slider to a scale their new quality level
 * does not want, which is the reading that cleared this as correct-as-shipped.
 *
 * Both readings are right about different players, so the condition has to distinguish them, and
 * it reads a STORED flag rather than inferring intent from the value.
 *
 * CORRECTION, because the first attempt did infer it. It asked whether `renderScale` still equalled
 * the current quality profile's, which looked like it needed no extra state. That test was sound
 * only while 0.72 and 0.86 were unreachable slider stops — no gesture could put 0.72 into storage
 * except never having touched the control, so equality really did imply untouched. Putting those
 * values on the grid, which the slider needed for its own reasons, destroys precisely that
 * property: a player who deliberately selects 0.72 at low quality is then read as never having
 * chosen, and every later quality change overwrites them. That is a silent, permanent, persisted
 * false positive — the exact failure this function exists to prevent, reintroduced by the fix for
 * the adjacent one.
 */
function renderScaleForQuality(current: Settings, nextQuality: QualityLevel): number {
  return current.renderScaleTouched ? current.renderScale : qualityProfile(nextQuality).renderScale;
}

/** Guesses a sensible starting quality so the first frame a player sees is a good one. */
export function detectQuality(): QualityLevel {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile) return 'low';
  if (cores >= 10 && mem >= 8) return 'ultra';
  if (cores >= 6) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

function sanitise(raw: Partial<Settings>): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...raw };
  // 0.58 is the adaptive controller's own floor. A stored 0.5 is a value the game can never
  // actually run at, and the perf gate's failure threshold sat above it too — so the only lever
  // left on a dense display landed below the project's declared failure line.
  s.renderScale = clamp(s.renderScale, 0.58, 1);
  s.masterVolume = clamp01(s.masterVolume);
  s.musicVolume = clamp01(s.musicVolume);
  s.mouseSensitivity = clamp(s.mouseSensitivity, 0.2, 3);
  s.fov = clamp(s.fov, 60, 100);
  s.cameraShake = clamp01(s.cameraShake);
  if (!(s.quality in PROFILES)) s.quality = 'high';
  if (!['arcade', 'standard', 'raw'].includes(s.assistLevel)) s.assistLevel = 'standard';
  /* A hand-edited or truncated blob must not leave this as a string or a number, since it decides
     whether a later quality change overwrites the player's render scale. */
  s.renderScaleTouched = s.renderScaleTouched === true;
  return s;
}

export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor() {
    const stored = readJson<Partial<Settings>>(STORAGE_KEY);
    this.current = sanitise({ quality: detectQuality(), ...stored });
    // Only derive render scale from the quality profile when the player has NEVER set it.
    //
    // This line used to run unconditionally, so a stored render scale was loaded, sanitised, and
    // then overwritten on every boot. Reproduced in rendered pixels: three cold boots with
    // pre-seeded storage produced a byte-identical 1690x950 renderer whether the player had saved
    // 0.58 or never touched the control — asked for ~700 kpx, got 2.3x that.
    //
    // Two consequences beyond the obvious one. `set`/`patch` serialise the whole in-memory object,
    // so the next settings change of ANY kind writes the overwritten value back and destroys the
    // saved one permanently — one unrelated FOV edit is enough. And because this value is the
    // adaptive controller's CEILING, every launch started at maximum and had to re-descend, which
    // is about four seconds of over-budget frames per session on a marginal machine. The row's own
    // hint reads "Internal resolution. Drop it before you drop quality."
    //
    // Deleting the line outright is the wrong fix and was proposed: a first run on an
    // auto-detected low machine yields {quality: low, renderScale: 0.72}, while
    // DEFAULT_SETTINGS.renderScale is 1, so a bare delete regresses exactly the machines the
    // detection exists to protect.
    if (stored?.renderScale === undefined) {
      this.current.renderScale = qualityProfile(this.current.quality).renderScale;
    } else if (stored.renderScaleTouched === undefined) {
      /* Migration, and the ONLY place the old value-equality inference is still used. A blob
         written before `renderScaleTouched` existed carries no record of intent, so the best
         available signal is whether the stored scale differs from its quality's profile. That
         inference is unsound in general — a deliberate 0.72 at low quality reads as untouched —
         but it is strictly better than defaulting every existing player to one answer, and it
         runs exactly once, after which the flag is authoritative. */
      this.current.renderScaleTouched =
        stored.renderScale !== qualityProfile(this.current.quality).renderScale;
    }
  }

  get value(): Settings {
    return this.current;
  }

  get profile(): QualityProfile {
    return qualityProfile(this.current.quality);
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    if (this.current[key] === value) return;
    const next = { ...this.current, [key]: value };
    /* Moving the slider is the only thing that marks it touched, and it is recorded here rather
       than derived later, so the record cannot be destroyed by a value that coincides with a
       profile default. */
    if (key === 'renderScale') next.renderScaleTouched = true;
    if (key === 'quality') next.renderScale = renderScaleForQuality(this.current, next.quality);
    this.current = sanitise(next);
    writeJson(STORAGE_KEY, this.current);
    for (const fn of this.listeners) fn(this.current);
  }

  patch(patch: Partial<Settings>): void {
    const next = sanitise({ ...this.current, ...patch });
    if (patch.renderScale !== undefined) next.renderScaleTouched = true;
    if (patch.quality && patch.renderScale === undefined) {
      next.renderScale = renderScaleForQuality(this.current, next.quality);
    }
    this.current = next;
    writeJson(STORAGE_KEY, this.current);
    for (const fn of this.listeners) fn(this.current);
  }

  subscribe(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

interface BestRun {
  time: number;
  /** Cumulative elapsed time at each gate on the best run. */
  splits: number[];
}

/** Older saves stored a bare number; read both shapes so a personal best survives the upgrade. */
function readBestRun(courseId: string): BestRun | null {
  const all = readJson<Record<string, number | BestRun>>(BEST_KEY) ?? {};
  const v = all[courseId];
  if (typeof v === 'number') return Number.isFinite(v) ? { time: v, splits: [] } : null;
  if (v && typeof v.time === 'number' && Number.isFinite(v.time)) {
    return { time: v.time, splits: Array.isArray(v.splits) ? v.splits : [] };
  }
  return null;
}

export function readBestTime(courseId: string): number | null {
  return readBestRun(courseId)?.time ?? null;
}

/**
 * The per-gate splits of the best run.
 *
 * The results screen wants a true delta against the player's own best, and a scalar best time
 * cannot support one — which is how a column headed with a comparison ended up being filled
 * with a comparison against the current run's own fastest leg.
 */
export function readBestSplits(courseId: string): number[] {
  return readBestRun(courseId)?.splits ?? [];
}

export function writeBestTime(courseId: string, seconds: number, splits: number[] = []): void {
  const all = readJson<Record<string, number | BestRun>>(BEST_KEY) ?? {};
  const prev = readBestRun(courseId);
  if (prev && prev.time <= seconds) return;
  all[courseId] = { time: seconds, splits: splits.slice() };
  writeJson(BEST_KEY, all);
}

/** Storage can throw in private mode or sandboxed iframes; settings are never load-bearing. */
function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* non-fatal */
  }
}
