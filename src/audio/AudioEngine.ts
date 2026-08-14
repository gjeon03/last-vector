/**
 * The `AudioBus` implementation: mix architecture, lifecycle, and the public surface the rest
 * of LAST VECTOR talks to.
 *
 * Mix topology (all of it procedural, no files, no network):
 *
 *   musicBus ─▶ musicVolume ─▶ musicDuck ─┐
 *   sfxBus ───────────────────────────────┤
 *   engineBus ────────────────────────────┼─▶ preMaster ─▶ glue ─▶ limiter ─▶ master ─▶ out
 *      │  │  │                            │
 *      └──┴──┴─▶ (per-voice sends) ─▶ reverbSend ─▶ convolver ─▶ reverbReturn ─┘
 *
 * The limiter sits *before* the master fader so the mix hits it at a fixed internal level:
 * turning the volume down should make the game quieter, not change how it is compressed.
 *
 * Failure policy: audio is a garnish, never a dependency. If the browser refuses to give us a
 * context, `unlock()` still resolves, `ready` stays false, and every other method is a no-op.
 * The game must remain fully playable with the audio subsystem dead.
 */

import type { AudioBus, EngineAudioState, SfxEvent } from '../core/contracts.ts';
import { EngineLayer } from './engineLayer.ts';
import { MusicBed } from './music.ts';
import {
  clamp01,
  createLimiterCurve,
  createNoiseBuffer,
  createReverbIR,
  createRng,
  NodeLedger,
  rampTo,
} from './nodes.ts';
import { SfxKit } from './sfx.ts';

export interface AudioGraph {
  ctx: BaseAudioContext;
  ledger: NodeLedger;
  master: GainNode;
  /** Sum of every bus plus the reverb return, ahead of the glue compressor and the limiter. */
  preMaster: GainNode;
  musicVolume: GainNode;
  musicDuck: GainNode;
  musicBus: GainNode;
  sfxBus: GainNode;
  engineBus: GainNode;
  /** Post-`engineBus` trim used to step the drive back under UI confirmations. */
  engineDuck: GainNode;
  reverbSend: GainNode;
  reverbReturn: GainNode;
  engine: EngineLayer;
  sfx: SfxKit;
  music: MusicBed;
}

/**
 * How far the drive steps back under a UI confirmation, as a linear gain.
 *
 * The title and briefing screens are not quiet: the attract loop flies behind them at ~0.95
 * throttle, and a menu click measured 10.7 dB *under* that bed. Making the click loud enough to
 * win outright would make it absurd anywhere else, so the drive gives way instead — which is what
 * a mixer would do and what the player expects when a menu is in front of them.
 *
 * Set from measurement rather than taste: at -8 dB the confirmations still sat 2-5 dB under the
 * attract bed, and raising the cues instead would have made a menu click as loud as a gate chime.
 * -11 dB clears both with margin while staying a step-back rather than a mute, over 160 ms.
 *
 * Exported so the measurement harness models the same duck rather than hardcoding a second copy
 * of this number and silently drifting from it.
 */
export const UI_DUCK_DEPTH = 0.28;

/** Events loud enough that the pad should step out of their way for a moment. */
const DUCKING_EVENTS: ReadonlySet<SfxEvent> = new Set<SfxEvent>([
  'gatePass',
  'gateMiss',
  'countdownGo',
  'finish',
  'newBest',
  'impact',
]);

/**
 * UI cues that duck the drive. `uiHover` is deliberately absent: it fires continuously as the
 * pointer crosses a list, and ducking the engine on every one would pump the whole mix.
 */
const ENGINE_DUCK_EVENTS: ReadonlySet<SfxEvent> = new Set<SfxEvent>(['uiClick', 'uiBack']);

/**
 * Builds the whole procedural graph on any `BaseAudioContext`.
 *
 * Exported separately from `AudioEngine` so the offline measurement harness can render the
 * exact production mix through an `OfflineAudioContext` rather than a stand-in.
 */
export const createAudioGraph = (ctx: BaseAudioContext, seed = 0x5eed1e): AudioGraph => {
  const ledger = new NodeLedger();
  const keep = <T extends AudioNode>(node: T): T => ledger.keep(node);

  const master = keep(ctx.createGain());
  master.gain.value = 0.8 * 0.9;
  master.connect(ctx.destination);

  // Soft-knee waveshaper limiter. Transparent under ~-3 dBFS, so it only engages when a gate
  // chime lands on top of a boost transient.
  const limiter = keep(ctx.createWaveShaper());
  limiter.curve = createLimiterCurve(0.72);
  limiter.oversample = '4x';
  limiter.connect(master);

  // Bus compressor for glue: gentle ratio, slow-ish release, so the pad audibly leans back
  // under transients and comes back up between them.
  const glue = keep(ctx.createDynamicsCompressor());
  glue.threshold.value = -15;
  glue.knee.value = 10;
  glue.ratio.value = 2.6;
  glue.attack.value = 0.006;
  glue.release.value = 0.24;
  glue.connect(limiter);

  const preMaster = keep(ctx.createGain());
  preMaster.gain.value = 1;
  preMaster.connect(glue);

  // --- reverb ---------------------------------------------------------------------------
  const reverbSend = keep(ctx.createGain());
  reverbSend.gain.value = 1;
  const convolver = keep(ctx.createConvolver());
  // Normalisation on: an un-normalised 3.6 s impulse response carries roughly +40 dB of
  // integrated gain and would slam the limiter on every send.
  convolver.normalize = true;
  convolver.buffer = createReverbIR(ctx, 3.6, 3.1, 2600, seed ^ 0x9e37);
  const reverbReturn = keep(ctx.createGain());
  reverbReturn.gain.value = 0.9;
  // Roll the return off at both ends: a dark, distant space with no mud under the sub layer.
  const returnHp = keep(ctx.createBiquadFilter());
  returnHp.type = 'highpass';
  returnHp.frequency.value = 170;
  returnHp.Q.value = 0.7;
  reverbSend.connect(convolver);
  convolver.connect(returnHp);
  returnHp.connect(reverbReturn);
  reverbReturn.connect(preMaster);

  // --- sub-buses ------------------------------------------------------------------------
  // Bus trims are the mix. Music sits well under the drive: the score is a bed, not a soundtrack
  // the player has to talk over.
  const musicBus = keep(ctx.createGain());
  musicBus.gain.value = 0.1;
  const musicVolume = keep(ctx.createGain());
  musicVolume.gain.value = 0.65;
  const musicDuck = keep(ctx.createGain());
  musicDuck.gain.value = 1;
  musicBus.connect(musicVolume);
  musicVolume.connect(musicDuck);
  musicDuck.connect(preMaster);

  const sfxBus = keep(ctx.createGain());
  sfxBus.gain.value = 0.85;
  sfxBus.connect(preMaster);

  const engineBus = keep(ctx.createGain());
  engineBus.gain.value = 0.75;
  const engineDuck = keep(ctx.createGain());
  engineDuck.gain.value = 1;
  engineBus.connect(engineDuck);
  engineDuck.connect(preMaster);

  // --- generated source material ---------------------------------------------------------
  const air = createNoiseBuffer(ctx, 4, 'pink', seed ^ 0x1234);
  const spark = createNoiseBuffer(ctx, 2.5, 'white', seed ^ 0x4321);

  const engine = new EngineLayer({ ctx, destination: engineBus, send: reverbSend, ledger, noise: air });
  const sfx = new SfxKit({
    ctx,
    destination: sfxBus,
    send: reverbSend,
    ledger,
    air,
    spark,
    rng: createRng(seed ^ 0xabcd),
  });
  const music = new MusicBed({
    ctx,
    destination: musicBus,
    send: reverbSend,
    ledger,
    air,
    rng: createRng(seed ^ 0xfeed),
  });

  return {
    ctx,
    ledger,
    master,
    preMaster,
    reverbReturn,
    musicVolume,
    musicDuck,
    musicBus,
    sfxBus,
    engineBus,
    engineDuck,
    reverbSend,
    engine,
    sfx,
    music,
  };
};

export interface AudioEngineOptions {
  /** Seeds every PRNG in the subsystem. Same seed, same variation. */
  seed?: number;
}

export class AudioEngine implements AudioBus {
  private graph: (AudioGraph & { ctx: AudioContext }) | null = null;
  private building: Promise<void> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private failed = false;

  private readonly seed: number;
  private masterVolume = 0.8;
  private musicVolume = 0.65;
  private pendingIntensity = 0;

  constructor(options: AudioEngineOptions = {}) {
    this.seed = options.seed ?? 0x5eed1e;
  }

  get ready(): boolean {
    return !this.disposed && this.graph !== null;
  }

  /**
   * Safe to call on every user gesture. The context is created lazily because browsers refuse
   * to start one outside a gesture; repeat calls just make sure it is running again.
   */
  async unlock(): Promise<void> {
    if (this.disposed || this.failed) return;
    if (!this.building) this.building = this.build();
    await this.building;
    const g = this.graph;
    if (!g) return;
    if (g.ctx.state !== 'running') {
      try {
        await g.ctx.resume();
      } catch {
        /* a browser that refuses to resume leaves us silent, not broken */
      }
    }
  }

  update(dt: number, engine: EngineAudioState): void {
    const g = this.graph;
    if (!g) return;
    const step = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 0.016;
    g.engine.update(step, engine);
    // Belt and braces: the interval ticker can be throttled, the frame loop cannot.
    g.ledger.sweep(g.ctx.currentTime);
  }

  /**
   * `intensity` is event-specific — streak heat for `gatePass`, closeness for `gateNear`,
   * strike energy for `impact`, ignored by the UI blips. 0.5 is the neutral default.
   */
  play(event: SfxEvent, intensity = 0.5): void {
    const g = this.graph;
    if (!g) return;
    // A hair of lookahead: scheduling exactly at `currentTime` can drop the attack segment.
    const when = g.ctx.currentTime + 0.012;
    try {
      g.sfx.play(event, intensity, when);
    } catch {
      /* a single malformed voice must never take the run down */
      return;
    }
    if (DUCKING_EVENTS.has(event)) this.duck(when, event === 'gatePass' ? 0.62 : 0.7);
    if (ENGINE_DUCK_EVENTS.has(event)) this.duckEngine(when);
  }

  setIntensity(value: number): void {
    this.pendingIntensity = clamp01(value);
    this.graph?.music.setIntensity(this.pendingIntensity);
  }

  setMasterVolume(value: number): void {
    this.masterVolume = clamp01(value);
    const g = this.graph;
    if (!g) return;
    rampTo(g.master.gain, this.masterVolume * 0.9, 0.03, g.ctx.currentTime);
  }

  setMusicVolume(value: number): void {
    this.musicVolume = clamp01(value);
    const g = this.graph;
    if (!g) return;
    rampTo(g.musicVolume.gain, this.musicVolume, 0.05, g.ctx.currentTime);
  }

  suspend(): void {
    const g = this.graph;
    if (!g) return;
    try {
      void g.ctx.suspend();
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    const g = this.graph;
    if (!g) return;
    try {
      void g.ctx.resume();
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTicker();
    const g = this.graph;
    this.graph = null;
    this.building = null;
    if (!g) return;
    const now = g.ctx.currentTime;
    try {
      g.engine.stop(now);
      g.music.stop(now);
      g.ledger.disposeAll();
      void g.ctx.close();
    } catch {
      /* teardown must not throw during page unload */
    }
  }

  /**
   * Live AudioNode count: the permanent graph plus every one-shot still awaiting retirement.
   * Used by the measurement harness to prove that firing events does not leak nodes.
   */
  debugNodeCount(): number {
    return this.graph ? this.graph.ledger.count() : 0;
  }

  /** Permanent (non-one-shot) portion of the node count. */
  debugPermanentNodeCount(): number {
    return this.graph ? this.graph.ledger.permanentCount() : 0;
  }

  private async build(): Promise<void> {
    try {
      const scope = globalThis as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
      if (!Ctor) {
        this.failed = true;
        return;
      }
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const graph = createAudioGraph(ctx, this.seed) as AudioGraph & { ctx: AudioContext };
      graph.ctx = ctx;

      if (this.disposed) {
        graph.ledger.disposeAll();
        void ctx.close();
        return;
      }

      const start = ctx.currentTime + 0.05;
      graph.engine.start(start);
      graph.music.start(start);
      graph.music.setIntensity(this.pendingIntensity);
      graph.master.gain.value = this.masterVolume * 0.9;
      graph.musicVolume.gain.value = this.musicVolume;

      this.graph = graph;
      this.startTicker();
    } catch {
      // Autoplay policy, no output device, exhausted context quota — all the same to us.
      this.failed = true;
      this.graph = null;
    }
  }

  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => {
      const g = this.graph;
      if (!g) return;
      const now = g.ctx.currentTime;
      g.ledger.sweep(now);
      g.music.tick(now);
    }, 90);
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * Momentary dip of the drive so a UI confirmation is audible over the attract flight without
   * having to be mixed loud enough to survive it. Only the dry path dips — the engine's reverb
   * send taps ahead of the bus — but at a send of 0.075 that residue is negligible.
   */
  private duckEngine(when: number): void {
    const g = this.graph;
    if (!g) return;
    const param = g.engineDuck.gain;
    param.setTargetAtTime(UI_DUCK_DEPTH, when, 0.012);
    param.setTargetAtTime(1, when + 0.16, 0.1);
  }

  /** Momentary dip of the music bus so a transient reads as loud without being mixed louder. */
  private duck(when: number, depth: number): void {
    const g = this.graph;
    if (!g) return;
    const param = g.musicDuck.gain;
    param.setTargetAtTime(depth, when, 0.02);
    param.setTargetAtTime(1, when + 0.22, 0.42);
  }
}
