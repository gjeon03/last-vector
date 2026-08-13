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

  rockLit: 0x6b6156,
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

/** No web fonts: the build must stay fully offline and asset-free. */
export const FONT = {
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
  gateRadius: 140,
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
  | 'boostDrain'
  | 'boostRegen'
  | 'boostRegenDelay',
  number
> = {
  /** Metres per second. */
  cruiseSpeed: 420,
  boostSpeed: 980,
  maxSpeed: 1080,
  /** Seconds to reach cruise from rest at full throttle. */
  spoolTime: 2.4,
  boostCapacity: 100,
  boostDrain: 34,
  boostRegen: 17,
  boostRegenDelay: 0.9,
};
