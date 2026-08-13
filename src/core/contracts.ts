/**
 * Shared contracts between independently-developed subsystems.
 * Anything crossing a module boundary (game -> hud, game -> audio) lives here.
 * Keep it dependency-free: no three.js imports, no DOM handles.
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
  /** Metres / second squared felt by the pilot, for the g-load readout. */
  gLoad: number;
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
  start(): void;
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
