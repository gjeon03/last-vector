/**
 * Reusable WebAudio graph builders for LAST VECTOR.
 *
 * Everything the audio subsystem needs is manufactured here at runtime — noise beds, the
 * reverb impulse response, transfer curves for saturation and limiting. Nothing is fetched
 * and nothing is bundled as binary, so the game stays a single self-contained artefact.
 */

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded so that a run's musical choices and the
 * per-call variation of the gate chime are reproducible when we need to debug them.
 */
export const createRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export type NoiseColour = 'white' | 'pink' | 'brown';

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const clamp01 = (value: number): number => clamp(value, 0, 1);

/** Guards against NaN/Infinity reaching an AudioParam, which permanently kills a graph. */
const safe = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? value : fallback;

/**
 * Exponential approach to a target. Every per-frame parameter move in the engine layer goes
 * through this: assigning `.value` each frame produces audible stair-stepping ("zipper" noise).
 */
export const rampTo = (param: AudioParam, value: number, timeConstant: number, when: number): void => {
  param.setTargetAtTime(safe(value), when, Math.max(timeConstant, 0.001));
};

/** Linear segment, used for scheduled one-shot envelopes where the end point must be exact. */
export const rampLinear = (param: AudioParam, value: number, when: number): void => {
  param.linearRampToValueAtTime(safe(value), when);
};

/** Exponential segment. Clamped away from zero because `exponentialRamp` throws on 0. */
export const rampExp = (param: AudioParam, value: number, when: number): void => {
  param.exponentialRampToValueAtTime(Math.max(safe(value, 0.0001), 0.0001), when);
};

export const disconnectAll = (nodes: readonly AudioNode[]): void => {
  for (let i = 0; i < nodes.length; i++) {
    try {
      nodes[i].disconnect();
    } catch {
      /* a node disconnected by dispose() may already be detached; that is not an error */
    }
  }
};

// ---------------------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------------------

/**
 * Stereo noise bed. Generated at twice the requested colour's natural correlation between
 * channels so the turbine and wind layers have real width instead of a mono point source.
 *
 * The tail is equal-power crossfaded into the head so the buffer can loop forever without a
 * seam — critical for the engine, which loops the same buffer for the whole session.
 */
export const createNoiseBuffer = (
  ctx: BaseAudioContext,
  seconds: number,
  colour: NoiseColour,
  seed: number,
): AudioBuffer => {
  const sr = ctx.sampleRate;
  const fade = Math.floor(sr * 0.05);
  const length = Math.max(Math.floor(seconds * sr), fade * 4);
  const buffer = ctx.createBuffer(2, length, sr);
  const rng = createRng(seed);

  for (let ch = 0; ch < 2; ch++) {
    const out = buffer.getChannelData(ch);
    const total = length + fade;
    const raw = new Float32Array(total);

    if (colour === 'white') {
      for (let i = 0; i < total; i++) raw[i] = rng() * 2 - 1;
    } else if (colour === 'pink') {
      // Paul Kellet's refined pink filter: -3 dB/octave, the natural spectrum of air noise.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < total; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      // Leaky integrator: -6 dB/octave. Used where we want weight rather than hiss.
      let last = 0;
      for (let i = 0; i < total; i++) {
        const w = rng() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        raw[i] = last * 3.5;
      }
    }

    // DC block — a drifting offset would thump every time a gain envelope opens.
    let hpPrev = 0;
    let hpOut = 0;
    const hpCoef = Math.exp((-2 * Math.PI * 14) / sr);
    for (let i = 0; i < total; i++) {
      const x = raw[i];
      hpOut = hpCoef * (hpOut + x - hpPrev);
      hpPrev = x;
      raw[i] = hpOut;
    }

    let peak = 1e-6;
    for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(raw[i]));
    const norm = 0.9 / peak;

    for (let i = 0; i < length; i++) out[i] = raw[i] * norm;
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      const a = Math.cos(t * Math.PI * 0.5);
      const b = Math.sin(t * Math.PI * 0.5);
      out[i] = out[i] * a + raw[length + i] * norm * b;
    }
  }

  return buffer;
};

/** A looping noise voice, plus the read offset it should be started at. */
export interface NoiseSource {
  source: AudioBufferSourceNode;
  offset: number;
}

/**
 * Different layers read the same buffer from different points, so the turbine, the thruster
 * sputter and the wind stay decorrelated without paying for three megabytes of noise.
 */
export const createNoiseSource = (
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  offset01 = 0,
): NoiseSource => {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = buffer.duration;
  return { source, offset: clamp01(offset01) * buffer.duration };
};

/** Starts a looping noise source at its decorrelated read position. */
export const startNoise = (voice: NoiseSource, when: number): void => {
  voice.source.start(when, voice.offset);
};

// ---------------------------------------------------------------------------------------
// Reverb
// ---------------------------------------------------------------------------------------

/**
 * Procedural impulse response: exponentially decaying noise, progressively darkened as it
 * decays. Long and dark on purpose — the Cairn Drift should feel like a very large, very cold
 * room, not a plate. Early samples are thinned out so the onset reads as distance, not as a slap.
 */
export const createReverbIR = (
  ctx: BaseAudioContext,
  seconds: number,
  decay: number,
  dampHz: number,
  seed: number,
): AudioBuffer => {
  const sr = ctx.sampleRate;
  const length = Math.max(Math.floor(seconds * sr), 1);
  const buffer = ctx.createBuffer(2, length, sr);
  const rng = createRng(seed);

  for (let ch = 0; ch < 2; ch++) {
    const out = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Damping tightens as the tail decays: high frequencies die first, as in real air.
      const cutoff = dampHz * Math.pow(0.28, t);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
      const env = Math.pow(1 - t, decay) * (1 - Math.exp(-i / (sr * 0.012)));
      const x = (rng() * 2 - 1) * env;
      lp += a * (x - lp);
      out[i] = lp * 3.2;
    }
    let peak = 1e-6;
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const norm = 0.72 / peak;
    for (let i = 0; i < length; i++) out[i] *= norm;
  }

  return buffer;
};

// ---------------------------------------------------------------------------------------
// Transfer curves
// ---------------------------------------------------------------------------------------

/**
 * Odd-symmetric soft saturation. Adds the odd harmonics that make a triangle read as a
 * physical, loaded engine rather than a synthesiser tone.
 *
 * Normalised by the slope at zero, not by the peak: quiet input passes at unity and only loud
 * input compresses. Peak normalisation would make the shaper a hidden makeup amplifier, which
 * is exactly how a mix silently ends up 8 dB hot.
 */
export const createSaturationCurve = (drive: number, samples = 2048): Float32Array<ArrayBuffer> => {
  const curve = new Float32Array(samples);
  const k = Math.max(drive, 0.001);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / k;
  }
  return curve;
};

/**
 * Brick-wall-ish limiter with a soft knee. Transparent below `threshold`, so ordinary mix
 * level is untouched and only stacked gate hits get squeezed.
 */
export const createLimiterCurve = (threshold = 0.72, samples = 4096): Float32Array<ArrayBuffer> => {
  const curve = new Float32Array(samples);
  const head = 1 - threshold;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= threshold ? a : threshold + head * Math.tanh((a - threshold) / head);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
};

// ---------------------------------------------------------------------------------------
// Composite builders
// ---------------------------------------------------------------------------------------

export interface CombUnit {
  input: GainNode;
  output: GainNode;
  delay: DelayNode;
  feedback: GainNode;
  damp: BiquadFilterNode;
  nodes: AudioNode[];
}

/**
 * Damped feedback comb. Applied to the turbine noise it produces a fixed set of resonant
 * peaks — the ear reads that as sound travelling down a metal duct, which is exactly what a
 * ducted-fan thruster is.
 */
export const createComb = (
  ctx: BaseAudioContext,
  delaySeconds: number,
  feedbackAmount: number,
  dampHz: number,
): CombUnit => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const delay = ctx.createDelay(0.25);
  const feedback = ctx.createGain();
  const damp = ctx.createBiquadFilter();

  delay.delayTime.value = delaySeconds;
  feedback.gain.value = clamp(feedbackAmount, 0, 0.92);
  damp.type = 'lowpass';
  damp.frequency.value = dampHz;
  damp.Q.value = 0.4;

  input.connect(delay);
  delay.connect(damp);
  damp.connect(feedback);
  feedback.connect(delay);
  delay.connect(output);
  input.connect(output);

  return { input, output, delay, feedback, damp, nodes: [input, output, delay, feedback, damp] };
};

export interface LfoUnit {
  osc: OscillatorNode;
  depth: GainNode;
  nodes: AudioNode[];
}

/**
 * Phase-offset sine LFO. The phase matters: several drift LFOs started at the same instant
 * would move in lockstep and the pad would breathe like one object instead of a cloud.
 */
export const createLfo = (
  ctx: BaseAudioContext,
  frequency: number,
  depth: number,
  phase = 0,
): LfoUnit => {
  const osc = ctx.createOscillator();
  const real = new Float32Array([0, Math.cos(phase)]);
  const imag = new Float32Array([0, -Math.sin(phase)]);
  osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
  osc.frequency.value = frequency;
  const gain = ctx.createGain();
  gain.gain.value = depth;
  osc.connect(gain);
  return { osc, depth: gain, nodes: [osc, gain] };
};

// ---------------------------------------------------------------------------------------
// Node lifetime bookkeeping
// ---------------------------------------------------------------------------------------

interface RetiredVoice {
  nodes: AudioNode[];
  at: number;
}

/**
 * Single owner of every node the audio subsystem creates.
 *
 * Permanent nodes (the mix bus, the engine stack, the pad) are held for `disposeAll`.
 * One-shot voices are handed over with a retirement time; the sweep disconnects them so the
 * GC can actually collect them. Without this, every gate chime would leak its oscillators.
 */
export class NodeLedger {
  private readonly permanent: AudioNode[] = [];
  private readonly pending: RetiredVoice[] = [];
  private pendingNodes = 0;

  keep<T extends AudioNode>(node: T): T {
    this.permanent.push(node);
    return node;
  }

  keepAll(nodes: readonly AudioNode[]): void {
    for (let i = 0; i < nodes.length; i++) this.permanent.push(nodes[i]);
  }

  retire(nodes: AudioNode[], at: number): void {
    this.pending.push({ nodes, at });
    this.pendingNodes += nodes.length;
  }

  sweep(now: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const voice = this.pending[i];
      if (voice.at > now) continue;
      disconnectAll(voice.nodes);
      this.pendingNodes -= voice.nodes.length;
      const last = this.pending.length - 1;
      if (i !== last) this.pending[i] = this.pending[last];
      this.pending.pop();
    }
  }

  /** Live node count: permanent graph plus every one-shot still awaiting retirement. */
  count(): number {
    return this.permanent.length + this.pendingNodes;
  }

  permanentCount(): number {
    return this.permanent.length;
  }

  pendingVoices(): number {
    return this.pending.length;
  }

  disposeAll(): void {
    for (let i = 0; i < this.pending.length; i++) disconnectAll(this.pending[i].nodes);
    this.pending.length = 0;
    this.pendingNodes = 0;
    disconnectAll(this.permanent);
    this.permanent.length = 0;
  }
}
