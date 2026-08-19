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
  | 'boostDrain'
  | 'boostRegen'
  | 'boostRegenDelay',
  number
> = {
  /** Metres per second. */
  cruiseSpeed: 500,
  boostSpeed: 1180,
  maxSpeed: 1300,
  /** Seconds to reach cruise from rest at full throttle. */
  spoolTime: 2.4,
  /**
   * The overdrive reserve, in arbitrary units — `boostDrain` and `boostRegen` are per second,
   * so the only numbers that mean anything are the two ratios below.
   *
   * 180 / 30 = **6.0 s of drive from a full tank**, against 2.9 s before. The old reserve was
   * shorter than a single long leg: 'the long run' is 1.4x the nominal 6.2 km spacing and
   * exists specifically so the player boosts down it, and at 2.9 s the burst ended a third of
   * the way along. A burst now outlasts the straight that was authored for it, which is the
   * whole reason the reserve exists.
   *
   * 22/s refills the full 180 in 8.2 s, so the DUTY CYCLE improves even though the absolute
   * refill is longer: 6.0 s of drive per 8.2 s of wait, against 2.9 per 5.9. The re-arm level
   * in `Ship` is a FRACTION of capacity, so it tracks this automatically — 45% of 180 is 2.7 s
   * of usable drive, which keeps a re-engage a decision rather than a twitch.
   */
  boostCapacity: 180,
  boostDrain: 30,
  boostRegen: 22,
  boostRegenDelay: 0.75,
};

/**
 * Distances that are really DURATIONS, expressed as seconds of cruise travel.
 *
 * Every one of these was a bare metre value fitted against a 420 m/s cruise, and every one is
 * a threshold the player experiences as time-to-contact rather than as distance: how long the
 * proximity warning gives you, how long the gate tick escalates for, how hard a given closing
 * geometry hits. Raising cruise to 500 and leaving them in metres would have quietly shortened
 * all three by 16% and made every collision 19% more severe for the same flown line — a
 * difficulty change nobody asked for, wearing a speed change's clothes.
 *
 * Deriving them means the coupling is enforced rather than remembered. The seconds are the
 * design; the metres are output.
 */
export const FLIGHT_RANGE = {
  /** 0.62 s — the proximity warning band, and the collider's broad-phase reach. */
  proximity: FLIGHT.cruiseSpeed * 0.62,
  /** 2.14 s — where the gate's approach tick starts, and the range its urgency is scaled over. */
  gateTick: FLIGHT.cruiseSpeed * 2.14,
  /** 6.19 s — divisor setting the tick's repeat interval at the far edge of that band. */
  gateTickInterval: FLIGHT.cruiseSpeed * 6.19,
  /** 0.52 s of lateral travel is full slip, i.e. the vector is completely off the nose. */
  fullSlip: FLIGHT.cruiseSpeed * 0.524,
  /** 1.24 s — closing speed that scores a maximum-severity hull strike. */
  fatalClosing: FLIGHT.cruiseSpeed * 1.24,
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
