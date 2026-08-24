/**
 * Stable run-mode identities and URL routing.
 *
 * Keep this module free of rendering and course imports. Survival is deliberately not a
 * `CourseId`: a malformed or stale mode link must fall back to the shipped time trial without
 * accidentally selecting dormant campaign content.
 */

export const DEFAULT_RUN_MODE_ID = 'time-trial' as const;
export const SURVIVAL_RUN_MODE_ID = 'meteor-survival' as const;

export type RunModeId = typeof DEFAULT_RUN_MODE_ID | typeof SURVIVAL_RUN_MODE_ID;

export type RunModeResolutionSource = 'default' | 'url' | 'invalid-url';

export interface RunModeResolution {
  modeId: RunModeId;
  source: RunModeResolutionSource;
  diagnostic: string | null;
}
export function isRunModeId(value: unknown): value is RunModeId {
  return value === DEFAULT_RUN_MODE_ID || value === SURVIVAL_RUN_MODE_ID;
}

/** Resolve an untrusted `mode` query value. Unknown values always fail closed to time trial. */
export function resolveRunMode(rawModeParam: string | null): RunModeResolution {
  if (rawModeParam === null || rawModeParam === '' || rawModeParam === DEFAULT_RUN_MODE_ID) {
    return { modeId: DEFAULT_RUN_MODE_ID, source: 'default', diagnostic: null };
  }
  if (rawModeParam === SURVIVAL_RUN_MODE_ID) {
    return { modeId: SURVIVAL_RUN_MODE_ID, source: 'url', diagnostic: null };
  }
  return {
    modeId: DEFAULT_RUN_MODE_ID,
    source: 'invalid-url',
    diagnostic: `unknown run mode parameter: ${rawModeParam}`,
  };
}

export interface BuildRunModeUrlOptions {
  /** Keep an existing deterministic/debug seed. Normal player navigation clears it by default. */
  preserveSeed?: boolean;
  /** Install a validated uint32 seed. `null` explicitly removes the seed. */
  seed?: number | null;
  /**
   * Survival does not consume a course. Its URLs therefore remove `course` unless a harness
   * explicitly needs to preserve all ambient query state.
   */
  preserveCourse?: boolean;
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 0xffff_ffff;
}

/** Returns navigation data only. The caller retains ownership of reload and error handling. */
export function buildRunModeUrl(
  current: string | URL,
  requestedMode: RunModeId | string,
  options: BuildRunModeUrlOptions = {},
): string {
  const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
  const url = current instanceof URL ? new URL(current.href) : new URL(current, base);
  const modeId = isRunModeId(requestedMode) ? requestedMode : DEFAULT_RUN_MODE_ID;

  // The default has a canonical URL with no mode parameter. This also ensures an untrusted mode
  // passed by plain JavaScript cannot be minted into a shareable link.
  if (modeId === DEFAULT_RUN_MODE_ID) url.searchParams.delete('mode');
  else url.searchParams.set('mode', modeId);

  if (modeId === SURVIVAL_RUN_MODE_ID && options.preserveCourse !== true) {
    url.searchParams.delete('course');
  }

  if (options.seed !== undefined) {
    if (isUint32(options.seed)) url.searchParams.set('seed', String(options.seed));
    else url.searchParams.delete('seed');
  } else if (options.preserveSeed !== true) {
    url.searchParams.delete('seed');
  }

  return url.href;
}
