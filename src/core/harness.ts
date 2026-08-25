/**
 * Automation surface. Exposed as `window.__LV` so headless playtests, perf probes and
 * screenshot matrices can drive the game deterministically without synthetic input events.
 *
 * This is a stable contract: the playtest tooling under `scripts/playtest/` depends on it.
 */

import type {
  CameraMode,
  Locale,
  LocaleFontStatus,
  Phase,
  MissionResult,
  Settings,
  Telemetry,
} from './contracts.ts';
import type { CourseId, ObjectiveId } from './Courses.ts';
import type { MissionId } from './Missions.ts';
import type { MissionResolution } from './MissionSelection.ts';
import type { ProgressV2, ProgressWriteOutcome } from './Progress.ts';

export interface HarnessInput {
  /**
   * -1..1, positive = nose up.
   *
   * CORRECTION. This used to say "before invertY is applied", which stated that invertY is applied
   * to harness input downstream. It is not. `Input.update()` returns inside the override branch at
   * `Input.ts:171` and `invertY` is only read at `:226`, below that return — so harness-supplied
   * pitch is never inverted, at any setting. A playtest author reading the old text would expect
   * `setInput({pitch: 1})` with `invertY: true` to fly nose-down; it flies nose-up. The doc
   * described the keyboard/mouse path while sitting on the struct that bypasses it.
   */
  pitch?: number;
  /** -1..1, positive = nose right. */
  yaw?: number;
  /** -1..1, positive = roll right. */
  roll?: number;
  /** 0..1 commanded throttle. */
  throttle?: number;
  /** -1..1 lateral strafe, positive = right. */
  strafeX?: number;
  /** -1..1 vertical strafe, positive = up. */
  strafeY?: number;
  fire?: boolean;
  boost?: boolean;
  brake?: boolean;
}

export interface PerfSample {
  frames: number;
  seconds: number;
  fps: number;
  /** Milliseconds. */
  meanFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
  /** Frames slower than 20 ms. */
  longFrames: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  /**
   * Effective internal render scale during the sample. Adaptive resolution moves this to hold
   * the frame budget, so an fps number is only meaningful alongside it.
   */
  renderScale: number;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
}

/** Read-only physical state, so a driver can prove six-axis motion without game internals. */
export interface HarnessPose {
  position: [number, number, number];
  /** x, y, z, w. */
  quaternion: [number, number, number, number];
  velocity: [number, number, number];
  /** Body-frame rates: pitch, yaw, roll. */
  angularVelocity: [number, number, number];
  forward: [number, number, number];
  /**
   * Where the camera actually is and what it is pointed at, in world space.
   *
   * Exposed because a screenshot suite that cannot see the camera cannot tell a badly aimed
   * vantage from a missing object: the terminus vantage produced ten committed stills of empty
   * sky while the same object rendered correctly in flight, and nothing in the harness could
   * distinguish those two cases.
   */
  camera: {
    position: [number, number, number];
    forward: [number, number, number];
    /** Active perspective near plane, metres. Cockpit mode needs a substantially closer plane. */
    near: number;
    /** Active vertical field of view, degrees. */
    fov: number;
  };
}

/**
 * Read-only proof that the first-person interior is a physical, state-fed scene rather than a
 * screen-space frame. Geometry counts are cockpit-only, not totals for the world render.
 */
export interface HarnessCockpitDebugState {
  visible: boolean;
  fov: number;
  near: number;
  perspectiveScale: [number, number, number];
  drawCalls: number;
  triangles: number;
  minCameraDistance: number;
  motionX: number;
  motionY: number;
  motionZ: number;
  motionPitch: number;
  motionYaw: number;
  motionRoll: number;
  stickPitch: number;
  stickYaw: number;
  stickRoll: number;
  throttleAngle: number;
  mfdUpdates: number;
}

/** JSON-safe proof of the physical MFD's locale, fitted labels, pixels, and projection. */
export interface HarnessCockpitMfdEvidence {
  locale: Locale;
  renderedLocale: Locale;
  fontReady: boolean;
  visible: boolean;
  canvas: { width: 1024; height: 256 };
  labelRoi: { x: number; y: number; width: number; height: number; hash: string };
  labels: ReadonlyArray<{
    key: string;
    text: string;
    fontPx: number;
    measuredWidth: number;
    allowedWidth: number;
    ellipsized: boolean;
  }>;
  /** Final model projection before post-processing, in TL/TR/BR/BL order. */
  projectedNdcCorners: ReadonlyArray<readonly [number, number, number]>;
  /** Projection after the final composite's radial warp, in TL/TR/BR/BL order. */
  screenNdcCorners: ReadonlyArray<readonly [number, number, number]>;
  /** Fixed canvas label ROI projection before post-processing, in TL/TR/BR/BL order. */
  labelProjectedNdcCorners: ReadonlyArray<readonly [number, number, number]>;
  /** Fixed canvas label ROI after the final composite's radial warp, in TL/TR/BR/BL order. */
  labelScreenNdcCorners: ReadonlyArray<readonly [number, number, number]>;
  mfdUpdates: number;
}

/**
 * Read-only proof for the exterior ship and its paired drive plume. Counts describe only the
 * ship model, so world debris density cannot make this regression contract fluctuate.
 */
export interface HarnessShipVisualDebugState {
  visible: boolean;
  drawCalls: number;
  triangles: number;
  plumeTriangles: number;
  materials: number;
  nozzleAnchors: ReadonlyArray<ShipNozzleAnchor>;
  /** Final model-world projection points for screenshot-space engine ROI measurement. */
  engineProjection: ReadonlyArray<ShipEngineProjection>;
  plume: {
    power: number;
    boost: number;
    length: number;
    width: number;
    coreStretch: number;
    coreGain: number;
    ignite: number;
    release: number;
    cells: number;
    cellFreq: number;
    glowPower: number;
  };
}

export interface ShipEngineProjection {
  mouthNdc: readonly [number, number, number];
  mouthRimNdc: readonly [number, number, number];
  coreNdc: readonly [number, number, number];
  coreRimNdc: readonly [number, number, number];
  sheathMidNdc: readonly [number, number, number];
  sheathMidRimNdc: readonly [number, number, number];
  tailNdc: readonly [number, number, number];
  /** The same points after inverting the boost lens warp into final screenshot coordinates. */
  mouthScreenNdc: readonly [number, number, number];
  mouthRimScreenNdc: readonly [number, number, number];
  coreScreenNdc: readonly [number, number, number];
  coreRimScreenNdc: readonly [number, number, number];
  sheathMidScreenNdc: readonly [number, number, number];
  sheathMidRimScreenNdc: readonly [number, number, number];
  tailScreenNdc: readonly [number, number, number];
}

export interface ShipNozzleAnchor {
  position: readonly [number, number, number];
  radius: number;
}

export interface GatePassRecord {
  index: number;
  /** Run time at the crossing, seconds. */
  time: number;
  /** Metres from the gate axis at the crossing. */
  radialDistance: number;
  speed: number;
  cleared: boolean;
  /** Normalised overdrive reserve immediately before and after the gate's 25% reward. */
  boostEnergyBefore: number;
  boostEnergyAfter: number;
}

export interface HarnessLocaleState {
  selected: Locale;
  active: Locale | null;
  locked: boolean;
  settingsSubscribers: number;
  fontStatus: LocaleFontStatus;
}

/** Stable, JSON-safe identity for the one route whose world was built at boot. */
export interface HarnessCourseState {
  courseId: CourseId;
  recordId: string;
  seed: number;
  gateCount: number;
  length: number;
  resolution: MissionResolution;
}

/** Dependency-free catalog projection; it deliberately excludes render/world objects. */
export interface HarnessCatalogState {
  /** Player-facing Chapter 01 sequence. */
  order: readonly CourseId[];
  /** Sanitized identities, including dormant definitions retained for migration. */
  recognizedOrder: readonly CourseId[];
  courses: ReadonlyArray<{
    id: CourseId;
    order: number;
    defaultSeed: number;
    recordId: string;
    active: boolean;
    nextCourseId: CourseId | null;
    gateCount: number;
    sector: string;
    destination: string;
    objectives: readonly ObjectiveId[];
    shearGates: readonly number[];
    landmarkKind: string;
    radio: ReadonlyArray<{
      afterGate: number;
      speaker: string;
      messageKey: string;
      safeWindowSeconds: number;
    }>;
  }>;
}

/** Every aperture-plane crossing, including recoverable misses. */
export interface HarnessCourseCrossing {
  index: number;
  time: number;
  radialDistance: number;
  speed: number;
  /** Fraction of the aperture radius. */
  normalizedOffset: number;
  cleared: boolean;
  blockedBy: 'aperture' | 'shear' | null;
}

/** Shared render/predicate phase evidence for the active route's SHEAR field. */
export interface HarnessShearState {
  drawCalls: number;
  triangles: number;
  halfWidthRadians: number;
  hubRadiusFraction: number;
  states: ReadonlyArray<{
    gateIndex: number;
    phase: number;
    initialPhase: number;
    angularSpeed: number;
  }>;
}

/** Fixed authored landmark resource/collision evidence for the one boot-built stage. */
export interface HarnessStageLandmarkState {
  kind: string;
  landmarks: readonly string[];
  signature: string;
  draws: number;
  triangles: number;
  geometries: number;
  materials: number;
  colliders: number;
}

export interface HarnessApi {
  readonly version: string;
  /**
   * The seed the loaded world was generated from. The course is built once at boot, so the
   * seed cannot be changed at runtime — load `?seed=<uint32>` to select a different one.
   * Reporting it here is what makes a failing run reproducible.
   */
  readonly seed: number;
  /** Resolves once the first frame has been presented. */
  ready(): Promise<void>;
  /**
   * Begin a run immediately, skipping the title and briefing.
   *
   * `skipIntro` additionally skips the countdown. Every suite entry point passes it; an earlier
   * docstring claimed the interface never does, which was never true of anything.
   */
  startRun(options?: { skipIntro?: boolean }): void;
  /** Latest telemetry snapshot. */
  telemetry(): Telemetry;
  phase(): Phase;
  /** Non-null once the run has finished successfully; failures deliberately keep this null. */
  result(): MissionResult | null;
  /** Active boot-built route identity and URL-resolution evidence. */
  course(): HarnessCourseState;
  /** Immutable route authoring projected to a compact JSON-safe catalog. */
  catalog(): HarnessCatalogState;
  /** Sanitized campaign progress, kept separate from per-seed PB storage. */
  progress(): ProgressV2;
  /** Current route's moving-barrier phases, or null for a route without SHEAR. */
  shear(): HarnessShearState | null;
  /** Read-only signature and bounded resource counts for the selected stage landmarks. */
  landmarks(): HarnessStageLandmarkState;
  /** Aperture-plane outcomes; unlike gateHistory(), this includes misses. */
  crossings(): HarnessCourseCrossing[];
  /**
   * Test-only: cross the currently armed SHEAR gate through its blocked hub using the production
   * Course.update -> onMiss path. The caller must first stage a SHEAR gate with seekCourse().
   */
  stageShearBlock(): HarnessCourseCrossing | null;
  /** Test-only validated progress installation. Raw storage stays encapsulated. */
  installProgress(value: unknown): ProgressWriteOutcome;
  /** Build navigation data only. This never changes location or simulation state. */
  routeUrl(missionId: MissionId): string;
  /**
   * Apply normalised structural damage for deterministic terminal-state tests.
   *
   * Damage is accepted only while actively flying. Reaching zero does not change phase inside
   * this call: the next simulation step resolves all same-frame damage first, then transitions
   * once to `failed`. The clamped hull value is returned in every phase.
   */
  damageHull(amount: number): number;
  /**
   * Stage one deterministic contact against a currently drawn asteroid.
   *
   * This moves the ship into overlap at a known closing speed but applies no damage itself. The
   * next `step()` must run the production asteroid-motion, collision and `Ship.applyImpact` path.
   * Repeated calls preserve accumulated hull damage and the run's contact sequence. Returns null
   * outside active flight or when no drawn asteroid is available.
   */
  stageCollision(): { rockId: number; overlap: number; closingSpeed: number } | null;
  /** Stage a collision through the authored landmark contact path; null when none exist. */
  stageLandmarkCollision(): {
    colliderId: string;
    overlap: number;
    closingSpeed: number;
  } | null;
  /** Override pilot input. Values persist until changed. `null` returns control to the human. */
  setInput(input: HarnessInput | null): void;
  /**
   * Fly a perfect racing line automatically. Used for unattended playthroughs and
   * for parking the camera at scripted vantage points.
   */
  /**
   * `skill` scales the controller's GAIN, not stick travel: at `skill: 0.25` the autopilot can
   * still emit 0.65 of stick. It is not a stick cap, and using it as one to measure control
   * authority gives a wrong answer.
   */
  setAutopilot(enabled: boolean, options?: { skill?: number }): void;
  /** Jump the ship to a normalised position along the course, 0..1. */
  seekCourse(t: number): void;
  /** Park a free camera at a named cinematic vantage point for screenshots. */
  vantage(name: string): void;
  /** Return from an authored vantage to the player's selected flight camera. */
  clearVantage(): void;
  /** Names accepted by `vantage`. */
  vantages(): string[];
  /**
   * What each vantage is a picture OF, so a screenshot suite can assert the right subject.
   *
   * A gate- or terminus-anchored vantage must have `telemetry.gate.anchor.onScreen`; a
   * ship-anchored one frames the ship by construction and the gate may legitimately be behind
   * the camera. Without this the suite either misses empty frames or fails good ones.
   */
  vantageSubjects(): { name: string; subject: 'ship' | 'gate' | 'terminus' }[];
  /**
   * Takes frame pacing away from requestAnimationFrame so the caller drives the simulation.
   * While driven, the rAF loop renders nothing and advances nothing.
   */
  /**
   * Takes the frame loop from rAF. Zeroes the world clock on the transition into driven mode,
   * so animated shaders start from the same phase in every process.
   */
  setDriven(driven: boolean): void;
  /**
   * Advance the simulation by exactly `frames` steps of `dt`. Implies `setDriven(true)` and
   * leaves it enabled, so elapsed time advances by exactly `frames * dt` and not one frame
   * more. Call `setDriven(false)` to hand pacing back.
   */
  step(frames: number, dt?: number): Promise<void>;
  /**
   * Advance only the production simulation path, then synchronise visuals/telemetry once.
   * Intended for high-rate deterministic course proofs; performance and pixels use normal frames.
   */
  stepSimulation(frames: number, dt?: number): void;
  /**
   * Waits for the compositor to show what has already been rendered. Does NOT render.
   *
   * While driven, the rAF loop advances nothing, so a frame only exists after `step()`. Calling
   * `present()` alone therefore shows the PREVIOUS frame — which is how a capture of the start
   * line was published as a picture of the destination. The old docstring said "renders one
   * frame" and that was never true in either mode.
   */
  present(): Promise<void>;
  /** Physical state of the ship this frame. */
  pose(): HarnessPose;
  /** Exterior ship/plume topology and the scalar VFX state currently presented. */
  shipDebug(): HarnessShipVisualDebugState;
  /** The pilot command actually applied this frame, after overrides and assists. */
  activeInput(): Required<HarnessInput>;
  /** Every gate crossing so far, in order. Survives until the next `startRun`. */
  gateHistory(): GatePassRecord[];
  /**
   * How much room the racing line actually has, sampled against the rocks currently DRAWN.
   *
   * Whether that is also the set that COLLIDES is reported, not assumed: an earlier version of
   * this docstring asserted it in prose, and a mutation rewiring the collider to the full field
   * changed no check in the gate. `colliderSharesDrawnList` carries the enforced answer.
   *
   * Two limits, because quoting these digits without them has produced three different answers
   * for one property. It lerps STRAIGHT CHORDS between gate centres, not the curve the ship
   * flies, so it overstates room around the real racing line by up to 4.3x. And it is sample-count
   * sensitive: state your `samples` alongside any figure or the figure is not reproducible.
   *
   * This exists because two defects were invisible without it. The course had a 320 m clear
   * tube from end to end, so no obstacle could ever be on the flown line; and the collision set
   * was the full field while the drawn set followed the quality profile, so a third of the
   * rocks a player could hit were never rendered. Both produced bit-identical traces.
   */
  hazard(samples?: number): HazardReport;
  /**
   * Metres the ship is currently OUTSIDE the debris-free channel. Negative means inside it.
   *
   * The channel is authored, but what a pilot flies is a controller's output, and on the
   * sharpest leg the two are not the same: a proportional follower swings wide of both the
   * curve and the chord. This measures that gap instead of guessing at it.
   */
  channelExcursion(): number;
  /** Collect a perf sample over `seconds` of real time. */
  profile(seconds: number): Promise<PerfSample>;
  settings(): Settings;
  setSettings(patch: Partial<Settings>): void;
  /** Selected title locale and the nullable locale snapshot locked to the current run. */
  locale(): HarnessLocaleState;
  /** The flight camera mode currently applied by the game, not merely the stored preference. */
  cameraMode(): CameraMode;
  /** Physical cockpit pose, controls, instrument cadence, and cockpit-only render cost. */
  cockpitDebug(): HarnessCockpitDebugState;
  /** Physical MFD locale, fitted-label, source-pixel, and final-screen evidence. */
  cockpitMfd(): HarnessCockpitMfdEvidence;
  /**
   * Freezes SIMULATION only. Does NOT open the pause menu, release pointer lock or duck the
   * drive, so it reaches a state no player can occupy: paused, pointer still locked, audio at
   * full level. That is correct for a screenshot — a pause veil over every vantage is not what
   * the stills suite is photographing — and wrong for anything testing pause behaviour.
   */
  setPaused(paused: boolean): void;
  /** The player's pause, by the route a player takes: `Game.pause()` / `Game.resume()`. */
  pauseMenu(on: boolean): void;
  /**
   * Deterministic time control: fixes dt so playthroughs are reproducible.
   *
   * This fixes the STEP. `setDriven(true)` zeroes the world clock, which fixes the ORIGIN. Two
   * processes need both to render the same frame.
   */
  setFixedTimestep(dt: number | null): void;
  /**
   * Live audio state: context state and both duck gains.
   *
   * The offline probe cannot see a suspended context or a mix state machine, and both of the
   * round-4 audio blockers lived in exactly that gap — one of them survived a 23/23-green gate.
   * Returns null before the first user gesture, because the context does not exist until then.
   */
  audioState(): {
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
  /** Errors captured by the game's own error boundary. */
  errors(): string[];
}

export interface HazardReport {
  /** Rocks drawn, and therefore collidable, right now. */
  activeRocks: number;
  /** Rocks classed as course rather than scenery. Must not change with quality. */
  gameplayRocks: number;
  /** Every rock that exists, drawn or not. */
  totalRocks: number;
  /** Metres from the line to the nearest rock SURFACE, at the tightest point of the course. */
  minClearance: number;
  /** 5th percentile and median clearance across the sampled line. */
  p05Clearance: number;
  medianClearance: number;
  /** Fraction of the line with less than 200 m of room either side. */
  tightFraction: number;
  /**
   * Whether the list the collider ITERATED on its last pass is, by reference identity, the drawn
   * gameplay list this report sampled. Null until the first simulated frame records one.
   *
   * This field exists because the coupling used to be prose. The docstring above claimed the
   * sampled set "is the same set that collides" with nothing enforcing it, and a mutation
   * rewiring the collider to the full field changed no check in the gate — recreating, exactly,
   * the historical defect this API was built to catch (collision against the full field, drawing
   * from the quality-scaled subset, a third of hittable rocks never rendered, bit-identical
   * traces). Both call sites read the same list, so parity between them measured nothing about
   * the collider. Identity of the recorded list does.
   */
  colliderSharesDrawnList: boolean | null;
  /** Deterministic, gameplay-only moving subset; never varies with the quality population. */
  motion: {
    count: number;
    cap: number;
    elapsed: number;
    /** Peak metres any moving rock has left its authored position since the last motion reset. */
    maxDisplacement: number;
    displacementLimit: number;
    /** Peak player-proximity retreat since reset; outward from the line and separately bounded. */
    maxPlayerResponse: number;
    playerResponseLimit: number;
    /** Minimum distance change caused by reaction; non-negative means it never approaches. */
    minPlayerDistanceDelta: number;
    /** Minimum observed surface clearance to the protected spawn bubble and gate apertures. */
    minProtectedVolumeClearance: number;
    /** Stable ids and quantised positions, suitable for reset/seed determinism assertions. */
    signature: string;
  };
}

declare global {
  interface Window {
    __LV?: HarnessApi;
  }
}

/**
 * READINESS CONTRACT
 *
 * A WebGL game cannot be ready at the `load` event: the renderer has to be created, the sky
 * cube map baked and the asteroid field generated first, which takes on the order of a second.
 * There is therefore no synchronous readiness signal, and any driver that inspects `window.__LV`
 * immediately after `load` will find nothing.
 *
 * Wait for either of these, then call `ready()`:
 *
 *   await page.waitForFunction(() => Boolean(window.__LV), null, { timeout: 45000 });
 *   await page.waitForSelector('html[data-lv-ready="1"]');
 *
 * The `data-lv-ready` attribute is set on the document element at the same moment `window.__LV`
 * is assigned, so either is sufficient.
 */
export const HARNESS_READY_ATTRIBUTE = 'data-lv-ready';
