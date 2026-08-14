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
  s.renderScale = clamp(s.renderScale, 0.5, 1.5);
  s.masterVolume = clamp01(s.masterVolume);
  s.musicVolume = clamp01(s.musicVolume);
  s.mouseSensitivity = clamp(s.mouseSensitivity, 0.2, 3);
  s.fov = clamp(s.fov, 60, 100);
  s.cameraShake = clamp01(s.cameraShake);
  if (!(s.quality in PROFILES)) s.quality = 'high';
  if (!['arcade', 'standard', 'raw'].includes(s.assistLevel)) s.assistLevel = 'standard';
  return s;
}

export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor() {
    this.current = sanitise({ quality: detectQuality(), ...readJson<Partial<Settings>>(STORAGE_KEY) });
    this.current.renderScale = qualityProfile(this.current.quality).renderScale;
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
    if (key === 'quality') next.renderScale = qualityProfile(next.quality).renderScale;
    this.current = sanitise(next);
    writeJson(STORAGE_KEY, this.current);
    for (const fn of this.listeners) fn(this.current);
  }

  patch(patch: Partial<Settings>): void {
    const next = sanitise({ ...this.current, ...patch });
    if (patch.quality && patch.renderScale === undefined) {
      next.renderScale = qualityProfile(next.quality).renderScale;
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
