#!/usr/bin/env node
/**
 * Offline audio measurement gate for LAST VECTOR.
 *
 * Nobody has listened to this build. That makes offline measurement the only quality gate the
 * audio subsystem has, so it lives in the repository where it can be re-run and disputed rather
 * than in a scratch directory where it cannot.
 *
 * What it does:
 *   1. Builds `src/audio/index.ts` with the repo's own Vite, so the production module graph is
 *      what gets measured.
 *   2. Renders every SfxEvent solo, and every named engine state as a "bed", through
 *      `createAudioGraph` on an OfflineAudioContext inside headless Chromium.
 *   3. Reports, for each cue, per-band signal-to-noise against BOTH the cruise bed and the boost
 *      bed, plus true peak and momentary loudness.
 *   4. Exits non-zero if a gameplay-critical cue has no band with positive SNR against the boost
 *      bed — i.e. if the player provably cannot hear it while the drive is at full power.
 *
 * Every bed's exact `EngineAudioState` is echoed into the report. An earlier version of this
 * measurement was quoted without pinning that state, two people measured different beds, both
 * called the result "the boost bed", and the numbers disagreed by 10 dB with no way to tell who
 * was right. The pinned state is the fix for that class of dispute.
 *
 * Usage:  node scripts/playtest/audio-probe.mjs [--out <dir>] [--json] [--require-clean]
 */

import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve } from 'node:path';
// Only REPO_ROOT. This suite never calls parseOptions or runManagedSuite, so runtime.mjs's
// `--dist` guard at :465 never runs on its behalf. It is protected structurally — there is no
// option to point it at another tree — not by that guard. Anyone adding a --dist here inherits
// nothing.
import { REPO_ROOT } from './runtime.mjs';

// ---------------------------------------------------------------------------------------------
// Measurement contract. Everything here is echoed into report.json so a number can be reproduced.
// ---------------------------------------------------------------------------------------------

/**
 * Named engine states. These ARE the pinned beds — changing a value here changes every SNR in
 * the report, so treat them as the measurement's units and not as tuning knobs.
 */
const BEDS = {
  idle: { throttle: 0, speed01: 0.02, boosting: false, slip: 0 },
  /**
   * Behind the title and briefing screens. NOT silence: `Game.ts` flies the attract loop through
   * the same `ship.update` branch as live play. An earlier version of this file asserted the
   * engine layer was silent on menus and excluded the UI cues from the gate on that basis, which
   * was simply false.
   *
   * Pinned from a 240-frame measurement on the title screen after `Game.ATTRACT_THROTTLE` capped
   * the attract loop at 0.55: throttle mean 0.536, max 0.550, speed01 mean 0.403. Before that cap
   * `driveAutopilot` pushed throttle toward 1 whenever alignment was good — and attract flies a
   * clean line by construction — so the menus sat behind a near-redline drive at 0.954.
   *
   * THIS PIN TRACKS `Game.ATTRACT_THROTTLE`. If that cap changes, re-measure and change this with
   * it, or every UI margin in the report becomes fiction while still looking measured.
   */
  menu: { throttle: 0.55, speed01: 0.4, boosting: false, slip: 0.05 },
  /** `Game.ts` holds throttle 0.22 through the count so the frame is never static. */
  countdown: { throttle: 0.22, speed01: 0.2, boosting: false, slip: 0 },
  cruise: { throttle: 0.55, speed01: 0.45, boosting: false, slip: 0.05 },
  full: { throttle: 1, speed01: 0.85, boosting: false, slip: 0.05 },
  boost: { throttle: 1, speed01: 1, boosting: true, slip: 0.05 },
};

/**
 * The bed each cue must clear — the one the game actually plays it over, not the loudest one.
 * Holding a menu click to the boost bed would be as wrong as holding a gate tick to silence.
 * `finish`, `newBest` and `radio` are measured but ungated: they are resolution and flavour, and
 * they fire at low throttle where nothing is competing with them.
 */
const CUE_BED = {
  gateNear: 'boost', gatePass: 'boost', gateMiss: 'boost', warnProximity: 'boost',
  impact: 'boost', scrape: 'boost', boostStart: 'boost', boostEnd: 'boost', boostEmpty: 'boost',
  countdownTick: 'countdown', countdownGo: 'countdown',
  // The two confirmations duck the drive (UI_DUCK_DEPTH), so they are held to the ducked bed —
  // the one that is actually under them when they sound.
  uiClick: 'menuDucked', uiBack: 'menuDucked',
  // uiHover is measured against the unducked menu bed and reported, but NOT gated. It does not
  // duck, because it fires continuously as the pointer crosses a list and ducking there would
  // pump the mix; and it carries no information — it shadows a visual highlight the player is
  // already looking at. Clearing a 0.95-throttle attract drive would need roughly +40 dB, which
  // would turn pointer movement into a rattle. It is deliberately subordinate, and that is a
  // design choice rather than the "menus are silent" claim that used to sit here, which was false.
  uiHover: 'menu',
};

/** Gated cues. uiHover is excluded for the documented reason above, not by oversight. */
const UNGATED_BUT_MEASURED = ['uiHover', 'finish', 'newBest', 'radio'];

/**
 * Cues whose `intensity` encodes rising urgency. For these the margin must not FALL as intensity
 * rises: a proximity cue that fades as the hazard closes is a defect even when every individual
 * reading clears the bed, and testing each reading against a floor cannot see it. This is exactly
 * the shape of the original gateNear defect, which passed every absolute check after being moved
 * and was still declining across the sweep.
 *
 * `gatePass` is deliberately absent: its intensity is quality-of-pass, not urgency, so there is no
 * reason a perfectly centred pass should be louder than a scraped one.
 */
const ESCALATING_CUES = ['gateNear', 'warnProximity'];

const METHOD = {
  sampleRate: 48000,
  truePeakSampleRate: 192000,
  /** Seconds of render discarded before analysis, so filter and gate smoothing has settled. */
  bedSettleSeconds: 6,
  /** Length of the analysed steady-state window for a bed. */
  bedWindowSeconds: 3,
  /** Music is part of the bed the player actually hears, so it is part of the bed here. */
  musicIntensity: 0.8,
  masterVolume: 0.8,
  musicVolume: 0.65,
  /**
   * A cue's power is measured over the loudest 200 ms of its own solo render. 200 ms is roughly
   * the ear's temporal integration window: a 40 ms tick is not 20 dB quieter than a 400 ms tone
   * of the same peak, and averaging it over 400 ms would say that it is. `snrFullDb` uses the
   * cue's whole audible span instead, and is reported alongside so the choice is visible.
   */
  cueIntegrationSeconds: 0.2,
  snrDefinition:
    'snrDb = 10*log10(P_cue / P_bed) per band, where P_cue is the cue rendered solo over its ' +
    'loudest 200 ms and P_bed is the pinned bed over a 3 s steady window. Positive means the cue ' +
    'has more power than the drive in that band.',
  loudnessSpec: 'ITU-R BS.1770-4 K-weighting; momentary = max over 400 ms windows, ungated.',
  truePeakMethod: 'Peak of a 192 kHz render of the same graph (4x oversampled inter-sample peak).',
};

/** Cues that carry information the player acts on, each gated against its own bed via CUE_BED. */
const GAMEPLAY_CRITICAL = [
  'gateNear',
  'gatePass',
  'gateMiss',
  'warnProximity',
  'impact',
  'scrape',
  'boostStart',
  'boostEnd',
  'boostEmpty',
  'countdownTick',
  'countdownGo',
  'uiClick',
  'uiBack',
];

/** Representative intensity per event. Two entries for cues whose intensity changes the sound. */
const EVENTS = [
  { name: 'gatePass', intensity: 0.4, seconds: 8 },
  { name: 'gatePass', intensity: 1.0, seconds: 8 },
  { name: 'gateNear', intensity: 0.2, seconds: 4 },
  { name: 'gateNear', intensity: 1.0, seconds: 4 },
  { name: 'gateMiss', intensity: 0.7, seconds: 6 },
  { name: 'boostStart', intensity: 0.9, seconds: 6 },
  { name: 'boostEnd', intensity: 0.7, seconds: 6 },
  { name: 'boostEmpty', intensity: 0.5, seconds: 5 },
  { name: 'countdownTick', intensity: 0.3, seconds: 4 },
  { name: 'countdownGo', intensity: 1.0, seconds: 8 },
  { name: 'finish', intensity: 1.0, seconds: 10 },
  { name: 'newBest', intensity: 1.0, seconds: 9 },
  { name: 'impact', intensity: 0.9, seconds: 6 },
  { name: 'scrape', intensity: 0.7, seconds: 6 },
  { name: 'warnProximity', intensity: 0.3, seconds: 5 },
  { name: 'warnProximity', intensity: 1.0, seconds: 5 },
  { name: 'uiHover', intensity: 0.5, seconds: 4 },
  { name: 'uiClick', intensity: 0.5, seconds: 4 },
  { name: 'uiBack', intensity: 0.5, seconds: 4 },
  { name: 'radio', intensity: 0.6, seconds: 6 },
];

// ---------------------------------------------------------------------------------------------
// In-page measurement. Runs inside Chromium; may not reference anything from Node scope.
// ---------------------------------------------------------------------------------------------

/* eslint-disable */
async function measureInPage(config) {
  const { bundleUrl, beds, events, method, thirdOctaveCentres, cueBed } = config;
  const mod = await import(bundleUrl);
  const SR = method.sampleRate;

  // ---- signal helpers ----------------------------------------------------------------------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  const dbOf = (x) => (x <= 1e-20 ? -Infinity : 10 * Math.log10(x));
  const round = (x, d = 1) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

  function monoOf(buffer, from, to) {
    const a = Math.max(0, Math.floor(from * buffer.sampleRate));
    const z = Math.min(buffer.length, Math.floor(to * buffer.sampleRate));
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const m = new Float32Array(Math.max(z - a, 0));
    for (let i = 0; i < m.length; i++) {
      let s = 0;
      for (let c = 0; c < chans.length; c++) s += chans[c][a + i];
      m[i] = s / chans.length;
    }
    return m;
  }

  /** Mean power spectrum, returned as power per FFT bin. */
  function powerSpectrum(m) {
    const N = 4096, hop = 2048;
    if (m.length < N) return null;
    const re = new Float64Array(N), im = new Float64Array(N);
    const win = new Float64Array(N);
    let winPow = 0;
    for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); winPow += win[i] * win[i]; }
    winPow /= N;
    const acc = new Float64Array(N / 2);
    let frames = 0;
    for (let p = 0; p + N <= m.length; p += hop) {
      for (let i = 0; i < N; i++) { re[i] = m[p + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) acc[k] += (re[k] * re[k] + im[k] * im[k]);
      frames++;
    }
    if (!frames) return null;
    const scale = 1 / (frames * (N / 2) * (N / 2) * winPow);
    for (let k = 1; k < N / 2; k++) acc[k] *= scale;
    return { power: acc, binHz: SR / N };
  }

  /** Sums a power spectrum into third-octave bands. */
  function thirdOctave(spec) {
    if (!spec) return null;
    return thirdOctaveCentres.map((fc) => {
      const lo = fc / Math.pow(2, 1 / 6), hi = fc * Math.pow(2, 1 / 6);
      let p = 0;
      const kLo = Math.max(1, Math.ceil(lo / spec.binHz)), kHi = Math.min(spec.power.length - 1, Math.floor(hi / spec.binHz));
      for (let k = kLo; k <= kHi; k++) p += spec.power[k];
      return p;
    });
  }

  const COARSE = [120, 400, 1500, 5000];
  function coarseBands(spec) {
    if (!spec) return null;
    const acc = [0, 0, 0, 0, 0];
    for (let k = 1; k < spec.power.length; k++) {
      const f = k * spec.binHz;
      let bi = 0; while (bi < COARSE.length && f >= COARSE[bi]) bi++;
      acc[bi] += spec.power[k];
    }
    const total = acc.reduce((a, b) => a + b, 0) || 1e-20;
    return { powers: acc, percent: acc.map((a) => round(100 * a / total, 1)) };
  }

  /** ITU-R BS.1770-4 K-weighting, 48 kHz coefficients. */
  function kWeight(m) {
    const out = new Float64Array(m.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const b = [1.53512485958697, -2.69169618940638, 1.19839281085285];
    const a = [1, -1.69065929318241, 0.73248077421585];
    for (let i = 0; i < m.length; i++) {
      const x = m[i];
      const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
    }
    let u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    const b2 = [1, -2, 1];
    const a2 = [1, -1.99004745483398, 0.99007225036621];
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const y = b2[0] * x + b2[1] * u1 + b2[2] * u2 - a2[1] * v1 - a2[2] * v2;
      u2 = u1; u1 = x; v2 = v1; v1 = y; out[i] = y;
    }
    return out;
  }

  function loudnessLkfs(m) {
    const k = kWeight(m);
    let s = 0;
    for (let i = 0; i < k.length; i++) s += k[i] * k[i];
    return -0.691 + 10 * Math.log10(Math.max(s / Math.max(k.length, 1), 1e-20));
  }

  /** Max loudness over sliding windows of `winS` seconds. */
  function maxWindowLoudness(m, winS) {
    const w = Math.floor(winS * SR), hop = Math.floor(w / 4);
    if (m.length < w) return loudnessLkfs(m);
    let best = -Infinity;
    for (let p = 0; p + w <= m.length; p += hop) best = Math.max(best, loudnessLkfs(m.subarray(p, p + w)));
    return best;
  }

  /** Window of length `winS` containing the most energy — where the cue actually lives. */
  function loudestWindow(m, winS) {
    const w = Math.min(Math.floor(winS * SR), m.length);
    if (m.length <= w) return { start: 0, length: m.length };
    const step = Math.max(1, Math.floor(0.005 * SR));
    let best = -1, bestAt = 0, run = 0;
    for (let i = 0; i < w; i++) run += m[i] * m[i];
    best = run; bestAt = 0;
    for (let p = step; p + w <= m.length; p += step) {
      run = 0;
      for (let i = p; i < p + w; i += 1) run += m[i] * m[i];
      if (run > best) { best = run; bestAt = p; }
    }
    return { start: bestAt, length: w };
  }

  /** Audible span at -50 dB relative to the envelope peak, via a 5 ms RMS envelope. */
  function audibleSpan(m) {
    const w = Math.floor(0.005 * SR);
    const n = Math.floor(m.length / w);
    if (!n) return { from: 0, to: m.length / SR };
    let peak = 0;
    const env = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = 0; i < w; i++) s += m[k * w + i] ** 2;
      env[k] = Math.sqrt(s / w);
      if (env[k] > peak) peak = env[k];
    }
    const floor = peak * Math.pow(10, -50 / 20);
    let first = 0, last = n - 1;
    for (let k = 0; k < n; k++) if (env[k] > floor) { first = k; break; }
    for (let k = n - 1; k >= 0; k--) if (env[k] > floor) { last = k; break; }
    return { from: (first * w) / SR, to: ((last + 1) * w) / SR };
  }

  function peakOf(buffer) {
    let pk = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
    }
    return pk;
  }

  // ---- renders -------------------------------------------------------------------------------
  function newGraph(ctx) {
    const g = mod.createAudioGraph(ctx, 0x5eed1e);
    g.master.gain.value = method.masterVolume * 0.9;
    g.musicVolume.gain.value = method.musicVolume;
    return g;
  }

  /** Steady-state bed at a pinned EngineAudioState. `withMusic` false isolates the drive. */
  /**
   * `musicSendDuck` defaults to `musicDuck` because both paths should always move together. It is
   * separable only so the report can quantify what ducking the send path is worth: rendering the
   * same bed with the dry path ducked alone reproduces the behaviour the mix had before
   * `MusicBed.sendTrim` existed.
   */
  async function renderBed(state, withMusic, engineDuck = 1, musicDuck = 1, musicSendDuck = musicDuck) {
    const seconds = method.bedSettleSeconds + method.bedWindowSeconds + 0.2;
    const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
    const g = newGraph(ctx);
    g.sfxBus.gain.value = 0;
    if (!withMusic) g.musicBus.gain.value = 0;
    g.engineDuck.gain.value = engineDuck;
    // Both nodes, because the score reaches the mix by two paths and one of them bypasses the bus.
    g.musicDuck.gain.value = musicDuck;
    g.music.sendTrim.gain.value = musicSendDuck;
    g.engine.start(0);
    // MusicBed's reverb sends tap each layer gate BEFORE musicBus, so zeroing that gain mutes only
    // the dry path and leaves a pad tail in a row labelled "engine only". The idle bed was
    // published 16 dB hot for that reason. The music is therefore not started at all here.
    if (withMusic) {
      g.music.start(0);
      g.music.setIntensity(method.musicIntensity);
    }
    const dt = 1 / 30;
    for (let k = 1; k * dt < seconds - 0.1; k++) {
      const t = k * dt;
      ctx.suspend(t).then(() => {
        g.engine.update(dt, state);
        if (withMusic) g.music.tick(ctx.currentTime);
        g.ledger.sweep(ctx.currentTime);
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const m = monoOf(buf, method.bedSettleSeconds, method.bedSettleSeconds + method.bedWindowSeconds);
    const spec = powerSpectrum(m);
    return {
      thirdOctave: thirdOctave(spec),
      coarse: coarseBands(spec),
      lufsShortTerm: round(maxWindowLoudness(m, 3), 2),
      peakDbfs: round(20 * Math.log10(Math.max(peakOf(buf), 1e-12)), 2),
    };
  }

  /** A cue rendered solo through the full production chain (reverb, glue, limiter, master). */
  async function renderEvent(name, intensity, seconds) {
    const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
    const g = newGraph(ctx);
    g.engineBus.gain.value = 0;
    g.musicBus.gain.value = 0;
    g.sfx.play(name, intensity, 0.05);
    const buf = await ctx.startRendering();
    const whole = monoOf(buf, 0, seconds);
    const span = audibleSpan(whole);
    const win = loudestWindow(whole, method.cueIntegrationSeconds);
    const hot = whole.subarray(win.start, win.start + win.length);
    const full = whole.subarray(Math.floor(span.from * SR), Math.max(Math.floor(span.to * SR), Math.floor(span.from * SR) + 1));

    const tpCtx = new OfflineAudioContext(2, Math.round(seconds * method.truePeakSampleRate), method.truePeakSampleRate);
    const tg = mod.createAudioGraph(tpCtx, 0x5eed1e);
    tg.master.gain.value = method.masterVolume * 0.9;
    tg.engineBus.gain.value = 0;
    tg.musicBus.gain.value = 0;
    tg.sfx.play(name, intensity, 0.05);
    const tpBuf = await tpCtx.startRendering();

    return {
      durationS: round(span.to - span.from, 3),
      hotWindowStartS: round(win.start / SR, 3),
      truePeakDbTP: round(20 * Math.log10(Math.max(peakOf(tpBuf), 1e-12)), 2),
      samplePeakDbfs: round(20 * Math.log10(Math.max(peakOf(buf), 1e-12)), 2),
      momentaryLufs: round(maxWindowLoudness(whole, 0.4), 2),
      thirdOctaveHot: thirdOctave(powerSpectrum(hot)),
      thirdOctaveFull: thirdOctave(powerSpectrum(full)),
      coarseHot: coarseBands(powerSpectrum(hot)),
    };
  }

  // ---- run -----------------------------------------------------------------------------------
  const bedResults = {};
  for (const [name, state] of Object.entries(beds)) {
    bedResults[name] = {
      state,
      engineOnly: await renderBed(state, false),
      withMusic: await renderBed(state, true),
    };
  }
  // The bed a UI confirmation actually lands on: the menu state with the drive ducked by exactly
  // the constant the mix uses, read from the module so the two cannot drift apart.
  bedResults.menuDucked = {
    state: beds.menu,
    derivedFrom: 'menu',
    engineDuckDepth: mod.UI_DUCK_DEPTH,
    engineOnly: await renderBed(beds.menu, false, mod.UI_DUCK_DEPTH),
    withMusic: await renderBed(beds.menu, true, mod.UI_DUCK_DEPTH),
  };

  // The pause menu, which nobody had measured: the drive and score both held at their menu floors
  // over whatever the player was last flying. Pinned to the `full` bed underneath because pausing
  // at speed is the loud case and therefore the conservative one.
  bedResults.menuPaused = {
    state: beds.full,
    derivedFrom: 'full',
    engineDuckDepth: mod.MENU_DUCK_DEPTH,
    musicDuckDepth: mod.MENU_MUSIC_DEPTH,
    engineOnly: await renderBed(beds.full, false, mod.MENU_DUCK_DEPTH),
    withMusic: await renderBed(beds.full, true, mod.MENU_DUCK_DEPTH, mod.MENU_MUSIC_DEPTH),
  };
  // Same bed with the score's reverb send left at full level: what the menu trim actually did
  // before the send path became duckable. The difference is what the fix is worth, rendered
  // rather than inferred from the bypass fraction.
  const menuPausedDryDuckOnly = await renderBed(beds.full, true, mod.MENU_DUCK_DEPTH, mod.MENU_MUSIC_DEPTH, 1);
  bedResults.menuPaused.musicDuckEffect = {
    lufsWithSendDucked: bedResults.menuPaused.withMusic.lufsShortTerm,
    lufsWithSendAtFullLevel: menuPausedDryDuckOnly.lufsShortTerm,
    gainedDb: round(menuPausedDryDuckOnly.lufsShortTerm - bedResults.menuPaused.withMusic.lufsShortTerm, 2),
  };

  /**
   * The score in isolation at a given Score-slider position, engine and sfx muted.
   *
   * This measures the GRAPH, not the control. It assigns both gains directly and never calls
   * `setMusicVolume`, so it establishes that the topology can be silenced — that `sendVolume` is
   * really in the send path, and that zero on both nodes yields digital silence — and it would
   * pass unchanged if `setMusicVolume` drove neither of them. The control is measured by
   * `LIVE.music-volume-zero-reaches-both-paths`, and the player's route into it by
   * `GAME.score-slider-reaches-the-mix`.
   *
   * Both suites pinned masterVolume/musicVolume and never moved them, so a shipped slider that
   * changed 0.55 dB of score between default and zero passed 23/23 and 21/21 for the life of the
   * project.
   */
  async function renderScoreStem(volume) {
    const seconds = method.bedSettleSeconds + method.bedWindowSeconds + 0.2;
    const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
    const g = newGraph(ctx);
    g.sfxBus.gain.value = 0;
    g.engineBus.gain.value = 0;
    g.musicVolume.gain.value = volume;
    g.music.sendVolume.gain.value = volume;
    g.music.start(0);
    g.music.setIntensity(method.musicIntensity);
    const dt = 1 / 30;
    for (let k = 1; k * dt < seconds - 0.1; k++) {
      const t = k * dt;
      ctx.suspend(t).then(() => {
        g.music.tick(ctx.currentTime);
        g.ledger.sweep(ctx.currentTime);
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const m = monoOf(buf, method.bedSettleSeconds, method.bedSettleSeconds + method.bedWindowSeconds);
    let sq = 0;
    for (let i = 0; i < m.length; i++) sq += m[i] * m[i];
    const rms = Math.sqrt(sq / Math.max(m.length, 1));
    return { volume, rmsDb: rms <= 1e-12 ? -Infinity : round(20 * Math.log10(rms), 2), peak: peakOf(buf) };
  }

  const scoreStem = [];
  for (const v of [1, 0.65, 0.3, 0.05, 0]) scoreStem.push(await renderScoreStem(v));

  const eventResults = [];
  for (const ev of events) {
    const r = await renderEvent(ev.name, ev.intensity, ev.seconds);
    const snrAgainst = (bedName, cueBands) => {
      const bed = bedResults[bedName].withMusic.thirdOctave;
      if (!cueBands || !bed) return null;
      const perBand = cueBands.map((p, i) => round(dbOf(p) - dbOf(bed[i]), 1));
      let bestIdx = 0;
      for (let i = 1; i < perBand.length; i++) {
        if (perBand[i] !== null && (perBand[bestIdx] === null || perBand[i] > perBand[bestIdx])) bestIdx = i;
      }
      return { perBand, bestHz: thirdOctaveCentres[bestIdx], bestSnrDb: perBand[bestIdx] };
    };
    eventResults.push({
      name: ev.name,
      intensity: ev.intensity,
      ...r,
      snrVsCruise: snrAgainst('cruise', r.thirdOctaveHot),
      snrVsBoost: snrAgainst('boost', r.thirdOctaveHot),
      snrVsBoostFull: snrAgainst('boost', r.thirdOctaveFull),
      ownBed: cueBed[ev.name] ?? null,
      snrVsOwnBed: cueBed[ev.name] ? snrAgainst(cueBed[ev.name], r.thirdOctaveHot) : null,
    });
  }

  // ---- worst realistic moment ----------------------------------------------------------------
  // The course packs 460 rocks against the channel wall with 145-175 m clearance on the tight
  // legs, so contact cues are routine rather than theoretical, and the collision loop calls
  // `scrape` once per contact per frame. This renders the ugliest plausible second: full boost,
  // a sustained 60 Hz graze, the 3 Hz proximity alarm, repeated strikes and a gate chime on top.
  async function renderStress() {
    const seconds = 9;
    const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
    const g = newGraph(ctx);
    g.engine.start(0);
    g.music.start(0);
    g.music.setIntensity(0.95);
    const state = beds.boost;

    // Cues are fired just-in-time from inside the render, the way Game.ts fires them, because
    // `play()` builds its nodes when it is CALLED and not when the sound starts. Scheduling the
    // whole scene up front would leave every future voice resident from t=0 and report a node
    // count several times the real concurrency — which is a property of the harness, not the mix.
    const strikes = [3.4, 3.42, 4.1, 5.05, 5.06, 6.2];
    const dt = 1 / 30;
    let peakNodes = 0;
    for (let k = 1; k * dt < seconds - 0.1; k++) {
      const t = k * dt;
      ctx.suspend(t).then(() => {
        const now = ctx.currentTime;
        const at = now + 0.012;
        g.engine.update(dt, state);
        g.music.tick(now);

        // Sustained graze: what an unthrottled per-frame call site actually emits. The step is
        // 30 Hz so two calls per step reproduce a 60 Hz collision loop.
        if (t >= 3 && t < 8) {
          g.sfx.play('scrape', 0.55, at);
          g.sfx.play('scrape', 0.55, at + 1 / 60);
        }
        // Proximity alarm at the game's 3 Hz cadence.
        if (t >= 2.8 && t < 8.3 && Math.floor(t * 3) !== Math.floor((t - dt) * 3)) {
          g.sfx.play('warnProximity', 0.9, at);
        }
        // Strikes, including two in the same frame from different rocks.
        for (const s of strikes) if (s >= t - dt && s < t) g.sfx.play('impact', 0.7, at);
        if (5.6 >= t - dt && 5.6 < t) g.sfx.play('gatePass', 0.9, at);

        g.ledger.sweep(now);
        const c = g.ledger.count();
        if (c > peakNodes) peakNodes = c;
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const m = monoOf(buf, 2.5, 8);
    return {
      peakNodes,
      permanentNodes: g.ledger.permanentCount(),
      samplePeakDbfs: round(20 * Math.log10(Math.max(peakOf(buf), 1e-12)), 2),
      lufsShortTerm: round(maxWindowLoudness(m, 3), 2),
      /** How far the busiest moment sits above the quiet boost bed. Large means the mix is piling up. */
      loudnessOverBedDb: round(maxWindowLoudness(m, 3) - bedResults.boost.withMusic.lufsShortTerm, 2),
    };
  }
  const stress = await renderStress();

  /**
   * `scrape` is the one cue the game uses as a sustained texture rather than as a moment: the
   * collision loop re-triggers it for as long as contact lasts, and the grains overlap into one
   * continuous sound. Measuring a single grain therefore under-states it, so it is also measured
   * the way it is actually used — as the increment a continuous graze adds to the boost bed.
   */
  async function renderSustainedGraze() {
    const seconds = 9;
    const render = async (withGraze) => {
      const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
      const g = newGraph(ctx);
      g.engine.start(0);
      g.music.start(0);
      g.music.setIntensity(method.musicIntensity);
      const dt = 1 / 30;
      for (let k = 1; k * dt < seconds - 0.1; k++) {
        const t = k * dt;
        ctx.suspend(t).then(() => {
          const now = ctx.currentTime;
          g.engine.update(dt, beds.boost);
          g.music.tick(now);
          if (withGraze && t >= 2 && t < 8.5) {
            g.sfx.play('scrape', 0.55, now + 0.012);
            g.sfx.play('scrape', 0.55, now + 0.012 + 1 / 60);
          }
          g.ledger.sweep(now);
          ctx.resume();
        });
      }
      return await ctx.startRendering();
    };
    const bare = thirdOctave(powerSpectrum(monoOf(await render(false), 4, 8)));
    const grazed = thirdOctave(powerSpectrum(monoOf(await render(true), 4, 8)));
    if (!bare || !grazed) return null;
    const perBand = grazed.map((p, i) => round(dbOf(p) - dbOf(bare[i]), 1));
    let bestIdx = 0;
    for (let i = 1; i < perBand.length; i++) if (perBand[i] > perBand[bestIdx]) bestIdx = i;
    const inc = perBand[bestIdx];
    return {
      perBandIncrementDb: perBand,
      bestHz: thirdOctaveCentres[bestIdx],
      bestIncrementDb: inc,
      /** Increment converted back to the cue-over-bed ratio the single-grain figures report. */
      impliedSnrDb: inc > 0.05 ? round(10 * Math.log10(Math.pow(10, inc / 10) - 1), 1) : null,
    };
  }
  const sustainedGraze = await renderSustainedGraze();

  // Node hygiene, re-checked here so the gate covers it too.
  const hygieneSeconds = 30;
  const hctx = new OfflineAudioContext(1, Math.round(hygieneSeconds * SR), SR);
  const hg = mod.createAudioGraph(hctx, 7);
  hg.reverbSend.disconnect();
  const names = [...new Set(events.map((e) => e.name))];
  const permanent = hg.ledger.count();
  let peakNodes = permanent;
  for (let k = 0; k < 500; k++) {
    hctx.suspend(0.05 + k * 0.05).then(() => {
      hg.sfx.play(names[k % names.length], (k % 11) / 10, hctx.currentTime + 0.01);
      hg.ledger.sweep(hctx.currentTime);
      const c = hg.ledger.count();
      if (c > peakNodes) peakNodes = c;
      hctx.resume();
    });
  }
  await hctx.startRendering();
  hg.ledger.sweep(hygieneSeconds + 10);

  return {
    beds: bedResults,
    events: eventResults,
    stress,
    sustainedGraze,
    scoreStem,
    hygiene: { permanent, peak: peakNodes, after: hg.ledger.count(), pendingVoices: hg.ledger.pendingVoices() },
  };
}
/* eslint-enable */

// ---------------------------------------------------------------------------------------------
// Node side
// ---------------------------------------------------------------------------------------------

const thirdOctaveCentres = (() => {
  const out = [];
  for (let n = -13; n <= 12; n++) out.push(Number((1000 * Math.pow(2, n / 3)).toFixed(1)));
  return out.filter((f) => f >= 40 && f <= 16000);
})();

function parseArgs(argv) {
  // Default under playtest-out/, which .gitignore already covers.
  const options = { out: resolve(REPO_ROOT, 'playtest-out/audio-probe'), json: false, requireClean: false, artifactLocked: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = resolve(REPO_ROOT, argv[++i] ?? '.');
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--require-clean') options.requireClean = true;
    // Accepted so a locked round can pass the same flag to every suite. This one builds only into
    // a private temp directory and never writes dist/, so honouring it is a no-op — recorded in the
    // report rather than silently ignored, so "locked" cannot be read as more than it is here.
    else if (argv[i] === '--artifact-locked') options.artifactLocked = true;
  }
  return options;
}

/**
 * What the numbers were measured at.
 *
 * This harness builds `src/audio/index.ts` from disk, so a green report can be true of code that
 * is not in any commit. Recording the SHA and the dirty file list makes a stale or unattributable
 * measurement visibly so, instead of leaving it to be quoted later as though it described a
 * commit. `--require-clean` turns that into a hard precondition for runs producing evidence.
 */
async function readProvenance() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // `trim()` would strip the leading space of porcelain's two-column status prefix and shift the
  // first path by one character, so status is read raw and only the trailing newline removed.
  const git = async (args, raw = false) => {
    try {
      const { stdout } = await run('git', args, { cwd: REPO_ROOT });
      return raw ? stdout.replace(/\n$/, '') : stdout.trim();
    } catch {
      return null;
    }
  };
  const commit = await git(['rev-parse', 'HEAD']);
  // Scoped to the paths this suite's evidence actually depends on.
  //
  // Unscoped, `--require-clean` was a shared tripwire: ANY uncommitted file anywhere in the repo,
  // by any author — a docs edit, a UI file, another agent mid-change — turned both audio suites
  // into exit-2 infrastructure errors for every reviewer running the full suite at once. And it
  // presents as "the audio gate is broken" rather than as "somebody has an uncommitted file",
  // with only the exit code separating those readings.
  //
  // The property the flag exists for is "these numbers describe a commit". That is preserved by
  // watching what the numbers are made of; watching the whole tree adds "and nobody else is
  // working", which was never intended and is false by construction on a shared repo.
  // What this suite's numbers are made of: it builds src/audio/index.ts alone.
  const RELEVANT = ['src/audio/', 'src/core/', 'scripts/playtest/audio-probe.mjs'];
  const status = await git(['status', '--porcelain'], true);
  const allDirty = status ? status.split('\n').filter(Boolean).map((l) => l.slice(3)) : [];
  const dirtyFiles = allDirty.filter((f) => RELEVANT.some((r) => f.startsWith(r)));
  return {
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    clean: dirtyFiles.length === 0,
    dirtyOutsideScope: allDirty.filter((f) => !dirtyFiles.includes(f)),
    dirtyFiles,
    measuredAt: commit ? `${commit.slice(0, 7)}${dirtyFiles.length === 0 ? '' : ' (DIRTY TREE)'}` : 'unknown',
  };
}

async function buildAudioBundle(outDir) {
  const { build } = await import('vite');
  await build({
    configFile: false,
    root: REPO_ROOT,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      lib: { entry: resolve(REPO_ROOT, 'src/audio/index.ts'), formats: ['es'], fileName: () => 'audio.js' },
    },
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

async function serveDir(dir) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, MIME['.html'] ? { 'content-type': MIME['.html'] } : {});
      res.end('<!doctype html><meta charset="utf-8"><title>audio-probe</title><body></body>');
      return;
    }
    try {
      const body = await readFile(resolve(dir, `.${path}`));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

function evaluateGate(measurement) {
  const checks = [];
  for (const ev of measurement.events) {
    if (!GAMEPLAY_CRITICAL.includes(ev.name)) continue;
    const best = ev.snrVsOwnBed?.bestSnrDb ?? null;
    checks.push({
      id: `AUDIBLE.${ev.name}@${ev.intensity}`,
      passed: best !== null && best > 0,
      detail:
        best === null
          ? 'No SNR computed.'
          : `best third-octave SNR vs ${ev.ownBed} bed = ${best} dB at ${ev.snrVsOwnBed.bestHz} Hz ` +
            `(needs > 0 dB; the bed is louder than the cue in every band otherwise)`,
    });
  }

  // A cue signalling rising urgency must not lose margin as the urgency rises. Absolute checks
  // cannot see this: every reading can clear the bed while the trend runs the wrong way.
  for (const name of ESCALATING_CUES) {
    const sweep = measurement.events
      .filter((e) => e.name === name && e.snrVsOwnBed)
      .sort((a, b) => a.intensity - b.intensity);
    if (sweep.length < 2) {
      checks.push({ id: `ESCALATES.${name}`, passed: false, detail: 'fewer than two intensities measured; the trend cannot be tested' });
      continue;
    }
    const lo = sweep[0], hi = sweep[sweep.length - 1];
    const delta = Number((hi.snrVsOwnBed.bestSnrDb - lo.snrVsOwnBed.bestSnrDb).toFixed(1));
    checks.push({
      id: `ESCALATES.${name}`,
      passed: delta >= -0.5,
      detail:
        `SNR vs ${hi.ownBed} bed goes ${lo.snrVsOwnBed.bestSnrDb} dB at intensity ${lo.intensity} ` +
        `-> ${hi.snrVsOwnBed.bestSnrDb} dB at intensity ${hi.intensity} (${delta >= 0 ? '+' : ''}${delta} dB; ` +
        `must not fall as the cue becomes more urgent)`,
    });
  }
  const h = measurement.hygiene;
  checks.push({
    id: 'NODES.stable',
    passed: h.after === h.permanent && h.pendingVoices === 0,
    detail: `permanent ${h.permanent}, peak ${h.peak}, after 500 events ${h.after}, pending ${h.pendingVoices}`,
  });
  const st = measurement.stress;
  // A per-frame call site must not be able to inflate the graph without bound. Measured: 301
  // nodes with the retrigger floors in sfx.ts, 894 with them disabled. The ceiling sits between
  // the two with margin — it catches an unthrottled call site without tripping on ordinary drift.
  checks.push({
    id: 'STRESS.nodeceiling',
    passed: st.peakNodes < st.permanentNodes + 350,
    detail: `worst-moment peak ${st.peakNodes} nodes vs ${st.permanentNodes} permanent (ceiling ${st.permanentNodes + 350})`,
  });
  checks.push({
    id: 'STRESS.headroom',
    passed: st.samplePeakDbfs < -0.5,
    detail: `worst-moment sample peak ${st.samplePeakDbfs} dBFS, loudness ${st.lufsShortTerm} LUFS-S (+${st.loudnessOverBedDb} dB over the boost bed)`,
  });
  // scrape is re-triggered for the length of a contact, so the sustained texture is what the
  // player hears. The single-grain check above is necessary but not sufficient for this one cue.
  const sg = measurement.sustainedGraze;
  checks.push({
    id: 'AUDIBLE.scrape.sustained',
    passed: sg !== null && sg.bestIncrementDb > 1,
    detail: sg === null
      ? 'not measured'
      : `a continuous graze lifts the boost bed by ${sg.bestIncrementDb} dB at ${sg.bestHz} Hz ` +
        `(implied cue-over-bed ${sg.impliedSnrDb} dB; needs > 1 dB)`,
  });
  // A volume control that does not reach silence is not a volume control.
  const stem = measurement.scoreStem ?? [];
  const atZero = stem.find((x) => x.volume === 0);
  const atFull = stem.find((x) => x.volume === 1);
  const atLow = stem.find((x) => x.volume === 0.05);
  checks.push({
    id: 'MUSIC.volume-zero-silences-score',
    passed: atZero !== undefined && (atZero.rmsDb === null || atZero.rmsDb < -120),
    detail: `score stem at slider 0 = ${atZero?.rmsDb ?? 'n/a'} dBFS RMS (must be below -120; ` +
      `anything audible here means a player who turns the music off still hears it)`,
  });
  const travel = atFull && atLow && Number.isFinite(atFull.rmsDb) && Number.isFinite(atLow.rmsDb)
    ? Number((atFull.rmsDb - atLow.rmsDb).toFixed(2))
    : null;
  checks.push({
    id: 'MUSIC.volume-travel',
    passed: travel !== null && travel >= 20,
    detail: `score stem spans ${travel} dB between slider 1.00 and 0.05 (must be >= 20; a partially ` +
      `inert control still reaches silence at exactly zero while doing almost nothing in between)`,
  });
  const clipped = measurement.events.filter((e) => (e.truePeakDbTP ?? -99) > -0.5);
  checks.push({
    id: 'HEADROOM.truepeak',
    passed: clipped.length === 0,
    detail: clipped.length ? `over -0.5 dBTP: ${clipped.map((e) => `${e.name} ${e.truePeakDbTP}`).join(', ')}` : 'all cues below -0.5 dBTP',
  });
  return checks;
}

function formatTable(measurement) {
  const lines = [];
  lines.push('BEDS (pinned EngineAudioState; percentages are engine-only, <120/400/1.5k/5k/+ Hz)');
  for (const [name, bed] of Object.entries(measurement.beds)) {
    lines.push(
      `  ${name.padEnd(7)} ${JSON.stringify(bed.state)}\n` +
      `          engine-only ${bed.engineOnly.coarse.percent.join('/')}  ` +
      `LUFS-S ${bed.engineOnly.lufsShortTerm}   with music ${bed.withMusic.coarse.percent.join('/')}  LUFS-S ${bed.withMusic.lufsShortTerm}`,
    );
  }
  lines.push('');
  lines.push('');
  lines.push(
    `WORST MOMENT (boost + 60 Hz graze + 3 Hz alarm + strikes + chime): peak ${measurement.stress.samplePeakDbfs} dBFS, ` +
    `${measurement.stress.lufsShortTerm} LUFS-S (+${measurement.stress.loudnessOverBedDb} over bed), ` +
    `${measurement.stress.peakNodes} nodes vs ${measurement.stress.permanentNodes} permanent`,
  );
  if (measurement.sustainedGraze) {
    lines.push(
      `SUSTAINED GRAZE: continuous contact lifts the boost bed by ` +
      `${measurement.sustainedGraze.bestIncrementDb} dB at ${measurement.sustainedGraze.bestHz} Hz ` +
      `(implied cue-over-bed ${measurement.sustainedGraze.impliedSnrDb} dB)`,
    );
  }
  if (measurement.scoreStem) {
    lines.push('');
    lines.push('SCORE STEM vs Score slider: ' + measurement.scoreStem.map((x) => `${x.volume}=${x.rmsDb ?? '-inf'}`).join('  '));
  }
  lines.push('');
  lines.push('CUES  (SNR = cue power over bed power, best third-octave band; > 0 dB = cue wins)');
  lines.push('  event            int   dur   dBTP   MomLUFS   vs cruise        vs boost         own bed');
  for (const e of measurement.events) {
    const c = e.snrVsCruise, b = e.snrVsBoost;
    lines.push(
      `  ${e.name.padEnd(14)} ${String(e.intensity).padStart(4)} ${String(e.durationS).padStart(5)} ` +
      `${String(e.truePeakDbTP).padStart(6)} ${String(e.momentaryLufs).padStart(8)}   ` +
      `${String(c ? `${c.bestSnrDb} dB @${c.bestHz}` : '-').padEnd(16)} ` +
      `${String(b ? `${b.bestSnrDb} dB @${b.bestHz}` : '-').padEnd(16)} ` +
      `${e.snrVsOwnBed ? `${e.snrVsOwnBed.bestSnrDb} dB vs ${e.ownBed}` : ''}`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workDir = resolve(tmpdir(), `lv-audio-probe-${process.pid}`);
  await mkdir(options.out, { recursive: true });

  const provenance = await readProvenance();
  if (options.requireClean && !provenance.clean) {
    console.error(
      `Refusing to produce evidence from a dirty tree. Uncommitted:\n  ${provenance.dirtyFiles.join('\n  ')}`,
    );
    process.exit(2);
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.error('Could not import playwright. Run pnpm install, then pnpm exec playwright install chromium once.');
    process.exit(2);
  }

  let server = null;
  let browser = null;
  try {
    await buildAudioBundle(workDir);
    const served = await serveDir(workDir);
    server = served.server;

    browser = await playwright.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
    await page.goto(`${served.origin}/`);

    const measurement = await page.evaluate(measureInPage, {
      bundleUrl: `${served.origin}/audio.js`,
      beds: BEDS,
      events: EVENTS,
      method: METHOD,
      thirdOctaveCentres,
      cueBed: CUE_BED,
    });

    const checks = evaluateGate(measurement);
    const failed = checks.filter((c) => !c.passed);
    const report = {
      status: failed.length === 0 && pageErrors.length === 0 ? 'PASS' : 'FAIL',
      summary: { passed: checks.length - failed.length, failed: failed.length, total: checks.length },
      provenance,
      method: { ...METHOD, thirdOctaveCentres },
      artifactLocked: options.artifactLocked,
      sharedArtefactsWritten: [],
      gameplayCritical: GAMEPLAY_CRITICAL,
      ungatedButMeasured: UNGATED_BUT_MEASURED,
      cueBed: CUE_BED,
      checks,
      pageErrors,
      ...measurement,
    };
    await writeFile(resolve(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(formatTable(measurement));
      console.log('');
      for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.id}  — ${c.detail}`);
      if (pageErrors.length) console.log(`\nconsole/page errors:\n  ${pageErrors.join('\n  ')}`);
      console.log(
        `\n${report.status}  ${report.summary.passed}/${report.summary.total} checks` +
        `  at ${provenance.measuredAt}`,
      );
      if (!provenance.clean) {
        console.log(`  tree is dirty; these numbers describe no commit. Uncommitted: ${provenance.dirtyFiles.join(', ')}`);
      }
      console.log(`report: ${resolve(options.out, 'report.json')}`);
    }
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((done) => server.close(done));
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
