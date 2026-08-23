/**
 * Single source of truth for art direction. Every subsystem — world shading, HUD, screens,
 * even the audio engine's tonal centre — references these so the build reads as one piece.
 *
 * Direction: THE CAIRN DRIFT.
 * A debris shelf orbiting a dying amber star, strung with monolithic navigation markers left
 * by a civilisation that is no longer around to use them. Cold indigo shadow, hot amber key,
 * cyan machine-light. Everything is enormous and nothing is friendly.
 */

export const FICTION = {
  gameTitle: 'LAST VECTOR',
  sectorName: 'THE CAIRN DRIFT',
  destinationName: 'VESPER TERMINUS',
  starName: 'ACHRA',
  planetName: 'VESPER',
  shipName: 'KESTREL-C7',
  /** Shown under the title. Kept short — the visuals carry the mood. */
  tagline: 'Thread the cairns. Make the terminus before the drift closes.',
} as const;

/** Linear-space colours as hex ints, for three.js. */
export const PALETTE = {
  voidNear: 0x05070f,
  voidFar: 0x0a1226,

  starCore: 0xfff4d6,
  starGlow: 0xffb257,
  starRim: 0xff7a3c,

  nebulaTeal: 0x1de3d0,
  nebulaIndigo: 0x4b3ff0,
  nebulaMagenta: 0xff4d8d,
  nebulaDust: 0x2a1f3d,

  planetLit: 0xc9915f,
  planetShadow: 0x1a1930,
  planetAtmo: 0x7ea9ff,

  gateIdle: 0x2b4a63,
  gateArmed: 0x64e8ff,
  gateCleared: 0xffd47a,
  gateFail: 0xff5a6e,

  hullDark: 0x1b2028,
  hullPanel: 0xd9d2c4,
  hullTrim: 0x3a4450,
  engineCore: 0x9ff4ff,
  engineFlame: 0x3aa8ff,
  engineBoost: 0xd9f2ff,

  rockLit: 0x8a7d6e,
  rockShadow: 0x14161f,
  rockMineral: 0x3fd6c0,
} as const;

/** CSS colours for the HUD/screens layer. Same direction, sRGB. */
export const UI = {
  primary: '#7fe8ff',
  primaryDim: 'rgba(127, 232, 255, 0.42)',
  accent: '#ffd47a',
  good: '#7dffb0',
  warn: '#ffd166',
  bad: '#ff5a6e',
  ink: '#e7f3ff',
  inkDim: 'rgba(185, 204, 221, 0.66)',
  inkFaint: 'rgba(185, 204, 221, 0.28)',
  panel: 'rgba(6, 12, 22, 0.62)',
  panelSolid: '#060c16',
  hairline: 'rgba(127, 232, 255, 0.22)',
  scanline: 'rgba(127, 232, 255, 0.05)',
} as const;

/** Self-hosted Hangul faces keep localized UI offline; Latin and numerals retain these stacks. */
export const FONT = {
  hangul: "'NanumSquare Neo Hangul'",
  mono: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, 'Roboto Mono', monospace",
  display:
    "'Helvetica Neue', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
} as const;

/** World scale, in metres. Chosen so the sense of distance is legible from the cockpit. */
export const SCALE: Record<
  | 'shipLength'
  | 'gateRadius'
  | 'gateSpacing'
  | 'asteroidFieldRadius'
  | 'planetRadius'
  | 'planetDistance'
  | 'starDistance'
  | 'starRadius',
  number
> = {
  shipLength: 18,
  gateRadius: 105,
  /** Typical straight-line distance between consecutive gates. */
  gateSpacing: 6200,
  asteroidFieldRadius: 9000,
  planetRadius: 640_000,
  planetDistance: 2_900_000,
  starDistance: 42_000_000,
  starRadius: 620_000,
};

export const FLIGHT: Record<
  | 'cruiseSpeed'
  | 'boostSpeed'
  | 'maxSpeed'
  | 'spoolTime'
  | 'boostCapacity'
  | 'boostEngageFraction'
  | 'boostRearmFraction'
  | 'boostDrain'
  | 'boostRegen'
  | 'boostRegenDelay',
  number
> = {
  /** Metres per second. */
  // A uniform 10% lift keeps the authority and autopilot ratios intact while making both the
  // ordinary line and an overdrive burst visibly cover more ground. Measured 12-15% passes
  // crossed the existing controller's safe cornering envelope; 10% retains a clean reference run.
  cruiseSpeed: 462,
  boostSpeed: 1078,
  maxSpeed: 1188,
  /** Seconds to reach cruise from rest at full throttle. */
  spoolTime: 2.4,
  boostCapacity: 100,
  /** Fraction of capacity kept as the boost latch floor. */
  boostEngageFraction: 0.08,
  /** Fraction required before a depleted, held boost input may re-arm. */
  boostRearmFraction: 0.45,
  // About 3.2 s from a full tank to the latch floor, followed by a noticeably shorter recovery.
  boostDrain: 29,
  boostRegen: 22,
  boostRegenDelay: 0.65,
};

/**
 * Flight thresholds authored against the current 462 m/s cruise.
 *
 * The distance values are fixed amounts of cruise time; the velocity values are fixed fractions
 * of cruise speed. Scaling every threshold from one exact reference keeps today's tuning bit-for-
 * bit unchanged while making a future cruise-speed edit preserve the same warning time, cue timing,
 * slip response and impact severity.
 */
const REFERENCE_CRUISE_SPEED = 462;
const scaleWithCruiseSpeed = (valueAtReference: number): number =>
  valueAtReference * (FLIGHT.cruiseSpeed / REFERENCE_CRUISE_SPEED);

export const FLIGHT_THRESHOLDS = {
  /** Collider broad-phase reach and the proximity-warning band, in metres. */
  proximityRange: scaleWithCruiseSpeed(260),
  /** Distance from a gate at which the approach tick begins, in metres. */
  gateTickRange: scaleWithCruiseSpeed(900),
  /** Distance divisor that maps gate approach to the tick repeat interval. */
  gateTickIntervalDivisor: scaleWithCruiseSpeed(2600),
  /** Distance over which the gate reticle tightens into its near-response shape. */
  gateReticleRange: scaleWithCruiseSpeed(2600),
  /** Lateral speed that reads as full slip, in metres per second. */
  fullSlipSpeed: scaleWithCruiseSpeed(220),
  /** Closing speed that produces a maximum-severity impact, in metres per second. */
  maxImpactClosingSpeed: scaleWithCruiseSpeed(520),
} as const;

/**
 * Maximum pixels the renderer will allocate for the scene, before the dynamic scaler.
 *
 * A device-ratio clamp is the wrong shape: it budgets a RATIO when the cost is a COUNT. At
 * `min(dpr, 2)` a 1920x1080 window on a Retina or 4K panel allocated 8.29 Mpx — four times what
 * every measurement in this project's first four review rounds was taken at, and about 3x the
 * GPU cost against 2.19x of headroom.
 *
 * 2.5 Mpx is a little above 1920x1080 native, so an ordinary 1080p window is unaffected and a
 * HiDPI one lands near the same fill. The browser upscales from the CSS size, exactly as it
 * already does at every dynamic render scale.
 */
export const FILL_BUDGET_PIXELS = 2_500_000;
