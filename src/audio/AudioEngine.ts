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

/**
 * Drive and score trims while a menu is showing. Exported so the offline harness models the same
 * numbers rather than keeping a second copy of them, the way UI_DUCK_DEPTH already is.
 */
export const MENU_DUCK_DEPTH = 0.12;
export const MENU_MUSIC_DEPTH = 0.55;


/** Events loud enough that the pad should step out of their way for a moment. */
const DUCKING_EVENTS: ReadonlySet<SfxEvent> = new Set<SfxEvent>([
  'gatePass',
  'gateMiss',
  'countdownGo',
  'finish',
  'newBest',
  'impact',
  'targetDestroy',
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
  /** Set by the first `unlock()`. Distinct from `sourcesStarted`, which is set after the graph exists. */
  private unlockedFlag = false;
  private sourcesStarted = false;

  private readonly seed: number;
  /**
   * Static trims held by `menuMix`, and the value every transient duck must return TO.
   *
   * A momentary duck that releases to unity silently cancels whatever static trim was underneath
   * it. That is not a quirk of one helper: both `duckEngine` and `duck` released to a hardcoded 1,
   * so a UI click un-ducked the drive for the rest of the menu, and a `finish` or `gatePass` on a
   * results screen did the same to the score. Tracking the floor here fixes the class rather than
   * the reported instance.
   */
  private menuEngineFloor = 1;
  private menuMusicFloor = 1;
  private masterVolume = 0.8;
  private musicVolume = 0.65;
  private pendingIntensity = 0;

  constructor(options: AudioEngineOptions = {}) {
    this.seed = options.seed ?? 0x5eed1e;
  }

  get ready(): boolean {
    return !this.disposed && this.graph !== null;
  }

  /** Whether a user gesture has ever reached the engine. Gates anything that may start sound. */
  get unlocked(): boolean {
    return this.unlockedFlag;
  }

  /**
   * Build only. See `AudioBus.prewarm` for why this must not resume.
   *
   * `build()` is declared async but has no await before its work, so the expensive part — a 3.6 s
   * stereo reverb impulse with exp and pow per sample, a 4 s pink buffer, a 2.5 s white buffer —
   * runs synchronously in the caller's task. That is the point: called at boot it runs behind the
   * loading screen, and the later `unlock()` finds `building` already settled.
   */
  async prewarm(): Promise<void> {
    if (this.disposed || this.failed) return;
    if (!this.building) this.building = this.build();
    await this.building;
  }

  /**
   * Safe to call on every user gesture. By boot time `prewarm()` has usually already built the
   * graph, so this is the resume-only path.
   *
   * CORRECTION: this used to say the context is created lazily "because browsers refuse to start
   * one outside a gesture". They do not. A context may be constructed at any time; it simply
   * begins `suspended`, and only `resume()` requires the gesture. The false premise is what put
   * ~970,000 samples of synchronous JS DSP inside a capture-phase pointerdown handler.
   */
  async unlock(): Promise<void> {
    if (this.disposed || this.failed) return;
    this.unlockedFlag = true;
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
    this.startSources();
  }

  /**
   * Starts the drive and the score. Split out of `build()` because `build()` now runs at boot:
   * the expensive part — the reverb impulse and the noise buffers — belongs behind the loading
   * screen, but the two `.start()` sweeps must wait for a real gesture or the game sounds before
   * anyone has touched it wherever autoplay is permitted.
   */
  private startSources(): void {
    const g = this.graph;
    if (!g || this.sourcesStarted) return;
    this.sourcesStarted = true;
    const start = g.ctx.currentTime + 0.05;
    g.engine.start(start);
    g.music.start(start);
  }

  update(dt: number, engine: EngineAudioState): void {
    const g = this.graph;
    /* Same pre-gesture guard as play(), and it is not optional: guarding play() alone was
       simulated during review and the residual chuff stack queued through this path still peaked
       -9.46 dBFS on the first gesture — 16 dB above the fully-guarded case. Both entry points, or
       it is not fixed. */
    if (!g || !this.unlockedFlag) return;
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
    /* `!this.unlockedFlag` as well as `!g`, and the second half is load-bearing since prewarm().
       The graph now exists from boot with the context suspended, and a suspended context's
       currentTime is FROZEN — so every voice scheduled before the first gesture gets a start time
       that is already in the past the moment the context resumes, and they all fire at once. The
       attract autopilot boosts on the title screen, so this was 90 sources — ten ignitions and ten
       cut-offs collapsed onto one instant at -3.04 dBFS as the first sound of every session, out
       of digital silence. Game.ts's own boost-feedback comment states the violated invariant:
       ignition and cut-off "must never fire together."
       Safe for the player's own first click: unlock() sets unlockedFlag synchronously before its
       first await, from a capture-phase pointerdown that precedes the click event. */
    if (!g || !this.unlockedFlag) return;
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
    const now = g.ctx.currentTime;
    rampTo(g.musicVolume.gain, this.musicVolume, 0.05, now);
    // The score reaches the mix by two paths. Driving only the dry one made this control move
    // 0.55 dB of score between default and silent — a slider that a player could set to zero and
    // still hear the music.
    rampTo(g.music.sendVolume.gain, this.musicVolume, 0.05, now);
    // The score reaches the mix by two paths. Driving only the dry one made this control move
    // 0.55 dB of score between default and silent — a slider that a player could set to zero and
    // still hear the music.
  }

  /**
   * Menu mix: steps the drive and the score back without stopping the graph.
   *
   * `pause()` used to call `ctx.suspend()`, which freezes `currentTime` for the WHOLE graph
   * including `sfxBus` — so every UI cue fired from the pause screen scheduled at
   * `frozen + 0.012` and never synthesised. Measured: zero rendered frames over multiple 1.5 s
   * windows for every cue on the pause, settings and controls screens, including the MASTER
   * VOLUME slider, whose entire purpose is to let you hear the level you are setting. It also
   * gave every cue emitted during the pause one identical timestamp, so they collapsed into a
   * single instant on resume.
   *
   * The offline probe could not see any of this: it has no model of a suspended context.
   *
   * `ctx.suspend()` remains correct for `visibilitychange` — a hidden tab should cost nothing.
   */
  menuMix(on: boolean): void {
    // Recorded before the graph check so a call made before `unlock()` is not lost: `build()`
    // applies these as the initial values.
    this.menuEngineFloor = on ? MENU_DUCK_DEPTH : 1;
    this.menuMusicFloor = on ? MENU_MUSIC_DEPTH : 1;
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    // Cancel pending automation before ramping, exactly as `duckEngine` and `duck` already do.
    //
    // Without this, a transient duck scheduled microseconds earlier outranks the state change that
    // follows it. Clicking RESUME fires `uiClick`, which schedules a release at `when + 0.16`;
    // `menuMix(false)` then ramps toward 1 from `now`, and the still-pending release fires
    // afterwards and pulls the bus back down to the menu floor. The menu closes and the drive
    // never comes back. The asymmetry was the whole bug: the transient helpers cancelled, the
    // state change did not, so whichever was scheduled later won regardless of which was meant to.
    g.engineDuck.gain.cancelScheduledValues(now);
    g.musicDuck.gain.cancelScheduledValues(now);
    g.music.sendTrim.gain.cancelScheduledValues(now);
    rampTo(g.engineDuck.gain, this.menuEngineFloor, 0.12, now);
    rampTo(g.musicDuck.gain, this.menuMusicFloor, 0.12, now);
    // The score's reverb send bypasses `musicDuck`, so trimming only that node ducks the dry pad
    // and leaves its tail — which is most of what is audible — untouched.
    rampTo(g.music.sendTrim.gain, this.menuMusicFloor, 0.12, now);
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

  /**
   * Live mix state, for assertions the offline probe is structurally incapable of making: it has
   * no model of a suspended context and no model of this state machine. Reading AudioParam
   * `.value` returns the computed value at the current instant, so this reflects automation.
   */
  debugMixState(): {
    contextState: string;
    engineDuck: number;
    musicDuck: number;
    musicSendTrim: number;
    musicVolume: number;
    musicSendVolume: number;
    menuEngineFloor: number;
    menuMusicFloor: number;
    masterGain: number;
  } | null {
    const g = this.graph;
    if (!g) return null;
    return {
      contextState: g.ctx.state,
      engineDuck: g.engineDuck.gain.value,
      musicDuck: g.musicDuck.gain.value,
      musicSendTrim: g.music.sendTrim.gain.value,
      musicVolume: g.musicVolume.gain.value,
      musicSendVolume: g.music.sendVolume.gain.value,
      menuEngineFloor: this.menuEngineFloor,
      menuMusicFloor: this.menuMusicFloor,
      /* The node gain, not the stored `masterVolume` intent. Reading back the field the setter
         just wrote proves only that the setter assigns its own field; reading the AudioParam
         proves the slider reached the mix. The music slider shipped with 0.55 dB of travel while
         both suites stayed green, and the check that would have caught it is this distinction. */
      masterGain: g.master.gain.value,
    };
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

      /* The sources are NOT started here — see `startSources()`, called from `unlock()`.
         `build()` now runs at boot, and a context constructed where autoplay is permitted begins
         `running` rather than `suspended`, so starting the drive and score here played the full
         mix on the title screen with zero user interaction. Declining to call `resume()` prevents
         nothing: the gesture is required to resume a SUSPENDED context, never to keep a running
         one running. */
      graph.music.setIntensity(this.pendingIntensity);
      graph.master.gain.value = this.masterVolume * 0.9;
      graph.musicVolume.gain.value = this.musicVolume;
      graph.music.sendVolume.gain.value = this.musicVolume;
      graph.engineDuck.gain.value = this.menuEngineFloor;
      graph.musicDuck.gain.value = this.menuMusicFloor;
      graph.music.sendTrim.gain.value = this.menuMusicFloor;

      this.graph = graph;
      /* Belt and braces to the unstarted sources above: if the browser handed us a context that
         is already running and the player has not yet interacted, put it back to sleep. `suspend()`
         never requires authorisation, so this cannot hang the way `resume()` can and cannot reject
         in a way this catch would miss. */
      if (ctx.state === 'running' && !this.unlocked) void ctx.suspend();
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
    // Cancel first so a menuMix ramp still in flight cannot be half-inherited, then duck to
    // whichever is lower and release back to the menu floor rather than to unity.
    param.cancelScheduledValues(when);
    param.setTargetAtTime(Math.min(UI_DUCK_DEPTH, this.menuEngineFloor), when, 0.012);
    param.setTargetAtTime(this.menuEngineFloor, when + 0.16, 0.1);
  }

  /** Momentary dip of the music bus so a transient reads as loud without being mixed louder. */
  private duck(when: number, depth: number): void {
    const g = this.graph;
    if (!g) return;
    const target = Math.min(depth, this.menuMusicFloor);
    for (const param of [g.musicDuck.gain, g.music.sendTrim.gain]) {
      param.cancelScheduledValues(when);
      param.setTargetAtTime(target, when, 0.02);
      param.setTargetAtTime(this.menuMusicFloor, when + 0.22, 0.42);
    }
  }
}
