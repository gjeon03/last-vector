/**
 * Automation surface. Exposed as `window.__LV` so headless playtests, perf probes and
 * screenshot matrices can drive the game deterministically without synthetic input events.
 *
 * This is a stable contract: the playtest tooling under `scripts/playtest/` depends on it.
 */

import type { Phase, RunResult, Settings, Telemetry } from './contracts.ts';

export interface HarnessInput {
  /** -1..1, positive = nose up (before invertY is applied). */
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
  };
}

export interface GatePassRecord {
  index: number;
  /** Run time at the crossing, seconds. */
  time: number;
  /** Metres from the gate axis at the crossing. */
  radialDistance: number;
  speed: number;
  cleared: boolean;
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
  /** Skip menus and begin a run immediately. */
  startRun(options?: { skipIntro?: boolean }): void;
  /** Latest telemetry snapshot. */
  telemetry(): Telemetry;
  phase(): Phase;
  /** Non-null once the run has finished. */
  result(): RunResult | null;
  /** Override pilot input. Values persist until changed. `null` returns control to the human. */
  setInput(input: HarnessInput | null): void;
  /**
   * Fly a perfect racing line automatically. Used for unattended playthroughs and
   * for parking the camera at scripted vantage points.
   */
  setAutopilot(enabled: boolean, options?: { skill?: number }): void;
  /** Jump the ship to a normalised position along the course, 0..1. */
  seekCourse(t: number): void;
  /** Park a free camera at a named cinematic vantage point for screenshots. */
  vantage(name: string): void;
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
  setDriven(driven: boolean): void;
  /**
   * Advance the simulation by exactly `frames` steps of `dt`. Implies `setDriven(true)` and
   * leaves it enabled, so elapsed time advances by exactly `frames * dt` and not one frame
   * more. Call `setDriven(false)` to hand pacing back.
   */
  step(frames: number, dt?: number): Promise<void>;
  /** Renders one frame and resolves after it has been presented. */
  present(): Promise<void>;
  /** Physical state of the ship this frame. */
  pose(): HarnessPose;
  /** The pilot command actually applied this frame, after overrides and assists. */
  activeInput(): Required<HarnessInput>;
  /** Every gate crossing so far, in order. Survives until the next `startRun`. */
  gateHistory(): GatePassRecord[];
  /**
   * How much room the racing line actually has. Sampled along start -> every gate -> terminus
   * against the rocks that are currently DRAWN, which is the same set that collides.
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
  /** Freeze/unfreeze simulation without pausing rendering. */
  setPaused(paused: boolean): void;
  /** Deterministic time control: fixes dt so playthroughs are reproducible. */
  setFixedTimestep(dt: number | null): void;
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
