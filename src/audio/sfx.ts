/**
 * One-shot event synthesis.
 *
 * Every sound in here is built from the same vocabulary as the world it lives in: cold metal,
 * pressurised gas, and the resonance of very large empty structures. Nothing is a raw
 * oscillator beep — each event stacks a transient, a body and a tail, because that three-part
 * shape is what makes a synthesised sound read as a physical object rather than a test tone.
 *
 * Each call builds a small private graph, hands it to the ledger with a retirement time, and
 * never touches it again. The ledger disconnects it once it has finished ringing, so firing a
 * thousand events leaves no residue.
 */

import type { SfxEvent } from '../core/contracts.ts';
import { clamp01, createSaturationCurve, type NodeLedger } from './nodes.ts';

export interface SfxKitOptions {
  ctx: BaseAudioContext;
  /** The sfx sub-bus. */
  destination: AudioNode;
  /** Shared reverb send. Each voice decides its own wetness. */
  send: AudioNode;
  ledger: NodeLedger;
  /** Pink noise: air, wind, distant pressure. */
  air: AudioBuffer;
  /** White noise: transients, sparks, squelch. */
  spark: AudioBuffer;
  rng: () => number;
}

interface Voice {
  bus: GainNode;
  nodes: AudioNode[];
  t: number;
  end: number;
}

interface ToneSpec {
  type?: OscillatorType;
  freq: number;
  /** Terminal frequency for a glide; omitted means a static pitch. */
  glideTo?: number;
  glideTime?: number;
  detune?: number;
  peak: number;
  attack?: number;
  decay: number;
  delay?: number;
  dest?: AudioNode;
}

interface NoiseSpec {
  colour?: 'air' | 'spark';
  filter?: BiquadFilterType;
  freq: number;
  freqTo?: number;
  sweepTime?: number;
  q?: number;
  peak: number;
  attack?: number;
  decay: number;
  delay?: number;
  dest?: AudioNode;
}

/** Inharmonic partial ratios of a struck metal ring — the backbone of every gate sound. */
const METAL_RATIOS = [1, 1.487, 2.031, 2.756, 3.923, 5.412];
/** Tubular-bell ratios: fewer, sweeter partials for the finish chord's top layer. */
const BELL_RATIOS = [1, 2.742, 5.404];

export class SfxKit {
  private readonly ctx: BaseAudioContext;
  private readonly destination: AudioNode;
  private readonly send: AudioNode;
  private readonly ledger: NodeLedger;
  private readonly air: AudioBuffer;
  private readonly spark: AudioBuffer;
  private readonly rng: () => number;
  private readonly grit: Float32Array<ArrayBuffer>;

  constructor(options: SfxKitOptions) {
    this.ctx = options.ctx;
    this.destination = options.destination;
    this.send = options.send;
    this.ledger = options.ledger;
    this.air = options.air;
    this.spark = options.spark;
    this.rng = options.rng;
    this.grit = createSaturationCurve(3.4, 1024);
  }

  /**
   * `intensity` is event-specific and documented per synth below; 0..1 unless noted.
   * `when` lets the caller schedule ahead of the audio clock.
   */
  play(event: SfxEvent, intensity: number, when: number): void {
    const i = clamp01(intensity);
    switch (event) {
      case 'gatePass':
        this.gatePass(i, when);
        break;
      case 'gateNear':
        this.gateNear(i, when);
        break;
      case 'gateMiss':
        this.gateMiss(i, when);
        break;
      case 'boostStart':
        this.boostStart(i, when);
        break;
      case 'boostEnd':
        this.boostEnd(i, when);
        break;
      case 'boostEmpty':
        this.boostEmpty(i, when);
        break;
      case 'countdownTick':
        this.countdownTick(i, when);
        break;
      case 'countdownGo':
        this.countdownGo(i, when);
        break;
      case 'finish':
        this.finish(i, when);
        break;
      case 'newBest':
        this.newBest(i, when);
        break;
      case 'impact':
        this.impact(i, when);
        break;
      case 'scrape':
        this.scrape(i, when);
        break;
      case 'warnProximity':
        this.warnProximity(i, when);
        break;
      case 'uiHover':
        this.uiHover(when);
        break;
      case 'uiClick':
        this.uiClick(when);
        break;
      case 'uiBack':
        this.uiBack(when);
        break;
      case 'radio':
        this.radio(i, when);
        break;
    }
  }

  // -------------------------------------------------------------------------------------
  // voice plumbing
  // -------------------------------------------------------------------------------------

  private begin(when: number, level: number, wet: number): Voice {
    const bus = this.ctx.createGain();
    bus.gain.value = level;
    bus.connect(this.destination);
    const nodes: AudioNode[] = [bus];
    if (wet > 0) {
      const sendGain = this.ctx.createGain();
      sendGain.gain.value = wet;
      bus.connect(sendGain);
      sendGain.connect(this.send);
      nodes.push(sendGain);
    }
    return { bus, nodes, t: when, end: when };
  }

  private finishVoice(v: Voice): void {
    // +0.15 s of slack so the last exponential tail is fully below audibility before the
    // graph is torn down; disconnecting mid-ring is an audible click.
    this.ledger.retire(v.nodes, v.end + 0.15);
  }

  private tone(v: Voice, spec: ToneSpec): void {
    const t = v.t + (spec.delay ?? 0);
    const attack = spec.attack ?? 0.004;
    const osc = this.ctx.createOscillator();
    osc.type = spec.type ?? 'sine';
    if (spec.detune) osc.detune.value = spec.detune;
    osc.frequency.setValueAtTime(Math.max(spec.freq, 0.01), t);
    if (spec.glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(spec.glideTo, 0.01),
        t + Math.max(spec.glideTime ?? 0.1, 0.005),
      );
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(Math.max(spec.peak, 0.0002), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + spec.decay);
    osc.connect(gain);
    gain.connect(spec.dest ?? v.bus);
    const stop = t + attack + spec.decay + 0.02;
    osc.start(t);
    osc.stop(stop);
    v.nodes.push(osc, gain);
    if (stop > v.end) v.end = stop;
  }

  private noise(v: Voice, spec: NoiseSpec): void {
    const t = v.t + (spec.delay ?? 0);
    const attack = spec.attack ?? 0.003;
    const buffer = spec.colour === 'spark' ? this.spark : this.air;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = spec.filter ?? 'bandpass';
    filter.Q.value = spec.q ?? 1;
    filter.frequency.setValueAtTime(Math.max(spec.freq, 10), t);
    if (spec.freqTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(spec.freqTo, 10),
        t + Math.max(spec.sweepTime ?? spec.decay, 0.01),
      );
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(Math.max(spec.peak, 0.0002), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + spec.decay);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(spec.dest ?? v.bus);
    const stop = t + attack + spec.decay + 0.02;
    src.start(t, this.rng() * (buffer.duration - 0.5));
    src.stop(stop);
    v.nodes.push(src, filter, gain);
    if (stop > v.end) v.end = stop;
  }

  /** ±`cents` of deterministic-ish jitter so repeated hits never land identically. */
  private jitter(cents: number): number {
    return Math.pow(2, ((this.rng() * 2 - 1) * cents) / 1200);
  }

  // -------------------------------------------------------------------------------------
  // gates
  // -------------------------------------------------------------------------------------

  /**
   * The payoff sound of the whole game: a struck monolith.
   *
   * A dense inharmonic bloom whose partials all glide down about a minor third in the first
   * 120 ms — that fast drop is what reads as "the marker just went past me at speed". Upper
   * partials decay faster than lower ones, which is how real struck metal behaves and what
   * gives the tail its long, hollow ring.
   *
   * `intensity` = streak heat: higher means brighter and a semitone or two up, so nine gates
   * in a row form a rising line instead of nine identical clangs.
   */
  private gatePass(intensity: number, when: number): void {
    const v = this.begin(when, 0.5, 0.55);
    const root = 462 * Math.pow(2, intensity * 0.62) * this.jitter(40);
    const drop = 1.24 + this.rng() * 0.12;
    const bright = 0.55 + intensity * 0.45;

    for (let p = 0; p < METAL_RATIOS.length; p++) {
      const ratio = METAL_RATIOS[p] * this.jitter(14);
      const freq = root * ratio;
      if (freq > 15000) continue;
      // Higher partials are quieter and shorter: the ring collapses onto the fundamental.
      const fall = Math.pow(0.62, p);
      this.tone(v, {
        type: p === 0 ? 'triangle' : 'sine',
        freq: freq * drop,
        glideTo: freq,
        glideTime: 0.1 + p * 0.012,
        peak: (0.3 * fall) * (p >= 3 ? bright : 1),
        attack: 0.004 + p * 0.002,
        decay: 2.4 * Math.pow(0.72, p) + 0.25,
      });
    }

    // The strike itself — a bright scrape of contact that lasts a fifth of a second.
    this.noise(v, {
      colour: 'spark',
      filter: 'highpass',
      freq: 2600 + intensity * 2600,
      peak: 0.16 + intensity * 0.12,
      attack: 0.002,
      decay: 0.26,
    });
    // Sub whoomp: the mass of the structure you just threaded.
    this.tone(v, {
      type: 'sine',
      freq: root * 0.26,
      glideTo: root * 0.17,
      glideTime: 0.3,
      peak: 0.34,
      attack: 0.01,
      decay: 0.75,
    });
    this.finishVoice(v);
  }

  /**
   * Proximity tick. Deliberately tiny — it fires repeatedly on approach, so it has to sit
   * under the drive. `intensity` = closeness: the tick shortens and rises as the gate fills
   * the canopy, which reads as the interval tightening even at a constant repeat rate.
   */
  private gateNear(intensity: number, when: number): void {
    const v = this.begin(when, 0.3, 0.18);
    const freq = 1180 + intensity * 1250;
    this.tone(v, {
      type: 'sine',
      freq,
      peak: 0.24 + intensity * 0.2,
      attack: 0.001,
      decay: 0.075 - intensity * 0.045,
    });
    this.noise(v, {
      colour: 'spark',
      filter: 'bandpass',
      freq: freq * 1.6,
      q: 7,
      peak: 0.18,
      attack: 0.001,
      decay: 0.045,
    });
    this.finishVoice(v);
  }

  /**
   * A miss is the absence of the bloom: same mass, none of the brightness. Two low tones a
   * few cents apart beat against each other while everything smears downward — the sound of
   * something heavy passing on the wrong side of you.
   */
  private gateMiss(intensity: number, when: number): void {
    const v = this.begin(when, 0.46, 0.34);
    const base = 104 * this.jitter(30);
    this.tone(v, { type: 'sine', freq: base, glideTo: base * 0.55, glideTime: 0.55, peak: 0.32, attack: 0.008, decay: 0.9 });
    this.tone(v, { type: 'sine', freq: base * 1.021, glideTo: base * 0.56, glideTime: 0.55, peak: 0.22, attack: 0.012, decay: 0.9 });
    this.tone(v, {
      type: 'sawtooth',
      freq: base * 3.1,
      glideTo: base * 1.05,
      glideTime: 0.65,
      peak: 0.17 + intensity * 0.1,
      attack: 0.02,
      decay: 0.75,
    });
    this.noise(v, {
      colour: 'air',
      filter: 'lowpass',
      freq: 900,
      freqTo: 190,
      sweepTime: 0.6,
      q: 1.1,
      peak: 0.32,
      attack: 0.006,
      decay: 0.8,
    });
    this.finishVoice(v);
  }

  // -------------------------------------------------------------------------------------
  // boost
  // -------------------------------------------------------------------------------------

  /** Pressure dumping into the ducts: a rising bandpass sweep over a rising sub. */
  private boostStart(intensity: number, when: number): void {
    const v = this.begin(when, 0.5, 0.22);
    this.noise(v, {
      colour: 'air',
      filter: 'bandpass',
      freq: 280,
      freqTo: 4200,
      sweepTime: 0.34,
      q: 1.2,
      peak: 0.62 + intensity * 0.22,
      attack: 0.012,
      decay: 0.55,
    });
    this.tone(v, { type: 'sine', freq: 62, glideTo: 138, glideTime: 0.32, peak: 0.28, attack: 0.02, decay: 0.6 });
    this.tone(v, { type: 'sawtooth', freq: 180, glideTo: 420, glideTime: 0.3, peak: 0.17, attack: 0.02, decay: 0.45 });
    this.noise(v, { colour: 'spark', filter: 'highpass', freq: 5200, peak: 0.13, attack: 0.001, decay: 0.14 });
    this.finishVoice(v);
  }

  /** The mirror image: the ducts closing, energy draining downward. */
  private boostEnd(intensity: number, when: number): void {
    const v = this.begin(when, 0.63, 0.28);
    this.noise(v, {
      colour: 'air',
      filter: 'bandpass',
      freq: 3000,
      freqTo: 340,
      sweepTime: 0.6,
      q: 1.5,
      peak: 0.32 + intensity * 0.1,
      attack: 0.02,
      decay: 0.72,
    });
    this.tone(v, { type: 'sine', freq: 126, glideTo: 58, glideTime: 0.5, peak: 0.3, attack: 0.02, decay: 0.6 });
    this.finishVoice(v);
  }

  /** Dry, mechanical, unsatisfying on purpose: three failed ignition ticks and a sag. */
  private boostEmpty(_intensity: number, when: number): void {
    const v = this.begin(when, 0.6, 0.1);
    for (let k = 0; k < 3; k++) {
      this.noise(v, {
        colour: 'spark',
        filter: 'bandpass',
        freq: 780 - k * 90,
        q: 5,
        peak: 0.3 - k * 0.06,
        attack: 0.001,
        decay: 0.05,
        delay: k * 0.058,
      });
    }
    this.tone(v, {
      type: 'triangle',
      freq: 214,
      glideTo: 88,
      glideTime: 0.26,
      peak: 0.2,
      attack: 0.008,
      decay: 0.32,
      delay: 0.02,
    });
    this.finishVoice(v);
  }

  // -------------------------------------------------------------------------------------
  // countdown / resolution
  // -------------------------------------------------------------------------------------

  /**
   * Cold instrument pip, not a beep: a sine with a single inharmonic partial and a hard,
   * short envelope. Dry, so it sits in front of the pad instead of blooming into the room.
   */
  private countdownTick(intensity: number, when: number): void {
    const v = this.begin(when, 0.75, 0.12);
    const base = 784 * (1 + intensity * 0.16);
    this.tone(v, { type: 'sine', freq: base, peak: 0.42, attack: 0.002, decay: 0.16 });
    this.tone(v, { type: 'sine', freq: base * 2.756, peak: 0.1, attack: 0.002, decay: 0.09 });
    this.noise(v, { colour: 'spark', filter: 'bandpass', freq: base * 3.4, q: 9, peak: 0.1, attack: 0.001, decay: 0.03 });
    this.finishVoice(v);
  }

  /**
   * Launch. A sub swell rising underneath an open-fifth stack that sweeps its filter up, plus
   * a long air rush — the three ingredients of "something very large just released you".
   */
  private countdownGo(_intensity: number, when: number): void {
    const v = this.begin(when, 0.55, 0.4);

    const lift = this.ctx.createBiquadFilter();
    lift.type = 'lowpass';
    lift.Q.value = 3.2;
    lift.frequency.setValueAtTime(260, when);
    lift.frequency.exponentialRampToValueAtTime(4600, when + 0.55);
    lift.frequency.exponentialRampToValueAtTime(1200, when + 1.6);
    lift.connect(v.bus);
    v.nodes.push(lift);

    // D2 / A2 / D3 / A3 — an open fifth stack has no third, so it reads as launch clearance
    // rather than as a resolved musical cadence. The resolution is saved for `finish`.
    const stack = [73.42, 110.0, 146.83, 220.0];
    for (let k = 0; k < stack.length; k++) {
      this.tone(v, {
        type: k < 2 ? 'sawtooth' : 'triangle',
        freq: stack[k] * 0.94,
        glideTo: stack[k],
        glideTime: 0.4,
        peak: 0.3 * Math.pow(0.82, k),
        attack: 0.06,
        decay: 1.7,
        dest: lift,
      });
    }
    this.tone(v, { type: 'sine', freq: 36.7, glideTo: 73.4, glideTime: 0.5, peak: 0.34, attack: 0.08, decay: 1.5 });
    this.noise(v, {
      colour: 'air',
      filter: 'bandpass',
      freq: 340,
      freqTo: 5200,
      sweepTime: 0.7,
      q: 0.9,
      peak: 0.3,
      attack: 0.09,
      decay: 1.1,
    });
    this.finishVoice(v);
  }

  /**
   * Arrival at VESPER TERMINUS. Dm(add9) — the tonal centre the score has been circling for
   * the whole run, finally stated in full and allowed to bloom into the reverb.
   */
  private finish(_intensity: number, when: number): void {
    const v = this.begin(when, 0.44, 0.8);
    const chord = [73.42, 146.83, 220.0, 261.63, 329.63, 440.0];
    for (let k = 0; k < chord.length; k++) {
      this.tone(v, {
        type: k < 2 ? 'sine' : 'triangle',
        freq: chord[k],
        detune: (k % 2 === 0 ? -4 : 5),
        peak: 0.26 * Math.pow(0.86, k),
        attack: 0.09 + k * 0.035,
        decay: 3.6 - k * 0.22,
      });
    }
    this.tone(v, { type: 'sine', freq: 36.71, peak: 0.42, attack: 0.14, decay: 3.0 });
    this.noise(v, { colour: 'air', filter: 'highpass', freq: 3400, peak: 0.09, attack: 0.25, decay: 2.2 });
    this.finishVoice(v);
  }

  /** Layered over `finish`: bell partials two octaves up, so a record reads as light. */
  private newBest(_intensity: number, when: number): void {
    const v = this.begin(when, 0.71, 0.85);
    const notes = [587.33, 880.0, 1174.66];
    for (let n = 0; n < notes.length; n++) {
      for (let p = 0; p < BELL_RATIOS.length; p++) {
        const freq = notes[n] * BELL_RATIOS[p] * this.jitter(10);
        if (freq > 16000) continue;
        this.tone(v, {
          type: 'sine',
          freq,
          peak: 0.14 * Math.pow(0.5, p) * Math.pow(0.82, n),
          attack: 0.005,
          decay: 2.6 * Math.pow(0.66, p),
          delay: n * 0.16,
        });
      }
    }
    this.noise(v, { colour: 'spark', filter: 'highpass', freq: 6000, peak: 0.09, attack: 0.02, decay: 1.1 });
    this.finishVoice(v);
  }

  // -------------------------------------------------------------------------------------
  // contact
  // -------------------------------------------------------------------------------------

  /**
   * Hull strike. Three simultaneous events, which is what a real impact is: a click of
   * contact, a resonant ring of the panel that was hit, and a low thud of the whole hull
   * accepting the momentum. `intensity` = strike energy.
   */
  private impact(intensity: number, when: number): void {
    const v = this.begin(when, 0.7, 0.3);
    const energy = 0.35 + intensity * 0.65;
    const ring = 214 * this.jitter(90) * (1 - intensity * 0.22);

    this.noise(v, { colour: 'spark', filter: 'highpass', freq: 3800, peak: 0.28 * energy, attack: 0.0008, decay: 0.035 });
    this.noise(v, {
      colour: 'spark',
      filter: 'bandpass',
      freq: ring * 4.1,
      q: 8.5,
      peak: 0.42 * energy,
      attack: 0.001,
      decay: 0.24 + intensity * 0.2,
    });
    this.tone(v, { type: 'sine', freq: ring, glideTo: ring * 0.55, glideTime: 0.16, peak: 0.6 * energy, attack: 0.002, decay: 0.3 });
    this.tone(v, {
      type: 'triangle',
      freq: ring * 2.44,
      peak: 0.16 * energy,
      attack: 0.002,
      decay: 0.5 + intensity * 0.4,
    });
    this.finishVoice(v);
  }

  /**
   * Sustained contact. A narrow bandpass whose centre is thrown around by a second, heavily
   * lowpassed noise stream — that random resonance is the grain of metal dragging on rock.
   * `intensity` = contact pressure.
   */
  private scrape(intensity: number, when: number): void {
    const v = this.begin(when, 0.56, 0.24);
    const dur = 0.34 + intensity * 0.42;

    const src = this.ctx.createBufferSource();
    src.buffer = this.spark;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500 + intensity * 900;
    bp.Q.value = 11;
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this.grit;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(0.34 + intensity * 0.24, when + 0.03);
    gain.gain.setTargetAtTime(0.0001, when + dur * 0.55, dur * 0.22);

    // The rattle: lowpassed noise sweeping the resonant peak up and down at audio-rate-adjacent
    // speed, which the ear hears as grain rather than as pitch.
    const rat = this.ctx.createBufferSource();
    rat.buffer = this.air;
    rat.loop = true;
    const ratLp = this.ctx.createBiquadFilter();
    ratLp.type = 'lowpass';
    ratLp.frequency.value = 42;
    const ratDepth = this.ctx.createGain();
    ratDepth.gain.value = 1500 + intensity * 1200;
    rat.connect(ratLp);
    ratLp.connect(ratDepth);
    ratDepth.connect(bp.frequency);

    src.connect(bp);
    bp.connect(shaper);
    shaper.connect(gain);
    gain.connect(v.bus);

    const stop = when + dur + 0.3;
    src.start(when, this.rng() * 1.5);
    src.stop(stop);
    rat.start(when, this.rng() * 1.5);
    rat.stop(stop);
    v.nodes.push(src, bp, shaper, gain, rat, ratLp, ratDepth);
    v.end = stop;

    this.tone(v, { type: 'triangle', freq: 128, peak: 0.14 + intensity * 0.1, attack: 0.02, decay: dur });
    this.finishVoice(v);
  }

  /**
   * Collision alert. Two short pulses of a filtered triangle, an octave apart in urgency but
   * never above ~1.3 kHz — the alarm has to be readable while the drive is at full throttle
   * without becoming the shrill piezo beep of a smoke detector.
   */
  private warnProximity(intensity: number, when: number): void {
    const v = this.begin(when, 0.45, 0.14);
    const base = 470 + intensity * 150;
    for (let k = 0; k < 2; k++) {
      const t = k * (0.16 - intensity * 0.05);
      this.tone(v, { type: 'triangle', freq: base, peak: 0.36, attack: 0.006, decay: 0.1, delay: t });
      this.tone(v, { type: 'sine', freq: base * 1.5, peak: 0.16, attack: 0.006, decay: 0.08, delay: t });
      this.tone(v, { type: 'sine', freq: base * 0.5, peak: 0.22, attack: 0.008, decay: 0.13, delay: t });
    }
    this.finishVoice(v);
  }

  // -------------------------------------------------------------------------------------
  // interface
  // -------------------------------------------------------------------------------------

  /** Barely there: a single high sine, 30 ms, so hovering a list is texture and not events. */
  private uiHover(when: number): void {
    const v = this.begin(when, 0.22, 0.1);
    this.tone(v, { type: 'sine', freq: 2320, peak: 0.3, attack: 0.001, decay: 0.03 });
    this.tone(v, { type: 'sine', freq: 3480, peak: 0.1, attack: 0.001, decay: 0.02 });
    this.finishVoice(v);
  }

  /** Confirmation: same glass, plus a contact tick and a fifth below to give it a floor. */
  private uiClick(when: number): void {
    const v = this.begin(when, 0.33, 0.14);
    this.tone(v, { type: 'sine', freq: 1560, peak: 0.36, attack: 0.001, decay: 0.055 });
    this.tone(v, { type: 'sine', freq: 1040, peak: 0.18, attack: 0.001, decay: 0.09 });
    this.noise(v, { colour: 'spark', filter: 'bandpass', freq: 4200, q: 6, peak: 0.14, attack: 0.0008, decay: 0.022 });
    this.finishVoice(v);
  }

  /** Cancel reads as a descent: the same glass falling a fourth. */
  private uiBack(when: number): void {
    const v = this.begin(when, 0.3, 0.14);
    this.tone(v, { type: 'sine', freq: 1180, glideTo: 790, glideTime: 0.07, peak: 0.32, attack: 0.001, decay: 0.09 });
    this.tone(v, { type: 'sine', freq: 590, glideTo: 395, glideTime: 0.07, peak: 0.14, attack: 0.002, decay: 0.11 });
    this.finishVoice(v);
  }

  /**
   * Comms blip. A buzzy larynx-like source pushed through two moving formants and hard
   * band-limited to 300–3400 Hz — the exact bandwidth of a voice channel, which is why this
   * reads as "someone said something" without a single word being synthesised. Squelch noise
   * tops and tails it, the way a carrier opening and closing actually sounds.
   */
  private radio(intensity: number, when: number): void {
    const v = this.begin(when, 0.54, 0.16);
    const dur = 0.26 + intensity * 0.34;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.9;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 0.9;
    const drive = this.ctx.createWaveShaper();
    drive.curve = this.grit;
    hp.connect(lp);
    lp.connect(drive);
    drive.connect(v.bus);
    v.nodes.push(hp, lp, drive);

    const larynx = this.ctx.createOscillator();
    larynx.type = 'sawtooth';
    larynx.frequency.setValueAtTime(126, when);
    larynx.frequency.linearRampToValueAtTime(112, when + dur);
    const level = this.ctx.createGain();
    level.gain.setValueAtTime(0.0001, when);
    level.gain.linearRampToValueAtTime(0.5, when + 0.03);
    // Syllabic bumps: the amplitude wobble is what makes it read as speech, not as a buzzer.
    level.gain.setValueAtTime(0.22, when + dur * 0.32);
    level.gain.linearRampToValueAtTime(0.46, when + dur * 0.45);
    level.gain.setTargetAtTime(0.0001, when + dur * 0.8, 0.05);
    larynx.connect(level);

    for (let f = 0; f < 2; f++) {
      const formant = this.ctx.createBiquadFilter();
      formant.type = 'bandpass';
      formant.Q.value = 4.5;
      const start = f === 0 ? 620 : 1420;
      const mid = f === 0 ? 840 : 1080;
      formant.frequency.setValueAtTime(start, when);
      formant.frequency.linearRampToValueAtTime(mid, when + dur * 0.5);
      formant.frequency.linearRampToValueAtTime(start * 0.9, when + dur);
      level.connect(formant);
      formant.connect(hp);
      v.nodes.push(formant);
    }
    v.nodes.push(larynx, level);
    larynx.start(when);
    larynx.stop(when + dur + 0.15);
    v.end = when + dur + 0.15;

    this.noise(v, { colour: 'spark', filter: 'bandpass', freq: 2000, q: 1.2, peak: 0.14, attack: 0.002, decay: 0.05, dest: hp });
    this.noise(v, {
      colour: 'spark',
      filter: 'bandpass',
      freq: 2400,
      q: 1.2,
      peak: 0.12,
      attack: 0.002,
      decay: 0.07,
      delay: dur,
      dest: hp,
    });
    this.finishVoice(v);
  }
}
