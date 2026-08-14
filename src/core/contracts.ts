/**
 * Shared contracts between independently-developed subsystems.
 * Anything crossing a module boundary (game -> hud, game -> audio) lives here.
 * Keep it dependency-free: no three.js imports, no DOM handles.
 *
 * NOTE FOR ANYONE ADDING A FIELD: `Telemetry` and `HudHost` have consumers outside this
 * repository. The interface layer is developed against a standalone probe page that mounts
 * `Overlay` over synthetic telemetry, because several HUD states — the off-screen director, the
 * proximity ring, the impact pulse — are hard to reach in a real run. Adding a required field or
 * method silently breaks that harness: it has happened twice, once for `HudHost.pause()` and
 * once for `Telemetry.velocityAnchor`. It is not a reason to avoid changing the contract; it is
 * a reason to say so when you do.
 */

export type Phase = 'boot' | 'title' | 'briefing' | 'countdown' | 'flying' | 'finished';

export interface ScreenAnchor {
  /** Normalised device coords, -1..1, x right / y up. Valid only when `onScreen`. */
  x: number;
  y: number;
  /** True when the target projects in front of the camera and inside the frustum. */
  onScreen: boolean;
  /** Radians, 0 = screen right, CCW. Used to place the off-screen chase arrow. */
  angle: number;
  /** Metres from camera to target. */
  distance: number;
}

export interface GateTelemetry {
  index: number;
  total: number;
  name: string;
  /** Metres from ship to the next gate centre. */
  distance: number;
  anchor: ScreenAnchor;
  /** 0..1 alignment of ship heading with the gate normal; drives the approach vignette. */
  alignment: number;
}

export interface Telemetry {
  phase: Phase;
  /** Metres / second. */
  speed: number;
  maxSpeed: number;
  /** Commanded throttle, 0..1. */
  throttle: number;
  boosting: boolean;
  /** Remaining boost energy, 0..1. */
  energy: number;
  /** Structural integrity, 0..1. */
  hull: number;
  /** Ship-frame roll and pitch in radians, for the artificial horizon. */
  roll: number;
  pitch: number;
  /** Metres per second squared felt by the pilot. The HUD renders this in G, i.e. / 9.80665. */
  gLoad: number;
  /**
   * Where the ship is actually going, projected to screen space — the flight-path marker.
   *
   * This is the single element that most sells "I am flying a real craft", because the gap
   * between it and the centre of the screen IS the drift the flight model is simulating.
   * Deriving it from roll and g-load only ever produces something plausible; this is the
   * real vector. Meaningless below a few metres per second, where `onScreen` is false.
   */
  velocityAnchor: ScreenAnchor;
  gate: GateTelemetry;
  /** Metres remaining along the whole course. */
  courseRemaining: number;
  courseTotal: number;
  /** Seconds since the run started. */
  elapsed: number;
  /** Per-gate split times, seconds. */
  splits: number[];
  bestTime: number | null;
  sectorName: string;
  destinationName: string;
  /** Transient centre-screen callout. */
  callout: Callout | null;
  /** Scrolling diegetic log, newest last. */
  log: LogLine[];
  /** 0..1 proximity warning, drives the collision alert. */
  proximity: number;
  /**
   * 0..1, spikes on a hull strike and decays in about a fifth of a second. An explicit signal
   * because the alternative — watching `hull` decrease frame to frame — misses a glancing
   * contact that costs no hull, and misfires on any frame the value is re-clamped.
   */
  impactFlash: number;
  fps: number;
}

export interface Callout {
  id: number;
  title: string;
  sub?: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  /** Seconds remaining. */
  ttl: number;
  ttlMax: number;
}

export interface LogLine {
  id: number;
  text: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  /** Seconds since spawn. */
  age: number;
}

export interface RunResult {
  totalTime: number;
  splits: number[];
  bestTime: number | null;
  isNewBest: boolean;
  gatesCleared: number;
  gatesTotal: number;
  topSpeed: number;
  cleanRun: boolean;
  rank: string;
  destinationName: string;
}

/** Everything the HUD layer is allowed to ask the game to do. */
export interface HudHost {
  /** Opens the briefing. The run itself begins from `engage`. */
  start(): void;
  /** Leaves the briefing and starts the countdown. */
  engage(): void;
  restart(): void;
  /**
   * The interface layer is the single owner of "a menu is showing", because only it knows
   * about sub-views. It therefore drives the simulation's pause state rather than the two
   * sides each keeping their own flag — which is exactly how they drifted apart.
   */
  pause(): void;
  resume(): void;
  quitToTitle(): void;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  getSettings(): Settings;
}

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  quality: QualityLevel;
  renderScale: number;
  masterVolume: number;
  musicVolume: number;
  mouseSensitivity: number;
  invertY: boolean;
  fov: number;
  motionBlur: boolean;
  filmGrain: boolean;
  chromaticAberration: boolean;
  cameraShake: number;
  showFps: boolean;
  assistLevel: 'arcade' | 'standard' | 'raw';
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  renderScale: 1,
  masterVolume: 0.8,
  musicVolume: 0.65,
  mouseSensitivity: 1,
  invertY: false,
  fov: 76,
  motionBlur: true,
  filmGrain: true,
  chromaticAberration: true,
  cameraShake: 1,
  showFps: false,
  assistLevel: 'standard',
};

export type SfxEvent =
  | 'gatePass'
  | 'gateNear'
  | 'gateMiss'
  | 'boostStart'
  | 'boostEnd'
  | 'boostEmpty'
  | 'countdownTick'
  | 'countdownGo'
  | 'finish'
  | 'newBest'
  | 'impact'
  | 'scrape'
  | 'warnProximity'
  | 'uiHover'
  | 'uiClick'
  | 'uiBack'
  | 'radio';

export interface EngineAudioState {
  /** 0..1 commanded thrust. */
  throttle: number;
  /** 0..1 normalised speed. */
  speed01: number;
  boosting: boolean;
  /** 0..1 lateral slip, drives the manoeuvring-thruster layer. */
  slip: number;
}

/** Procedural audio backend. No sample files: everything is synthesised. */
export interface AudioBus {
  /** Must be called from inside a user gesture. Idempotent. */
  unlock(): Promise<void>;
  readonly ready: boolean;
  update(dt: number, engine: EngineAudioState): void;
  play(event: SfxEvent, intensity?: number): void;
  /** 0..1 musical intensity; drives layer gates in the generative score. */
  setIntensity(value: number): void;
  setMasterVolume(value: number): void;
  setMusicVolume(value: number): void;
  /** Called when the tab loses focus. */
  suspend(): void;
  resume(): void;
  dispose(): void;
}
