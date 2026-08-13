/**
 * The KESTREL-C7 drive.
 *
 * This is the sound the player hears for the entire run, so it is built as four physically
 * motivated layers rather than one oscillator:
 *
 *   sub/body      the mass of the ship — what you feel in your chest, not what you hear
 *   turbine       compressed gas moving through a resonant duct
 *   ion whine     the high, unstable electrical partial that says "this is not a jet"
 *   thrusters     short attitude-jet chuffs that make lateral slip feel physical
 *
 * Every per-frame parameter move goes through `setTargetAtTime`; nothing assigns `.value`
 * during flight, because that stair-steps audibly at 60 Hz. In steady state `update()`
 * allocates nothing — it only writes numbers into existing AudioParams.
 */

import type { EngineAudioState } from '../core/contracts.ts';
import {
  clamp01,
  createComb,
  createLfo,
  createNoiseSource,
  createSaturationCurve,
  rampTo,
  startNoise,
  type NodeLedger,
} from './nodes.ts';

export interface EngineLayerOptions {
  ctx: BaseAudioContext;
  destination: AudioNode;
  /** Reverb send bus. The drive is only lightly wetted: it is attached to the listener. */
  send: AudioNode;
  ledger: NodeLedger;
  noise: AudioBuffer;
}

/** Parameters are re-targeted at ~30 Hz. Smoothing makes the extra frames inaudible. */
const UPDATE_PERIOD = 1 / 30;

export class EngineLayer {
  private readonly ctx: BaseAudioContext;
  private readonly ledger: NodeLedger;
  private readonly noiseBuffer: AudioBuffer;
  private readonly sfxDestination: AudioNode;

  private readonly out: GainNode;

  // sub / body
  private readonly subOsc: OscillatorNode;
  private readonly bodyOsc: OscillatorNode;
  private readonly octaveOsc: OscillatorNode;
  private readonly octaveGain: GainNode;
  private readonly bodyGain: GainNode;
  private readonly subFilter: BiquadFilterNode;
  private readonly subGain: GainNode;

  // turbine
  private readonly turbineBp: BiquadFilterNode;
  private readonly turbineHp: BiquadFilterNode;
  private readonly turbineGain: GainNode;
  private readonly combDelay: AudioParam;
  private readonly combFeedback: AudioParam;

  // ion whine
  private readonly ionA: OscillatorNode;
  private readonly ionB: OscillatorNode;
  private readonly ionFilter: BiquadFilterNode;
  private readonly ionGain: GainNode;

  // manoeuvring thrusters
  private readonly thrusterBp: BiquadFilterNode;
  private readonly thrusterGain: GainNode;
  private readonly thrusterMod: GainNode;

  private readonly startables: OscillatorNode[] = [];
  private readonly noiseVoices: ReturnType<typeof createNoiseSource>[] = [];

  private accum = 0;
  private started = false;
  private boosting = false;
  private boostBlend = 0;

  constructor(options: EngineLayerOptions) {
    const { ctx, destination, send, ledger, noise } = options;
    this.ctx = ctx;
    this.ledger = ledger;
    this.noiseBuffer = noise;
    this.sfxDestination = destination;

    const keep = <T extends AudioNode>(node: T): T => ledger.keep(node);

    this.out = keep(ctx.createGain());
    this.out.gain.value = 0.0001;
    this.out.connect(destination);

    const sendGain = keep(ctx.createGain());
    sendGain.gain.value = 0.075;
    this.out.connect(sendGain);
    sendGain.connect(send);

    // --- sub / body -------------------------------------------------------------------
    // A pure sine carries the weight; a saturated triangle an octave up supplies the odd
    // harmonics that survive on laptop speakers, where the sine itself is inaudible.
    this.subFilter = keep(ctx.createBiquadFilter());
    this.subFilter.type = 'lowpass';
    this.subFilter.frequency.value = 320;
    this.subFilter.Q.value = 0.8;

    this.subGain = keep(ctx.createGain());
    this.subGain.gain.value = 0.0001;
    this.subFilter.connect(this.subGain);
    this.subGain.connect(this.out);

    this.subOsc = keep(ctx.createOscillator());
    this.subOsc.type = 'sine';
    this.subOsc.frequency.value = 40;
    const subLevel = keep(ctx.createGain());
    subLevel.gain.value = 0.85;
    this.subOsc.connect(subLevel);
    subLevel.connect(this.subFilter);
    this.startables.push(this.subOsc);

    const shaper = keep(ctx.createWaveShaper());
    shaper.curve = createSaturationCurve(2.6);
    shaper.oversample = '2x';
    this.bodyOsc = keep(ctx.createOscillator());
    this.bodyOsc.type = 'triangle';
    this.bodyOsc.frequency.value = 80;
    this.bodyGain = keep(ctx.createGain());
    this.bodyGain.gain.value = 0.34;
    this.bodyOsc.connect(this.bodyGain);
    this.bodyGain.connect(shaper);
    shaper.connect(this.subFilter);
    this.startables.push(this.bodyOsc);

    // Engaged only while boosting: an extra octave down that makes the ship feel like it
    // just got twice as heavy.
    this.octaveOsc = keep(ctx.createOscillator());
    this.octaveOsc.type = 'sine';
    this.octaveOsc.frequency.value = 20;
    this.octaveGain = keep(ctx.createGain());
    this.octaveGain.gain.value = 0.0001;
    this.octaveOsc.connect(this.octaveGain);
    this.octaveGain.connect(this.subFilter);
    this.startables.push(this.octaveOsc);

    // --- turbine ----------------------------------------------------------------------
    // Bandpassed noise through a damped comb. The comb's fixed resonant peaks are what turn
    // "hiss" into "gas under pressure in a metal duct".
    const turbineNoise = createNoiseSource(ctx, noise, 0.0);
    keep(turbineNoise.source);
    this.noiseVoices.push(turbineNoise);

    this.turbineBp = keep(ctx.createBiquadFilter());
    this.turbineBp.type = 'bandpass';
    this.turbineBp.frequency.value = 420;
    this.turbineBp.Q.value = 1.6;

    const comb = createComb(ctx, 0.0052, 0.55, 3600);
    ledger.keepAll(comb.nodes);
    this.combDelay = comb.delay.delayTime;
    this.combFeedback = comb.feedback.gain;

    // A very slow sweep of the comb length flanges the duct so it never sounds like a loop.
    const flange = createLfo(ctx, 0.063, 0.00042, 0.0);
    ledger.keepAll(flange.nodes);
    flange.depth.connect(this.combDelay);
    this.startables.push(flange.osc);

    this.turbineHp = keep(ctx.createBiquadFilter());
    this.turbineHp.type = 'highpass';
    this.turbineHp.frequency.value = 180;
    this.turbineHp.Q.value = 0.6;

    this.turbineGain = keep(ctx.createGain());
    this.turbineGain.gain.value = 0.0001;

    turbineNoise.source.connect(this.turbineBp);
    this.turbineBp.connect(comb.input);
    comb.output.connect(this.turbineHp);
    this.turbineHp.connect(this.turbineGain);
    this.turbineGain.connect(this.out);

    // --- ion whine --------------------------------------------------------------------
    // Two saws a couple of octaves above the fundamental, deliberately mistuned and slowly
    // drifting. The beating keeps the drive alive at constant throttle, where a static tone
    // would read as a synthesiser pad.
    this.ionFilter = keep(ctx.createBiquadFilter());
    this.ionFilter.type = 'highpass';
    this.ionFilter.frequency.value = 420;
    this.ionFilter.Q.value = 0.7;

    this.ionGain = keep(ctx.createGain());
    this.ionGain.gain.value = 0.0001;
    this.ionFilter.connect(this.ionGain);
    this.ionGain.connect(this.out);

    this.ionA = keep(ctx.createOscillator());
    this.ionA.type = 'sawtooth';
    this.ionA.frequency.value = 360;
    this.ionA.detune.value = -6;
    const ionAGain = keep(ctx.createGain());
    ionAGain.gain.value = 0.5;
    this.ionA.connect(ionAGain);
    ionAGain.connect(this.ionFilter);
    this.startables.push(this.ionA);

    this.ionB = keep(ctx.createOscillator());
    this.ionB.type = 'sawtooth';
    this.ionB.frequency.value = 360;
    this.ionB.detune.value = 9;
    const ionBGain = keep(ctx.createGain());
    ionBGain.gain.value = 0.5;
    this.ionB.connect(ionBGain);
    ionBGain.connect(this.ionFilter);
    this.startables.push(this.ionB);

    const ionDrift = createLfo(ctx, 0.107, 11, Math.PI * 0.5);
    ledger.keepAll(ionDrift.nodes);
    ionDrift.depth.connect(this.ionB.detune);
    this.startables.push(ionDrift.osc);

    // --- manoeuvring thrusters --------------------------------------------------------
    // Keyed to lateral slip. Rather than firing scheduled one-shots (which would allocate
    // every frame), a continuous bandpassed noise layer is amplitude-modulated by a heavily
    // lowpassed second noise stream. The result is irregular chuffing, not a steady hiss.
    const thrusterNoise = createNoiseSource(ctx, noise, 0.37);
    keep(thrusterNoise.source);
    this.noiseVoices.push(thrusterNoise);

    this.thrusterBp = keep(ctx.createBiquadFilter());
    this.thrusterBp.type = 'bandpass';
    this.thrusterBp.frequency.value = 900;
    this.thrusterBp.Q.value = 1.1;

    this.thrusterGain = keep(ctx.createGain());
    this.thrusterGain.gain.value = 0;

    thrusterNoise.source.connect(this.thrusterBp);
    this.thrusterBp.connect(this.thrusterGain);
    this.thrusterGain.connect(this.out);

    const modNoise = createNoiseSource(ctx, noise, 0.71);
    keep(modNoise.source);
    this.noiseVoices.push(modNoise);
    const modLp = keep(ctx.createBiquadFilter());
    modLp.type = 'lowpass';
    modLp.frequency.value = 7.5;
    modLp.Q.value = 0.9;
    const modMakeup = keep(ctx.createGain());
    modMakeup.gain.value = 70;
    this.thrusterMod = keep(ctx.createGain());
    this.thrusterMod.gain.value = 0;
    modNoise.source.connect(modLp);
    modLp.connect(modMakeup);
    modMakeup.connect(this.thrusterMod);
    this.thrusterMod.connect(this.thrusterGain.gain);
  }

  start(when: number): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.startables.length; i++) this.startables[i].start(when);
    for (let i = 0; i < this.noiseVoices.length; i++) startNoise(this.noiseVoices[i], when);
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

  /** Allocation-free in steady state. Only the boost transition creates nodes. */
  update(dt: number, state: EngineAudioState): void {
    const now = this.ctx.currentTime;

    if (state.boosting !== this.boosting) {
      this.boosting = state.boosting;
      if (state.boosting) this.chuff(now);
    }

    this.accum += dt;
    if (this.accum < UPDATE_PERIOD) return;
    const step = this.accum;
    this.accum = 0;

    // Boost opens fast and closes slowly: the release is the descending filter tail, produced
    // by sweeping every parameter back down over ~0.9 s rather than by a separate automation
    // curve that would fight the per-frame smoothing.
    const target = this.boosting ? 1 : 0;
    const tau = this.boosting ? 0.07 : 0.3;
    this.boostBlend += (target - this.boostBlend) * (1 - Math.exp(-step / tau));
    if (Math.abs(this.boostBlend - target) < 0.0015) this.boostBlend = target;

    const throttle = clamp01(state.throttle);
    const speed = clamp01(state.speed01);
    const slip = clamp01(state.slip);
    const boost = this.boostBlend;

    // Fundamental slides with speed rather than throttle so coasting at high velocity still
    // sounds fast — the drive is loaded by the ship's momentum, not only by the pilot's hand.
    const f0 = 38 + speed * 58 + throttle * 14 + boost * 9;

    rampTo(this.subOsc.frequency, f0, 0.13, now);
    rampTo(this.bodyOsc.frequency, f0 * 2, 0.13, now);
    rampTo(this.octaveOsc.frequency, f0 * 0.5, 0.13, now);
    rampTo(this.octaveGain.gain, boost * 0.28, 0.22, now);
    rampTo(this.bodyGain.gain, 0.5 + throttle * 0.32 + boost * 0.24, 0.15, now);
    // The body filter opens with thrust, so the odd harmonics that carry the drive on small
    // speakers arrive with the throttle rather than being permanently buried under the sine.
    rampTo(this.subFilter.frequency, 320 + throttle * 540 + boost * 1300, 0.18, now);
    rampTo(this.subGain.gain, 0.1 + throttle * 0.12 + speed * 0.06, 0.16, now);

    // Turbine centre frequency tracks commanded thrust most strongly: the pilot should hear
    // the response to the stick before the ship has actually accelerated.
    const turbineHz = 380 + throttle * 1500 + speed * 1150 + boost * 1500;
    rampTo(this.turbineBp.frequency, turbineHz, 0.09, now);
    // A narrow band passes very little noise power, so Q stays moderate and boost opens it
    // right out — the "filter sweeps wide" gesture is a Q drop as much as a frequency rise.
    rampTo(this.turbineBp.Q, 1.2 + throttle * 2.6 - boost * 1.7, 0.12, now);
    rampTo(this.turbineHp.frequency, 150 + speed * 260, 0.12, now);
    rampTo(this.turbineGain.gain, 0.2 + throttle * 0.6 + speed * 0.32 + boost * 0.44, 0.1, now);
    rampTo(this.combDelay, 0.0052 - speed * 0.0026, 0.14, now);
    rampTo(this.combFeedback, 0.46 + throttle * 0.16 + boost * 0.1, 0.14, now);

    const ionHz = f0 * 9;
    rampTo(this.ionA.frequency, ionHz, 0.11, now);
    rampTo(this.ionB.frequency, ionHz * 1.006, 0.11, now);
    rampTo(this.ionFilter.frequency, 360 + speed * 420, 0.14, now);
    rampTo(this.ionGain.gain, (0.03 + speed * 0.1 + boost * 0.06) * (0.35 + throttle * 0.65), 0.13, now);

    // Slip drives level and modulation depth together, so gentle drift is a whisper and a hard
    // strafe stutters into discrete jets rather than just getting louder.
    rampTo(this.thrusterBp.frequency, 720 + slip * 1750, 0.06, now);
    rampTo(this.thrusterBp.Q, 1.0 + slip * 1.6, 0.08, now);
    rampTo(this.thrusterGain.gain, slip * 0.45, 0.05, now);
    rampTo(this.thrusterMod.gain, slip * 0.98, 0.06, now);

    rampTo(this.out.gain, 0.14 + throttle * 0.27 + speed * 0.16 + boost * 0.08, 0.1, now);
  }

  /**
   * A short chuff of pressure release. The stack opening up needs a transient in front of it,
   * otherwise engaging boost reads as a mix fade rather than as an event.
   */
  private chuff(now: number): void {
    const chuffNoise = this.ctx.createBufferSource();
    chuffNoise.buffer = this.noiseBuffer;
    chuffNoise.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(260, now);
    bp.frequency.exponentialRampToValueAtTime(2600, now + 0.22);
    bp.Q.value = 0.9;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    chuffNoise.connect(bp);
    bp.connect(gain);
    gain.connect(this.sfxDestination);
    chuffNoise.start(now, 0.11);
    chuffNoise.stop(now + 0.46);
    this.ledger.retire([chuffNoise, bp, gain], now + 0.5);
  }
}
