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

declare global {
  interface Window {
    __LV?: HarnessApi;
  }
}
