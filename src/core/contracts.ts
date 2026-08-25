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

import type { CourseId } from './Courses.ts';
import type { MissionId } from './Missions.ts';

export type Phase =
  | 'boot'
  | 'title'
  | 'briefing'
  | 'countdown'
  | 'flying'
  | 'failed'
  | 'finished';

export type Locale = 'ko' | 'en';
export type LocaleFontStatus = 'not-required' | 'ready' | 'fallback' | 'failed';
export type GateAccuracy = 'dead-centre' | 'clean' | 'cleared';
export type GateMissCause = 'aperture' | 'shear';

export type GateNameMessage =
  | { type: 'gate-name.terminus-approach' }
  | { type: 'gate-name.nadir-approach' }
  | { type: 'gate-name.orison-approach' };

export type CalloutTitleMessage =
  | { type: 'callout-title.pointer-lock-unavailable' }
  | { type: 'callout-title.camera-view'; mode: CameraMode }
  | { type: 'callout-title.engage' }
  | { type: 'callout-title.hull-impact' }
  | { type: 'callout-title.boost-depleted' }
  | { type: 'callout-title.core-acquired'; core: number }
  | { type: 'callout-title.gate-cleared'; accuracy: GateAccuracy }
  | { type: 'callout-title.gate-missed'; blockedBy?: GateMissCause };

export type CalloutSubMessage =
  | { type: 'callout-sub.keyboard-flight-available' }
  | { type: 'callout-sub.camera-active'; mode: CameraMode }
  | { type: 'callout-sub.boost-recharging' }
  | { type: 'callout-sub.relay-charge'; charge: number; required: number }
  | { type: 'callout-sub.gate-progress'; remaining: number; courseId?: CourseId }
  | { type: 'callout-sub.gate-realign' }
  | { type: 'callout-sub.gate-shear-window' };

export type LogMessage =
  | { type: 'log.pointer-lock-refused'; reason: string }
  | { type: 'log.hull-contact'; percent: number }
  | { type: 'log.boost-depleted' }
  | { type: 'log.core-acquired'; core: number; seconds: number }
  | { type: 'log.gate-cleared'; gate: number; seconds: number; courseId?: CourseId }
  | {
      type: 'log.gate-missed';
      gate: number;
      courseId?: CourseId;
      blockedBy?: GateMissCause;
    };

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
  nameMessage?: GateNameMessage;
  /** Metres from ship to the next gate centre. */
  distance: number;
  anchor: ScreenAnchor;
  /** 0..1 alignment of ship heading with the gate normal; drives the approach vignette. */
  alignment: number;
}

export interface GuidanceTelemetry {
  label: string;
  labelMessage?: GateNameMessage;
  anchor: ScreenAnchor;
  distance: number;
  /** Normalized mission progress. */
  progress: number;
  current: number;
  total: number;
}

export interface GateRaceObjectiveTelemetry {
  kind: 'gate-race';
  gatesCleared: number;
  gatesTotal: number;
  misses: number;
  complete: boolean;
}

export interface CollectionSourceTelemetry {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly anchor: ScreenAnchor;
  distance: number;
  collected: boolean;
  primary: boolean;
}

export interface CollectionObjectiveTelemetry {
  kind: 'collection';
  collected: number;
  required: number;
  activeTotal: number;
  charge: number;
  chargeRequired: number;
  primarySourceId: string | null;
  primaryDistance: number | null;
  sources: readonly CollectionSourceTelemetry[];
}

export type ObjectiveTelemetry =
  | GateRaceObjectiveTelemetry
  | CollectionObjectiveTelemetry;

export interface Telemetry {
  phase: Phase;
  /** Metres / second. */
  speed: number;
  maxSpeed: number;
  /** Commanded throttle, 0..1. */
  throttle: number;
  boosting: boolean;
  /**
   * True while a depleted reserve is below the re-arm threshold. Optional so extending telemetry
   * does not break an out-of-repo consumer that constructs the prior interface shape.
   */
  boostLocked?: boolean;
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
  /** Objective-neutral director contract. */
  guidance: GuidanceTelemetry;
  /** Exhaustive objective-specific state. */
  objective: ObjectiveTelemetry;
  /** Metres remaining along the whole course. */
  courseRemaining: number;
  courseTotal: number;
  /** Seconds since the run started. */
  elapsed: number;
  /** Per-gate split times, seconds. */
  splits: number[];
  bestTime: number | null;
  /**
   * Per-gate splits of the player's best run, or empty when there is no best yet.
   *
   * Present so the results screen can show a real delta. Anything derived from the CURRENT
   * run's own legs is dominated by leg length, not by how the leg was flown.
   */
  bestSplits: number[];
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
  /**
   * Set once the browser has refused mouse capture, so a test can see a condition that used to
   * be invisible from outside. Optional, so adding it cannot break an out-of-repo consumer of
   * this interface — that has already happened twice this session.
   */
  pointerLockRefused?: boolean;
  /**
   * Total course length in metres, for anything that wants to state it.
   *
   * Optional so adding it cannot break an out-of-repo consumer. Exists because the briefing shipped
   * `CORRIDOR 48.6 KM` as a hard-coded literal against a real length of 54,362 m — wrong by 10-12%
   * in a stat block whose other four rows are all derived and all true.
   */
  courseLength?: number;
  fps: number;
}

export interface Callout {
  id: number;
  title: string;
  titleMessage?: CalloutTitleMessage;
  sub?: string;
  subMessage?: CalloutSubMessage;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  /** Seconds remaining. */
  ttl: number;
  ttlMax: number;
}

export interface LogLine {
  id: number;
  text: string;
  message?: LogMessage;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  /** Seconds since spawn. */
  age: number;
}

export interface MissionResultBase {
  missionId: MissionId;
  rulesetVersion: number;
  totalTime: number;
  hullRemaining: number;
  objectiveSummary: string;
  topSpeed: number;
  cleanRun: boolean;
  rank: string;
  destinationName: string;
  /** First mission made available by this finish, if any. */
  newlyUnlockedMissionId: MissionId | null;
}

export interface GateRaceMissionResult extends MissionResultBase {
  kind: 'gate-race';
  splits: number[];
  bestTime: number | null;
  /**
   * Per-gate splits of the player's best run, or empty when there is no best yet.
   *
   * Present so the results screen can show a real delta. Anything derived from the CURRENT
   * run's own legs is dominated by leg length, not by how the leg was flown.
   */
  bestSplits: number[];
  isNewBest: boolean;
  gatesCleared: number;
  gatesTotal: number;
  /** Largest gate offset in this run, normalized by each gate's authored radius. */
  maxGateOffset: number;
}

export interface CollectionMissionResult extends MissionResultBase {
  kind: 'collection';
  bestTime: number | null;
  isNewBest: boolean;
  collected: number;
  required: number;
  activeTotal: number;
  charge: number;
  chargeRequired: number;
}

export type MissionResult = GateRaceMissionResult | CollectionMissionResult;
/** Current shipped objective result; retained as a narrow compatibility name. */
export type RunResult = GateRaceMissionResult;

/** Shared gameplay reward; source metadata remains opaque to the common Game layer. */
export interface MissionRewardEvent {
  readonly kind: 'boost-recharge';
  readonly amount: number;
  readonly sourceId?: string;
  readonly sourceIndex?: number;
}

/** Everything the HUD layer is allowed to ask the game to do. */
/**
 * Interface sounds, as the interface layer sees them.
 *
 * Declared here rather than imported from the audio module because this file is deliberately
 * dependency-free — it is the contract, not a participant. The audio module's implementation
 * satisfies it structurally.
 */
export interface UiAudioBus {
  /** Safe to call repeatedly; the first user gesture on any screen is the one that counts. */
  unlock(): void;
  hover(): void;
  click(): void;
  back(): void;
}

export interface HudHost {
  /**
   * Interface sounds. Named verbs rather than an event passthrough, so the interface layer
   * cannot fire a gameplay cue. Every method is safe before the audio context exists.
   */
  readonly audio: UiAudioBus;
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
  /** Persists an authorized mission choice and reloads through the boot-owned world builder. */
  selectMission(missionId: MissionId): void;
  /** Returns to the title mission view without changing the active boot-built world. */
  showMissionSelect(): void;
  /** Reloads the active collection mission with a validated layout different from this run. */
  newLayout(): void;
  /** Requests a persisted locale change; the game accepts it only while the title is active. */
  requestLocale(locale: Locale): void;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  getSettings(): Settings;
}

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type CameraMode = 'chase' | 'cockpit' | 'far-chase';

export interface Settings {
  quality: QualityLevel;
  renderScale: number;
  /**
   * Whether the player has ever moved the render-scale slider themselves.
   *
   * Stored rather than inferred, because inferring it from the value is unsound. The obvious test
   * — does `renderScale` still equal the current quality profile's — was only ever valid while the
   * profile values 0.72 and 0.86 were unreachable slider stops: no gesture could put 0.72 into
   * storage except never having touched the control. Putting them ON the grid (which the UI needed
   * for its own reasons) destroys exactly that property, and turns a false negative into a silent,
   * permanent false positive: a player who deliberately chooses 0.72 is read as never having
   * chosen anything, and every later quality change overwrites them.
   */
  renderScaleTouched: boolean;
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
  cameraMode: CameraMode;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  renderScale: 1,
  renderScaleTouched: false,
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
  cameraMode: 'chase',
};

export type SfxEvent =
  | 'gatePass'
  | 'checkpoint'
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
  /**
   * Builds the graph WITHOUT resuming it. Safe outside a user gesture, and called once at boot so
   * the ~970,000 samples of synchronous DSP land behind the loading screen instead of inside the
   * player's first interaction.
   *
   * It must never resume. `resume()` on a context the browser has not authorised leaves its
   * promise unsettled — the spec appends it to [[pending resume promises]] and aborts — so a
   * `.catch()` cannot catch it and an await on the boot path hangs forever on any autoplay-gated
   * browser. Resuming here would also start the score before the player has interacted at all,
   * wherever autoplay is permitted.
   */
  prewarm(): Promise<void>;
  /** Must be called from inside a user gesture. Idempotent. Starts the drive and score. */
  unlock(): Promise<void>;
  /**
   * Whether a user gesture has ever reached the engine.
   *
   * Anything that could make the graph audible must consult this now that the graph exists from
   * boot. A context constructed where autoplay is permitted begins `running`, so "we never called
   * resume()" is not a guarantee of silence.
   */
  readonly unlocked: boolean;
  readonly ready: boolean;
  update(dt: number, engine: EngineAudioState): void;
  play(event: SfxEvent, intensity?: number): void;
  /** 0..1 musical intensity; drives layer gates in the generative score. */
  setIntensity(value: number): void;
  setMasterVolume(value: number): void;
  setMusicVolume(value: number): void;
  /**
   * Steps the drive and score back while a menu is showing, WITHOUT stopping the graph.
   *
   * Distinct from suspend/resume on purpose: suspending freezes the context clock for the whole
   * graph, so interface cues fired from a menu schedule into a frozen timeline and never sound.
   */
  menuMix(on: boolean): void;
  /**
   * Context state and both duck gains, or null before the graph exists.
   *
   * Exposed because the last two audio blockers were both invisible to offline measurement by
   * construction: an OfflineAudioContext is never suspended and has no mix state machine, so no
   * number of checks added to the offline gate could ever have caught either one.
   */
  /**
   * Eight fields, not five. The three music-path readings were added with the round-6 Score fix
   * and never declared here; a wider return type is structurally assignable to a narrower
   * declaration, so nothing complained and every TypeScript consumer saw five fields where eight
   * existed. A contract that claims less than the code delivers misleads the reader who never
   * opens the implementation, which is the reader a contract exists for.
   */
  debugMixState(): {
    contextState: string;
    engineDuck: number;
    musicDuck: number;
    musicSendTrim: number;
    musicVolume: number;
    musicSendVolume: number;
    masterGain: number;
    menuEngineFloor: number;
    menuMusicFloor: number;
  } | null;
  /** Called when the tab loses focus. A hidden tab should cost nothing, so this really stops. */
  suspend(): void;
  resume(): void;
  dispose(): void;
}
