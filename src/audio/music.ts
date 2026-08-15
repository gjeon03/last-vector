/**
 * The generative score for THE CAIRN DRIFT.
 *
 * Harmonically static by design: one chord, D minor with a ninth, held for the entire run.
 * A drifting sector orbiting a dying star is not a place that modulates. What changes instead
 * is density — layers gate in and out over multi-second crossfades as the run gets hotter, so
 * the music tracks tension without ever announcing itself with a transition.
 *
 * There is no loop point anywhere: the pad is continuous oscillators, and the sub pulse and
 * bell motif are scheduled onto a slow grid by a lookahead scheduler. It therefore runs
 * indefinitely with no seam and with a bounded node count.
 */

import {
  clamp01,
  createLfo,
  createNoiseSource,
  rampTo,
  startNoise,
  type NodeLedger,
} from './nodes.ts';

export interface MusicBedOptions {
  ctx: BaseAudioContext;
  destination: AudioNode;
  send: AudioNode;
  ledger: NodeLedger;
  /** Pink noise, for the wind bed. */
  air: AudioBuffer;
  rng: () => number;
}

interface PadVoiceSpec {
  freq: number;
  type: OscillatorType;
  level: number;
  lfoHz: number;
  lfoCents: number;
  phase: number;
}

/**
 * D2 A2 D3 F3 A3 C4 E4 — Dm7(add9), voiced in fifths at the bottom so the low end stays clear
 * and the colour tones sit high and quiet. No sixth, so the mode reads as ambiguous between
 * Dorian and Aeolian: unresolved, which is the point.
 */
const PAD_VOICES: readonly PadVoiceSpec[] = [
  { freq: 73.42, type: 'sine', level: 0.3, lfoHz: 0.031, lfoCents: 5, phase: 0.0 },
  { freq: 110.0, type: 'sine', level: 0.22, lfoHz: 0.043, lfoCents: 7, phase: 1.1 },
  { freq: 146.83, type: 'triangle', level: 0.19, lfoHz: 0.027, lfoCents: 6, phase: 2.3 },
  { freq: 174.61, type: 'triangle', level: 0.14, lfoHz: 0.037, lfoCents: 9, phase: 3.4 },
  { freq: 220.0, type: 'sine', level: 0.13, lfoHz: 0.023, lfoCents: 8, phase: 4.6 },
  { freq: 261.63, type: 'sine', level: 0.1, lfoHz: 0.051, lfoCents: 11, phase: 5.2 },
  { freq: 329.63, type: 'sine', level: 0.06, lfoHz: 0.019, lfoCents: 13, phase: 6.0 },
];

/** D Aeolian above the staff. The motif only ever lands on these. */
const MOTIF_SCALE = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46];
/** Inharmonic partials of a small struck bell. */
const BELL_RATIOS = [1, 2.742, 5.404];

const BAR = 4.8;
const MOTIF_GRID = 1.2;
const LOOKAHEAD = 1.6;

/** Smooth gate so a layer never pops in on a single frame of intensity noise. */
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export class MusicBed {
  private readonly ctx: BaseAudioContext;
  private readonly ledger: NodeLedger;
  private readonly rng: () => number;

  /** Trim on the reverb-send path, ducked in step with `musicDuck`. See the constructor. */
  readonly sendTrim: GainNode;
  /** Player volume on the reverb-send path, driven in step with `musicVolume`. */
  readonly sendVolume: GainNode;
  private readonly padGate: GainNode;
  private readonly subGate: GainNode;
  private readonly subEnv: GainNode;
  private readonly motifGate: GainNode;
  private readonly windGate: GainNode;

  private readonly startables: OscillatorNode[] = [];
  private readonly noiseVoices: ReturnType<typeof createNoiseSource>[] = [];

  private intensity = 0;
  private started = false;
  private nextPulse = 0;
  private nextMotif = 0;
  private lastMotifIndex = -1;

  constructor(options: MusicBedOptions) {
    const { ctx, destination, send, ledger, air, rng } = options;
    this.ctx = ctx;
    this.ledger = ledger;
    this.rng = rng;

    const keep = <T extends AudioNode>(node: T): T => ledger.keep(node);
    // Every layer's reverb send passes through these two before reaching the shared bus.
    //
    // The sends tap each layer gate directly, which is upstream of `musicBus` — so they bypass
    // `musicBus`, `musicVolume` and `musicDuck` entirely, and they carry most of the score's
    // power: measured broadband on the isolated stem, only ~10.8% of it travels the dry path.
    //
    // That single fact broke two separate things, and they need two separate nodes because they
    // are driven by different callers at different rates:
    //   `sendTrim`   follows the momentary and menu ducks, alongside `musicDuck`
    //   `sendVolume` follows the player's Score slider, alongside `musicVolume`
    //
    // An earlier fix added `sendTrim` and wired it to both ducks — while this comment already
    // named `musicVolume` as bypassed too. The result was a shipped volume control that moved
    // 0.55 dB of score between its default and zero: turning the music off left 88% of it playing.
    // Fixing the half the comment described and leaving the half it also described is the whole
    // lesson; per-layer send amounts stay intact behind both nodes.
    this.sendTrim = ledger.keep(ctx.createGain());
    this.sendTrim.gain.value = 1;
    this.sendVolume = ledger.keep(ctx.createGain());
    this.sendVolume.gain.value = 1;
    this.sendTrim.connect(this.sendVolume);
    this.sendVolume.connect(send);

    const wet = (source: AudioNode, amount: number): void => {
      const g = keep(ctx.createGain());
      g.gain.value = amount;
      source.connect(g);
      g.connect(this.sendTrim);
    };

    // --- pad ---------------------------------------------------------------------------
    // Seven detuned voices behind one slowly opening lowpass. Each voice has its own drift
    // LFO at a different rate and phase, so the chord never settles into a single beat
    // frequency — it breathes like a cloud instead of pulsing like a chorus effect.
    this.padGate = keep(ctx.createGain());
    this.padGate.gain.value = 0.0001;
    this.padGate.connect(destination);
    wet(this.padGate, 0.42);

    const padFilter = keep(ctx.createBiquadFilter());
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 700;
    padFilter.Q.value = 1.4;
    padFilter.connect(this.padGate);

    const padSweep = createLfo(ctx, 0.021, 420, 0.4);
    ledger.keepAll(padSweep.nodes);
    padSweep.depth.connect(padFilter.frequency);
    this.startables.push(padSweep.osc);

    for (let i = 0; i < PAD_VOICES.length; i++) {
      const spec = PAD_VOICES[i];
      const osc = keep(ctx.createOscillator());
      osc.type = spec.type;
      osc.frequency.value = spec.freq;
      const level = keep(ctx.createGain());
      level.gain.value = spec.level;
      osc.connect(level);
      level.connect(padFilter);
      const drift = createLfo(ctx, spec.lfoHz, spec.lfoCents, spec.phase);
      ledger.keepAll(drift.nodes);
      drift.depth.connect(osc.detune);
      this.startables.push(osc, drift.osc);
    }

    // --- sub pulse ---------------------------------------------------------------------
    // One note, D1, pulsed once a bar. Below ~0.35 intensity it is gated out entirely: at low
    // stakes the score should have no pulse at all, only drift.
    this.subGate = keep(ctx.createGain());
    this.subGate.gain.value = 0.0001;
    this.subGate.connect(destination);

    this.subEnv = keep(ctx.createGain());
    this.subEnv.gain.value = 0.0001;
    this.subEnv.connect(this.subGate);

    const subLp = keep(ctx.createBiquadFilter());
    subLp.type = 'lowpass';
    subLp.frequency.value = 160;
    subLp.connect(this.subEnv);

    const subOsc = keep(ctx.createOscillator());
    subOsc.type = 'sine';
    subOsc.frequency.value = 36.71;
    const subHarm = keep(ctx.createOscillator());
    subHarm.type = 'triangle';
    subHarm.frequency.value = 73.42;
    const subHarmLevel = keep(ctx.createGain());
    subHarmLevel.gain.value = 0.22;
    subOsc.connect(subLp);
    subHarm.connect(subHarmLevel);
    subHarmLevel.connect(subLp);
    this.startables.push(subOsc, subHarm);

    // --- motif -------------------------------------------------------------------------
    this.motifGate = keep(ctx.createGain());
    this.motifGate.gain.value = 0.0001;
    this.motifGate.connect(destination);
    wet(this.motifGate, 0.7);

    // --- wind --------------------------------------------------------------------------
    // Not literal wind — there is no air out here. It is the noise floor of a hull under
    // load, and it is the layer that most directly tracks how fast the player is going.
    this.windGate = keep(ctx.createGain());
    this.windGate.gain.value = 0.0001;
    this.windGate.connect(destination);
    wet(this.windGate, 0.5);

    const windBp = keep(ctx.createBiquadFilter());
    windBp.type = 'bandpass';
    windBp.frequency.value = 460;
    windBp.Q.value = 0.85;
    windBp.connect(this.windGate);

    const windSweep = createLfo(ctx, 0.047, 260, 2.0);
    ledger.keepAll(windSweep.nodes);
    windSweep.depth.connect(windBp.frequency);
    this.startables.push(windSweep.osc);

    const windNoise = createNoiseSource(ctx, air, 0.53);
    keep(windNoise.source);
    this.noiseVoices.push(windNoise);
    windNoise.source.connect(windBp);
  }

  start(when: number): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.startables.length; i++) this.startables[i].start(when);
    for (let i = 0; i < this.noiseVoices.length; i++) startNoise(this.noiseVoices[i], when);
    this.nextPulse = when + 0.4;
    this.nextMotif = when + MOTIF_GRID;
    this.applyGates(when);
  }

  stop(when: number): void {
    if (!this.started) return;
    this.started = false;
    for (let i = 0; i < this.startables.length; i++) {
      try {
        this.startables[i].stop(when);
      } catch {
        /* already stopped */
      }
    }
    for (let i = 0; i < this.noiseVoices.length; i++) {
      try {
        this.noiseVoices[i].source.stop(when);
      } catch {
        /* already stopped */
      }
    }
  }

  setIntensity(value: number): void {
    this.intensity = clamp01(value);
    if (this.started) this.applyGates(this.ctx.currentTime);
  }

  /**
   * Lookahead scheduler. Called from the mix ticker; keeps the grid populated ~1.6 s ahead so
   * a throttled background timer cannot starve it.
   */
  tick(now: number): void {
    if (!this.started) return;

    // If the context was suspended the grid is far in the past — resynchronise rather than
    // firing hundreds of catch-up events.
    if (this.nextPulse < now - BAR) this.nextPulse = now + 0.1;
    if (this.nextMotif < now - MOTIF_GRID) this.nextMotif = now + 0.1;

    const horizon = now + LOOKAHEAD;
    while (this.nextPulse < horizon) {
      this.schedulePulse(this.nextPulse);
      this.nextPulse += BAR;
    }
    while (this.nextMotif < horizon) {
      this.maybeMotif(this.nextMotif);
      this.nextMotif += MOTIF_GRID;
    }
  }

  private applyGates(now: number): void {
    const i = this.intensity;
    // Multi-second time constants: every layer arrives as a swell, never as a cut.
    rampTo(this.padGate.gain, 0.16 + i * 0.14, 1.4, now);
    rampTo(this.subGate.gain, smoothstep(0.3, 0.46, i) * (0.4 + i * 0.35), 1.6, now);
    rampTo(this.motifGate.gain, smoothstep(0.55, 0.72, i) * 0.55, 1.8, now);
    rampTo(this.windGate.gain, 0.015 + i * i * 0.13, 1.2, now);
  }

  /** A slow swell rather than a kick: attack over a fifth of a bar, decay over the rest. */
  private schedulePulse(when: number): void {
    const g = this.subEnv.gain;
    g.setValueAtTime(0.0001, when);
    g.linearRampToValueAtTime(0.85, when + BAR * 0.18);
    g.exponentialRampToValueAtTime(0.0001, when + BAR * 0.92);
  }

  /**
   * Sparse bell motif. At most one note per 1.2 s grid step and never the same degree twice
   * in a row, so it reads as a signal from somewhere far off rather than as a melody.
   */
  private maybeMotif(when: number): void {
    if (this.intensity < 0.5) return;
    const chance = 0.14 + (this.intensity - 0.5) * 0.55;
    if (this.rng() > chance) return;

    let index = Math.floor(this.rng() * MOTIF_SCALE.length);
    if (index === this.lastMotifIndex) index = (index + 1) % MOTIF_SCALE.length;
    this.lastMotifIndex = index;
    const note = MOTIF_SCALE[index];

    const nodes: AudioNode[] = [];
    let end = when;
    for (let p = 0; p < BELL_RATIOS.length; p++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = note * BELL_RATIOS[p] * (1 + (this.rng() - 0.5) * 0.004);
      const gain = this.ctx.createGain();
      const decay = 3.4 * Math.pow(0.55, p);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.34 * Math.pow(0.42, p), when + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      osc.connect(gain);
      gain.connect(this.motifGate);
      osc.start(when);
      osc.stop(when + decay + 0.02);
      nodes.push(osc, gain);
      end = Math.max(end, when + decay + 0.02);
    }
    this.ledger.retire(nodes, end + 0.15);
  }
}
