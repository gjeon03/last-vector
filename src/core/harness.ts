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
}

export interface HarnessApi {
  readonly version: string;
  /** Resolves once the first frame has been presented. */
  ready(): Promise<void>;
  /** Skip menus and begin a run immediately. */
  startRun(options?: { seed?: number; skipIntro?: boolean }): void;
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
  /** Advance the simulation by a fixed step count without waiting on rAF. */
  step(frames: number, dt?: number): Promise<void>;
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
