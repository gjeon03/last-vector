/**
 * In-flight HUD for LAST VECTOR.
 *
 * Split of responsibilities:
 *  - DOM  : typography, layout, anything the player reads as *text*. Crisp, accessible.
 *  - Canvas: the vector instruments — pipper, flight-path marker, gate director, off-screen
 *    chase arrow, roll scale, proximity ring. Per-frame vector work belongs here.
 *
 * `update()` runs 60x/s. Every node reference is cached, every write is guarded by a
 * "did it actually change" check, and nothing allocates in the steady state.
 */

import type { LogLine, Telemetry } from '../core/contracts.ts';
import { FLIGHT, FLIGHT_THRESHOLDS, UI } from '../core/art.ts';
import { radioDurationSeconds } from '../core/RadioSchedule.ts';
import type { Messages, Translator } from '../i18n/index.ts';
import { LastAscentHud } from './LastAscentHud.ts';

/* ------------------------------------------------------------------ utilities */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Frame-rate independent exponential smoothing. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** Mutable eased scalar. Cheap, no allocation after construction. */
export class Eased {
  value: number;
  target: number;
  rate: number;

  constructor(initial: number, rate: number) {
    this.value = initial;
    this.target = initial;
    this.rate = rate;
  }

  step(dt: number): number {
    this.value = damp(this.value, this.target, this.rate, dt);
    return this.value;
  }

  snap(v: number): void {
    this.value = v;
    this.target = v;
  }
}

const PAD2 = (n: number): string => (n < 10 ? '0' + n : '' + n);

const BOOST_USABLE_SECONDS =
  (FLIGHT.boostCapacity * (1 - FLIGHT.boostEngageFraction)) / FLIGHT.boostDrain;
const BOOST_USABLE_LABEL = `${BOOST_USABLE_SECONDS.toFixed(1)}S`;
const BOOST_REARM_PERCENT = Math.round(FLIGHT.boostRearmFraction * 100);

/** `m:ss.cc` — the canonical run clock. */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const total = Math.floor(seconds * 100);
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000);
  return `${PAD2(m)}:${PAD2(s)}.${PAD2(cs)}`;
}

/**
 * Signed delta, e.g. `−1.24` / `+0.08`. The sign is taken from the *rounded* value, so a
 * difference too small to print does not claim a direction — `−0.004` reads `±0.00`, not
 * `−0.00`, which asserts a gain of nothing.
 */
export function formatDelta(seconds: number): string {
  const rounded = Math.round(seconds * 100) / 100;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded).toFixed(2)}`;
}

/** Metres below 10 km, kilometres above. Thin space between thousands. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '----';
  if (metres >= 10000) return (metres / 1000).toFixed(1);
  const v = Math.round(metres);
  return v >= 1000 ? `${Math.floor(v / 1000)} ${PAD3(v % 1000)}` : `${v}`;
}

export function distanceUnit(metres: number): string {
  return metres >= 10000 ? 'KM' : 'M';
}

const PAD3 = (n: number): string => (n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n);

/* --------------------------------------------------------------- dom helpers */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Restart a CSS animation on an element without touching layout twice. */
export function retrigger(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

const HUD_EN_TOKENS = [
  'VESPER TERMINUS',
  'W A S D',
  'TERMINUS',
  'Kestrel',
  'CAIRN',
] as const;

/**
 * Write mixed Korean HUD copy as inert DOM, marking only preserved English tokens. This is used
 * exclusively behind event/content guards: splitting a string creates nodes, so it must never
 * enter the 60 Hz steady-state path.
 */
function writeEnglishTokens(node: HTMLElement, text: string): void {
  node.removeAttribute('lang');
  let cursor = 0;
  let matched = false;
  const fragment = document.createDocumentFragment();

  while (cursor < text.length) {
    let nextIndex = text.length;
    let nextToken = '';
    for (const token of HUD_EN_TOKENS) {
      const index = text.indexOf(token, cursor);
      if (index >= 0 && index < nextIndex) {
        nextIndex = index;
        nextToken = token;
      }
    }
    if (!nextToken) break;
    matched = true;
    if (nextIndex > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, nextIndex)));
    const tokenNode = document.createElement('span');
    tokenNode.lang = 'en';
    tokenNode.textContent = nextToken;
    fragment.appendChild(tokenNode);
    cursor = nextIndex + nextToken.length;
  }

  if (!matched) {
    node.textContent = text;
    return;
  }
  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
  node.replaceChildren(fragment);
}

/* ------------------------------------------------------------ canvas palette */

type RGB = readonly [number, number, number];

function parseHex(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const C = {
  primary: parseHex(UI.primary),
  accent: parseHex(UI.accent),
  good: parseHex(UI.good),
  warn: parseHex(UI.warn),
  bad: parseHex(UI.bad),
  ink: parseHex(UI.ink),
} as const;

function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a < 0 ? 0 : a > 1 ? 1 : a})`;
}

function mix(a: RGB, b: RGB, t: number, out: number[]): string {
  out[0] = Math.round(lerp(a[0], b[0], t));
  out[1] = Math.round(lerp(a[1], b[1], t));
  out[2] = Math.round(lerp(a[2], b[2], t));
  return `rgb(${out[0]},${out[1]},${out[2]})`;
}

/**
 * Dark casing colour. The scene puts a blown-out cyan gate aperture, a gold armed ring and a
 * lit gas giant behind the instruments, so every vector stroke is laid over a darker, wider
 * copy of itself. That is what keeps a 1 px line readable on an emissive background, and it
 * costs one extra stroke of an already-built path.
 */
const CASING = 'rgba(2,6,13,0.8)';
const INK_SOLID = UI.ink;

/**
 * Stroke the path currently on `ctx` twice: dark casing first, then the bright line.
 * The caller owns `globalAlpha`; this only touches strokeStyle and lineWidth.
 */
function casedStroke(
  ctx: CanvasRenderingContext2D,
  colour: string,
  width: number,
  casingPad = 0,
): void {
  ctx.strokeStyle = CASING;
  ctx.lineWidth = width + (casingPad || Math.max(2.4, width * 1.1));
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke();
}

/* ------------------------------------------------------------ rolling digits */

/**
 * Odometer readout. Each cell holds a 0-9 strip translated by transform, so a value
 * change costs one style write on the digits that actually moved.
 */
export class RollingNumber {
  readonly el: HTMLElement;
  private readonly strips: HTMLElement[] = [];
  private readonly cells: HTMLElement[] = [];
  private readonly shown: number[] = [];
  private lead = -1;

  constructor(digits: number, className = 'lv-roll') {
    this.el = el('div', className);
    this.el.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < digits; i++) {
      const cell = el('span', 'lv-roll-cell');
      const strip = el('span', 'lv-roll-strip');
      for (let d = 0; d <= 9; d++) strip.appendChild(el('span', 'lv-roll-glyph', String(d)));
      cell.appendChild(strip);
      this.el.appendChild(cell);
      this.cells.push(cell);
      this.strips.push(strip);
      this.shown.push(-1);
    }
  }

  set(value: number): void {
    const n = this.strips.length;
    let v = clamp(Math.round(value), 0, Math.pow(10, n) - 1);
    let lead = n - 1;
    for (let i = n - 1; i >= 0; i--) {
      const d = v % 10;
      v = (v - d) / 10;
      if (this.shown[i] !== d) {
        this.shown[i] = d;
        this.strips[i]!.style.transform = `translate3d(0,${-d * 10}%,0)`;
      }
      if (d !== 0) lead = i;
    }
    if (lead !== this.lead) {
      for (let i = 0; i < n; i++) this.cells[i]!.classList.toggle('is-lead', i < lead);
      this.lead = lead;
    }
  }
}

/* ------------------------------------------------------------------ hud state */

/** Single reusable scratch record. Never reallocated. */
interface VecState {
  slipX: number;
  slipY: number;
  slipOn: number;
  roll: number;
  gateX: number;
  gateY: number;
  gateR: number;
  gateOn: number;
  gateAngle: number;
  gateAlign: number;
  gateDist: number;
  proximity: number;
  bore: number;
  time: number;
  alpha: number;
  reduced: boolean;
}

/* ------------------------------------------------------------------- the HUD */

export class Hud {
  readonly el: HTMLElement;

  private readonly translator: Translator;
  private readonly messages: Messages;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private cw = 1;
  private ch = 1;
  private dpr = 1;

  /* text nodes cached once */
  private readonly nSector: HTMLElement;
  private readonly nInputMode: HTMLElement;
  private readonly nFps: HTMLElement;
  private readonly nFpsFrame: HTMLElement;
  /**
   * Speed is written directly rather than through the odometer. An odometer animates each
   * digit over ~0.26 s, but airspeed changes every single frame, so the transition restarts
   * before it can ever land and the digit column sits permanently between two glyphs. The
   * rolling treatment is right for values that settle — splits, gate counts — and wrong for
   * a live instrument.
   */
  private readonly nSpeed: HTMLElement;
  private shownSpeed = -1;
  private readonly nGload: HTMLElement;
  private readonly nThrottleRow: HTMLElement;
  private readonly nThrottleFill: HTMLElement;
  private readonly nThrottleGhost: HTMLElement;
  private readonly nThrottlePct: HTMLElement;
  private readonly nBoostFill: HTMLElement;
  private readonly nBoostGhost: HTMLElement;
  private readonly nBoostRow: HTMLElement;
  private readonly nBoostCap: HTMLElement;
  private readonly nHullFill: HTMLElement;
  private readonly nHullRow: HTMLElement;
  private readonly nGateCur: RollingNumber;
  private readonly nGateTot: HTMLElement;
  private readonly nGateName: HTMLElement;
  private readonly nNextMarkerLabel: HTMLElement;
  private readonly nSplit: HTMLElement;
  private readonly nTotal: HTMLElement;
  private readonly nBest: HTMLElement;
  private readonly nSplitFeed: HTMLElement;
  private readonly nCallout: HTMLElement;
  private readonly nCalloutTitle: HTMLElement;
  private readonly nCalloutSub: HTMLElement;
  private readonly nLog: HTMLElement;
  private readonly nRail: HTMLElement;
  private readonly nRailFill: HTMLElement;
  private readonly nRailTicks: HTMLElement;
  private readonly nGateLabel: HTMLElement;
  private readonly nGateLabelDist: HTMLElement;
  private readonly nGateLabelUnit: HTMLElement;
  private readonly nProxVignette: HTMLElement;
  private readonly nImpact: HTMLElement;
  private readonly nBoostFx: HTMLElement;
  private readonly nRadio: HTMLElement;
  private readonly nRadioWho: HTMLElement;
  private readonly nRadioText: HTMLElement;
  private readonly flightReadableRegions: HTMLElement[] = [];
  private readonly escapeHud: LastAscentHud;

  /* eased values */
  private readonly eThrottle = new Eased(0, 14);
  private readonly eThrottleGhost = new Eased(0, 3.4);
  private readonly eBoost = new Eased(1, 16);
  private readonly eBoostGhost = new Eased(1, 3.2);
  private readonly eHull = new Eased(1, 9);
  private readonly eSpeed = new Eased(0, 9);
  private readonly eG = new Eased(0, 5);
  private readonly eProx = new Eased(0, 8);
  private readonly eRail = new Eased(0, 5);
  private readonly eGateR = new Eased(0, 11);
  private readonly eGateOn = new Eased(0, 12);
  private readonly eAlign = new Eased(0, 7);
  private readonly eAlpha = new Eased(0, 5);
  /* Fast: this tracks a real measured vector, so the easing is jitter suppression on the
     projection, not a stand-in for motion. Anything slower would visibly lag the truth. */
  private readonly eSlipX = new Eased(0, 26);
  private readonly eSlipY = new Eased(0, 26);
  private readonly eSlipOn = new Eased(0, 9);
  private readonly eRoll = new Eased(0, 18);

  /* change guards — avoid touching the DOM when nothing moved */
  private pThrottle = -1;
  private pThrottleGhost = -1;
  private pThrottlePct = 0;
  private pBoost = -1;
  private pBoostGhost = -1;
  private pBoostPct = 100;
  private pBoostUnavailable = false;
  private pHull = -1;
  private pHullPct = 100;
  private pHullState = '';
  private pGload = -1;
  private pSector = '';
  private pLockRefused: boolean | undefined = undefined;
  private pFps = -1;
  private pGateTot = -1;
  private pGateName = '';
  private pGateNameType = '';
  private pSplit = '';
  private pTotal = '';
  private pBest = '';
  private pCalloutId = -1;
  private pCalloutTone = '';
  private pCalloutFade = -1;
  private pSplitCount = -1;
  private pBestSplitCount = -1;
  private pSplitTotal = -1;
  private splitComparable = false;
  private pCleared = -1;
  private pRail = -1;
  private pLabelOn = false;
  private pLabelX = -9999;
  private pLabelY = -9999;
  private pLabelDist = '';
  private pLabelUnit = '';
  private pProx = -1;
  private pImpactFlash = 0;
  private pBoosting = false;
  private pRailTicks = -1;
  private pGateCur = -1;
  private pDestination = '';
  private pAlpha = -1;
  private pCalloutAriaHidden: boolean | undefined = undefined;
  private pRadioAriaHidden: boolean | undefined = undefined;
  private cleared = false;

  /* rolling feeds */
  private readonly logNodes = new Map<number, HTMLElement>();
  private readonly logPool: HTMLElement[] = [];
  private readonly logAlpha = new Map<number, number>();
  private readonly splitNodes: HTMLElement[] = [];
  private readonly splitTtl: number[] = [];

  private slipHidden = true;
  private radioTtl = 0;
  private clock = 0;
  private active = false;
  private countdownActive = false;
  private calloutOn = false;
  private radioOn = false;
  private showFps = false;
  private readonly reduced: boolean;
  private readonly mixBuf = [0, 0, 0];

  private readonly vs: VecState = {
    slipX: 0,
    slipY: 0,
    slipOn: 0,
    roll: 0,
    gateX: 0,
    gateY: 0,
    gateR: 0,
    gateOn: 0,
    gateAngle: 0,
    gateAlign: 0,
    gateDist: 0,
    proximity: 0,
    bore: 0,
    time: 0,
    alpha: 0,
    reduced: false,
  };

  constructor(translator: Translator) {
    this.translator = translator;
    this.messages = translator.messages;
    this.reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.vs.reduced = this.reduced;

    this.el = el('div', 'lv-hud');
    this.el.dataset['active'] = '0';

    this.canvas = el('canvas', 'lv-vec');
    this.canvas.setAttribute('aria-hidden', 'true');
    const ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('LAST VECTOR: 2D canvas unavailable');
    this.ctx = ctx;
    this.el.appendChild(this.canvas);

    /* ---- vignettes / full-bleed effects ---- */
    const edge = el('div', 'lv-fx lv-fx--edge');
    this.nProxVignette = el('div', 'lv-fx lv-fx--prox');
    this.nImpact = el('div', 'lv-fx lv-fx--impact');
    this.nBoostFx = el('div', 'lv-fx lv-fx--boost');
    this.el.append(edge, this.nProxVignette, this.nBoostFx, this.nImpact);

    /* ---- floating gate distance tag (follows the reticle) ---- */
    this.nGateLabel = el('div', 'lv-gatetag');
    this.nGateLabelDist = el('span', 'lv-gatetag-n', '0');
    this.nGateLabelUnit = el('span', 'lv-gatetag-u', 'M');
    this.nGateLabelDist.lang = 'en';
    this.nGateLabelUnit.lang = 'en';
    this.nGateLabel.append(this.nGateLabelDist, this.nGateLabelUnit);
    this.el.appendChild(this.nGateLabel);

    /* ---- safe frame ---- */
    const frame = el('div', 'lv-frame');
    this.el.appendChild(frame);

    /* top strip */
    const top = el('div', 'lv-top');
    this.nSector = el('div', 'lv-sector');
    this.nSector.lang = 'en';
    const fpsWrap = el('div', 'lv-fpswrap');
    this.nFpsFrame = fpsWrap;
    const fpsLabel = el('span', 'lv-fps-k', this.messages.hud.fps);
    fpsLabel.lang = 'en';
    fpsWrap.append(fpsLabel);
    this.nFps = el('span', 'lv-fps-v', '--');
    this.nFps.lang = 'en';
    fpsWrap.appendChild(this.nFps);
    /**
     * Shown only when the browser refused mouse capture. The game already raises a callout for
     * it, but a callout is transient and this condition lasts the whole run: the player needs
     * to know why the mouse is dead for as long as it is dead, not for two seconds at the start.
     */
    this.nInputMode = el('div', 'lv-inputmode', this.messages.hud.keyboardFlight);
    this.nInputMode.lang = 'en';
    this.nInputMode.dataset['on'] = '0';
    top.append(this.nSector, this.nInputMode, fpsWrap);
    frame.appendChild(top);

    /* ---- LEFT cluster: throttle / speed / bars ---- */
    const left = el('div', 'lv-left');

    this.nThrottleRow = el('div', 'lv-thr');
    const thrTrack = el('div', 'lv-thr-track');
    this.nThrottleGhost = el('div', 'lv-thr-ghost');
    this.nThrottleFill = el('div', 'lv-thr-fill');
    const thrTicks = el('div', 'lv-thr-ticks');
    for (let i = 0; i <= 8; i++) {
      const tick = el('i', i % 4 === 0 ? 'lv-thr-tick is-major' : 'lv-thr-tick');
      tick.style.setProperty('--i', String(i / 8));
      thrTicks.appendChild(tick);
    }
    thrTrack.append(this.nThrottleGhost, this.nThrottleFill, thrTicks);
    this.nThrottlePct = el('div', 'lv-thr-pct', '000');
    this.nThrottlePct.lang = 'en';
    const throttleLabel = el('div', 'lv-thr-k', this.messages.hud.throttle);
    throttleLabel.lang = 'en';
    this.nThrottleRow.append(throttleLabel, thrTrack, this.nThrottlePct);

    const speed = el('div', 'lv-speed');
    this.nSpeed = el('div', 'lv-readout lv-readout--speed', '0');
    this.nSpeed.lang = 'en';
    const speedRow = el('div', 'lv-speed-row');
    const speedUnit = el('span', 'lv-speed-u', this.messages.hud.speedUnit);
    speedUnit.lang = 'en';
    speedRow.append(this.nSpeed, speedUnit);
    this.nGload = el('div', 'lv-gload', '0.0 G');
    this.nGload.lang = 'en';
    speed.append(speedRow, this.nGload);

    const bars = el('div', 'lv-bars');
    this.nBoostRow = this.buildBoostBar();
    this.nBoostFill = this.nBoostRow.querySelector('.lv-bar-fill') as HTMLElement;
    this.nBoostGhost = this.nBoostRow.querySelector('.lv-bar-ghost') as HTMLElement;
    this.nBoostCap = this.nBoostRow.querySelector('.lv-bar-cap') as HTMLElement;
    this.nHullRow = this.buildBar(this.messages.hud.hull, 'hull');
    this.nHullFill = this.nHullRow.querySelector('.lv-bar-fill') as HTMLElement;
    this.configureMeter(this.nThrottleRow, this.messages.hud.throttle, 0);
    this.configureMeter(this.nBoostRow, null, 100);
    this.configureMeter(this.nHullRow, this.messages.hud.hull, 100);
    bars.append(this.nBoostRow, this.nHullRow);

    left.append(this.nThrottleRow, speed, bars);
    frame.appendChild(left);

    /* ---- RIGHT cluster: gate counter / timers ---- */
    const right = el('div', 'lv-right');
    const gateCount = el('div', 'lv-gatecount');
    this.nGateCur = new RollingNumber(2, 'lv-roll lv-roll--gate');
    this.nGateCur.el.lang = 'en';
    this.nGateTot = el('span', 'lv-gatecount-t', '00');
    this.nGateTot.lang = 'en';
    const gateSeparator = el('span', 'lv-gatecount-s', '/');
    gateSeparator.lang = 'en';
    gateCount.append(this.nGateCur.el, gateSeparator, this.nGateTot);
    this.nGateName = el('div', 'lv-gatename', '');

    const times = el('dl', 'lv-times');
    this.nSplit = this.buildTime(times, this.messages.hud.segment, 'is-split');
    this.nTotal = this.buildTime(times, this.messages.hud.elapsed, 'is-total');
    this.nBest = this.buildTime(times, this.messages.hud.best, 'is-best');

    this.nSplitFeed = el('ul', 'lv-splitfeed');
    this.nNextMarkerLabel = el('div', 'lv-right-k', this.messages.hud.nextMarker);
    this.nNextMarkerLabel.lang = 'en';
    right.append(this.nNextMarkerLabel, gateCount, this.nGateName, times, this.nSplitFeed);
    frame.appendChild(right);

    this.escapeHud = new LastAscentHud(this.messages);
    frame.appendChild(this.escapeHud.element);

    /* ---- centre-upper callout ---- */
    this.nCallout = el('div', 'lv-callout');
    this.nCalloutTitle = el('div', 'lv-callout-t', '');
    this.nCalloutSub = el('div', 'lv-callout-s', '');
    this.nCallout.append(this.nCalloutTitle, this.nCalloutSub);
    this.nCallout.setAttribute('role', 'status');
    this.nCallout.setAttribute('aria-live', 'polite');
    frame.appendChild(this.nCallout);

    /* ---- lower-left: comms + log ---- */
    const feed = el('div', 'lv-feed');
    this.nRadio = el('div', 'lv-radio');
    this.nRadioWho = el('span', 'lv-radio-who', '');
    this.nRadioWho.lang = 'en';
    this.nRadioText = el('span', 'lv-radio-text', '');
    const bars3 = el('span', 'lv-radio-eq');
    bars3.append(el('i'), el('i'), el('i'), el('i'));
    this.nRadio.append(bars3, this.nRadioWho, this.nRadioText);
    this.nRadio.setAttribute('role', 'status');
    this.nRadio.setAttribute('aria-live', 'polite');
    this.nLog = el('ul', 'lv-log');
    this.nLog.setAttribute('aria-live', 'polite');
    feed.append(this.nRadio, this.nLog);
    frame.appendChild(feed);

    /* ---- bottom: course rail ---- */
    this.nRail = el('div', 'lv-rail');
    const railTrack = el('div', 'lv-rail-track');
    this.nRailFill = el('div', 'lv-rail-fill');
    this.nRailTicks = el('div', 'lv-rail-ticks');
    railTrack.append(this.nRailFill, this.nRailTicks);
    const railKeys = el('div', 'lv-rail-keys');
    const railDestination = el('span', 'lv-rail-dest', this.messages.hud.terminus);
    railDestination.lang = 'en';
    const railDeparture = el('span', '', this.messages.hud.departure);
    railDeparture.lang = 'en';
    railKeys.append(railDeparture, railDestination);
    this.nRail.append(railKeys, railTrack);
    frame.appendChild(this.nRail);

    this.flightReadableRegions.push(this.nGateLabel, top, left, right, this.nLog, this.nRail);
    for (const region of this.flightReadableRegions) region.setAttribute('aria-hidden', 'true');
    this.syncCalloutAccessibility();
    this.syncRadioAccessibility();

    this.setShowFps(false);
  }

  private configureMeter(node: HTMLElement, label: string | null, percent: number): void {
    node.setAttribute('role', 'meter');
    node.setAttribute('aria-valuemin', '0');
    node.setAttribute('aria-valuemax', '100');
    if (label !== null) node.setAttribute('aria-label', label);
    node.setAttribute('aria-valuenow', String(percent));
    node.setAttribute('aria-valuetext', this.messages.hud.meterPercent(percent));
  }

  private writeDynamicText(node: HTMLElement, text: string): void {
    if (this.translator.locale === 'ko') writeEnglishTokens(node, text);
    else {
      node.removeAttribute('lang');
      node.textContent = text;
    }
  }

  private writeLegacyEnglish(node: HTMLElement, text: string): void {
    node.textContent = text;
    node.lang = 'en';
  }

  private syncCalloutAccessibility(): void {
    const hidden = !this.active || this.countdownActive || !this.calloutOn;
    if (hidden === this.pCalloutAriaHidden) return;
    this.pCalloutAriaHidden = hidden;
    if (hidden) this.nCallout.setAttribute('aria-hidden', 'true');
    else this.nCallout.removeAttribute('aria-hidden');
  }

  private syncRadioAccessibility(): void {
    const hidden = !this.radioOn;
    if (hidden === this.pRadioAriaHidden) return;
    this.pRadioAriaHidden = hidden;
    if (hidden) this.nRadio.setAttribute('aria-hidden', 'true');
    else this.nRadio.removeAttribute('aria-hidden');
  }

  private buildBar(label: string, kind: string): HTMLElement {
    const row = el('div', `lv-bar lv-bar--${kind}`);
    const track = el('div', 'lv-bar-track');
    track.append(el('div', 'lv-bar-ghost'), el('div', 'lv-bar-fill'));
    const key = el('span', 'lv-bar-k', label);
    key.lang = 'en';
    row.append(key, track);
    return row;
  }

  private buildBoostBar(): HTMLElement {
    const row = this.buildBar(this.messages.hud.boost, 'boost');
    row.dataset['usableSeconds'] = String(BOOST_USABLE_SECONDS);
    row.dataset['rearmPercent'] = String(BOOST_REARM_PERCENT);
    row.dataset['availability'] = 'available';
    const track = row.querySelector('.lv-bar-track') as HTMLElement;
    const ticks = el('div', 'lv-bar-ticks');
    ticks.setAttribute('aria-hidden', 'true');
    const engageFloor = FLIGHT.boostCapacity * FLIGHT.boostEngageFraction;
    for (let second = 1; second <= Math.floor(BOOST_USABLE_SECONDS); second++) {
      const energy = engageFloor + FLIGHT.boostDrain * second;
      const tick = el('i', 'lv-bar-tick');
      tick.style.setProperty('--i', clamp(energy / FLIGHT.boostCapacity, 0, 1).toFixed(4));
      ticks.appendChild(tick);
    }
    track.appendChild(ticks);
    const capacity = el('span', 'lv-bar-cap', BOOST_USABLE_LABEL);
    capacity.lang = 'en';
    capacity.title = this.messages.hud.boostCapacityTitle;
    row.appendChild(capacity);
    row.setAttribute('aria-label', this.messages.hud.boostUsable(BOOST_USABLE_SECONDS));
    return row;
  }

  private buildTime(parent: HTMLElement, label: string, cls: string): HTMLElement {
    const row = el('div', `lv-time ${cls}`);
    const dt = el('dt', 'lv-time-k', label);
    dt.lang = 'en';
    const dd = el('dd', 'lv-time-v', '--:--.--');
    dd.lang = 'en';
    row.append(dt, dd);
    parent.appendChild(row);
    return dd;
  }

  /* ------------------------------------------------------------------ public */

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
    this.resize();
  }

  setActive(active: boolean, dim = false): void {
    const activityChanged = active !== this.active;
    this.active = active;
    this.el.dataset['active'] = active ? '1' : '0';
    this.el.dataset['dim'] = dim ? '1' : '0';
    /* Asymmetric: ease up gently, drop away quickly. At the old symmetric rate the HUD was
       still a third visible a fifth of a second into the results screen, so a capture of the
       resolution beat caught speed and split digits ghosting under the table. */
    this.eAlpha.rate = active ? 5 : 16;
    this.eAlpha.target = active ? (dim ? 0.45 : 1) : 0;
    /**
     * Callouts opt out of the dim. `--a` eases from 0.45 to 1 across the countdown -> flying
     * boundary, which is exactly when the run's ENGAGE callout fires, so riding `--a` rendered
     * the loudest beat of the run at 45% over a blown-out gate aperture. An alert is never
     * ambient: it is either shown at full strength or not shown.
     */
    this.el.style.setProperty('--ca', active ? '1' : '0');
    if (activityChanged) {
      for (const region of this.flightReadableRegions) {
        if (active) region.removeAttribute('aria-hidden');
        else region.setAttribute('aria-hidden', 'true');
      }
    }
    this.syncCalloutAccessibility();
  }

  setShowFps(show: boolean): void {
    this.showFps = show;
    this.nFpsFrame.dataset['on'] = show ? '1' : '0';
  }

  /**
   * The countdown owns the start beat. The game also fires an ENGAGE callout on the
   * countdown -> flying edge, so without this the player gets `GO`, `VECTOR LIVE` and
   * `ENGAGE / VESPER TERMINUS` stacked up the centre of the screen at the same instant.
   * The callout is held, not dropped: it reappears the moment the countdown clears.
   */
  setCountdownActive(active: boolean): void {
    if (active === this.countdownActive) {
      this.el.dataset['countdown'] = active ? '1' : '0';
      return;
    }
    this.countdownActive = active;
    this.el.dataset['countdown'] = active ? '1' : '0';
    this.syncCalloutAccessibility();
  }

  setDestination(name: string): void {
    const dest = this.nRail.querySelector('.lv-rail-dest');
    if (dest) dest.textContent = name;
  }

  radio(speaker: string, text: string, durationBasisLength = text.length): void {
    this.nRadioWho.textContent = speaker;
    this.writeDynamicText(this.nRadioText, text);
    this.radioTtl = radioDurationSeconds(durationBasisLength);
    retrigger(this.nRadio, 'is-in');
    this.nRadio.dataset['on'] = '1';
    this.radioOn = true;
    this.syncRadioAccessibility();
  }

  resize(): void {
    const rect = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    if (w === this.cw && h === this.ch && dpr === this.dpr) return;
    this.cw = w;
    this.ch = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  dispose(): void {
    this.logNodes.clear();
    this.logAlpha.clear();
    this.el.remove();
  }

  /* ------------------------------------------------------------------ update */

  update(t: Telemetry, dt: number): void {
    const d = clamp(dt, 0, 0.1);
    this.clock += d;

    /* comms survives the HUD being off — it plays over briefings too */
    this.updateRadio(d);

    const alpha = this.eAlpha.step(d);
    const aq = Math.round(alpha * 200);
    if (aq !== this.pAlpha) {
      this.pAlpha = aq;
      this.el.style.setProperty('--a', (aq / 200).toFixed(3));
    }
    if (alpha < 0.004 && !this.active) {
      if (!this.cleared) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.cleared = true;
      }
      return;
    }
    this.cleared = false;

    this.updateText(t, d);
    this.escapeHud.update(t);
    this.updateBars(t, d);
    this.updateCallout(t, d);
    this.updateLog(t.log, d);
    this.updateSplits(t, d);
    this.updateFx(t, d);
    this.paint(t, d, alpha);
  }

  /* ---------------------------------------------------------------- sections */

  private updateText(t: Telemetry, dt: number): void {
    if (t.sectorName !== this.pSector) {
      this.pSector = t.sectorName;
      this.nSector.textContent = t.sectorName;
    }
    if (t.destinationName !== this.pDestination) {
      this.pDestination = t.destinationName;
      this.setDestination(t.destinationName);
    }
    /* Optional field: absent on older telemetry and in the standalone probe, so compare
       loosely rather than assuming it is present. */
    const refused = t.pointerLockRefused === true;
    if (refused !== this.pLockRefused) {
      this.pLockRefused = refused;
      this.nInputMode.dataset['on'] = refused ? '1' : '0';
    }

    if (this.showFps) {
      const fps = Math.round(t.fps);
      if (fps !== this.pFps) {
        this.pFps = fps;
        this.nFps.textContent = fps > 0 ? String(fps) : '--';
        this.nFpsFrame.dataset['low'] = fps > 0 && fps < 50 ? '1' : '0';
      }
    }

    /* speed odometer */
    this.eSpeed.target = t.speed;
    const speed = Math.round(this.eSpeed.step(dt));
    if (speed !== this.shownSpeed) {
      this.shownSpeed = speed;
      this.nSpeed.textContent = String(speed);
    }

    /* g-load: contract gives m/s^2 */
    this.eG.target = Math.abs(t.gLoad) / 9.80665;
    const g = this.eG.step(dt);
    const gq = Math.round(g * 10);
    if (gq !== this.pGload) {
      this.pGload = gq;
      this.nGload.textContent = `${(gq / 10).toFixed(1)} G`;
      // 35 G, not 5.5, and not a rounder number: it is a measured p90.
      //
      // The 5.5 threshold was tuned against a value that had been divided by g twice, so it read
      // about a tenth of the real load. Correcting the physics made this readout truthful and made
      // the old threshold meaningless: at 5.5 it lit for roughly three quarters of a lap. That is
      // not mistuned, it is inverted — a warning on most of the time becomes the background, and
      // the rare unlit moments become the signal. 35 lights for about a tenth of a lap.
      //
      // CORRECTION: two distributions were previously quoted here as "pre-fix" and "post-fix"
      // either side of the spine leg-index change. They were not. Both reproduce on a single
      // commit with no code change between them, so the difference was run-to-run variation, and
      // the explanation attached to it — that the geometry fix had moved the racing line — was
      // invented to fit two numbers that needed no explaining. 35 survives under both samples and
      // that part stands; the causal story did not.
      //
      // If you re-tune: take a fresh lap, and record which commit the lap came from.
      this.nGload.dataset['hot'] = gq >= 350 ? '1' : '0';
    }

    /* Gate race uses accepted splits; escape uses its typed safe-corridor count. */
    const total = Math.max(1, t.gate.total);
    const cleared = clamp(
      t.objective.kind === 'escape' ? t.objective.checkpoint : t.splits.length,
      0,
      total,
    );
    const current = Math.min(cleared + 1, total);
    const markerLabel = t.objective.kind === 'escape'
      ? this.messages.hud.safeCorridors
      : this.messages.hud.nextMarker;
    if (this.nNextMarkerLabel.textContent !== markerLabel) {
      this.nNextMarkerLabel.textContent = markerLabel;
    }
    if (current !== this.pGateCur) {
      this.pGateCur = current;
      this.nGateCur.set(current);
    }
    if (total !== this.pGateTot) {
      this.pGateTot = total;
      this.nGateTot.textContent = PAD2(total);
    }
    const gateNameType = t.gate.nameMessage?.type ?? '';
    if (t.gate.name !== this.pGateName || gateNameType !== this.pGateNameType) {
      this.pGateName = t.gate.name;
      this.pGateNameType = gateNameType;
      if (t.gate.nameMessage) {
        this.writeDynamicText(this.nGateName, this.translator.domain(t.gate.nameMessage));
        this.nGateName.lang = 'en';
      } else {
        this.nGateName.textContent = t.gate.name;
        this.nGateName.lang = 'en';
      }
      retrigger(this.nGateName, 'is-in');
    }

    /* timers */
    const splitBase = t.splits.length > 0 ? t.splits[t.splits.length - 1]! : 0;
    const splitStr = formatTime(Math.max(0, t.elapsed - splitBase));
    if (splitStr !== this.pSplit) {
      this.pSplit = splitStr;
      this.nSplit.textContent = splitStr;
    }
    const totalStr = formatTime(t.elapsed);
    if (totalStr !== this.pTotal) {
      this.pTotal = totalStr;
      this.nTotal.textContent = totalStr;
    }
    const bestStr = formatTime(t.bestTime);
    if (bestStr !== this.pBest) {
      this.pBest = bestStr;
      this.nBest.textContent = bestStr;
    }

    /* course rail */
    if (total !== this.pRailTicks) {
      this.pRailTicks = total;
      this.nRailTicks.textContent = '';
      for (let i = 0; i < total; i++) {
        const tick = el('i', 'lv-rail-tick');
        tick.style.setProperty('--i', String(total === 1 ? 1 : (i + 1) / total));
        this.nRailTicks.appendChild(tick);
      }
      this.pCleared = -1;
    }
    if (cleared !== this.pCleared) {
      this.pCleared = cleared;
      const ticks = this.nRailTicks.children;
      for (let i = 0; i < ticks.length; i++) {
        const node = ticks[i] as HTMLElement;
        node.classList.toggle('is-clear', i < cleared);
        node.classList.toggle('is-next', i === cleared);
      }
    }
    const prog =
      t.courseTotal > 0 ? clamp(1 - t.courseRemaining / t.courseTotal, 0, 1) : cleared / total;
    this.eRail.target = prog;
    const railV = this.eRail.step(dt);
    const railQ = Math.round(railV * 400);
    if (railQ !== this.pRail) {
      this.pRail = railQ;
      this.nRailFill.style.transform = `scaleX(${(railQ / 400).toFixed(4)})`;
    }
  }

  private updateBars(t: Telemetry, dt: number): void {
    this.eThrottle.target = clamp(t.throttle, 0, 1);
    this.eThrottleGhost.target = this.eThrottle.target;
    const thr = this.eThrottle.step(dt);
    const thrG = this.eThrottleGhost.step(dt);
    const q = Math.round(thr * 400);
    if (q !== this.pThrottle) {
      this.pThrottle = q;
      this.nThrottleFill.style.transform = `scaleY(${(q / 400).toFixed(4)})`;
    }
    const qg = Math.round(thrG * 400);
    if (qg !== this.pThrottleGhost) {
      this.pThrottleGhost = qg;
      this.nThrottleGhost.style.transform = `scaleY(${(qg / 400).toFixed(4)})`;
    }
    const pct = Math.round(thr * 100);
    if (pct !== this.pThrottlePct) {
      this.pThrottlePct = pct;
      this.nThrottlePct.textContent = PAD3(pct);
      this.nThrottleRow.setAttribute('aria-valuenow', String(pct));
      this.nThrottleRow.setAttribute('aria-valuetext', this.messages.hud.meterPercent(pct));
    }

    this.eBoost.target = clamp(t.energy, 0, 1);
    this.eBoostGhost.target = this.eBoost.target;
    const bo = this.eBoost.step(dt);
    const bg = this.eBoostGhost.step(dt);
    const bq = Math.round(bo * 400);
    if (bq !== this.pBoost) {
      this.pBoost = bq;
      this.nBoostFill.style.transform = `scaleX(${(bq / 400).toFixed(4)})`;
    }
    const bgq = Math.round(bg * 400);
    if (bgq !== this.pBoostGhost) {
      this.pBoostGhost = bgq;
      this.nBoostGhost.style.transform = `scaleX(${(bgq / 400).toFixed(4)})`;
    }
    const boostPct = Math.round(bo * 100);
    if (boostPct !== this.pBoostPct) {
      this.pBoostPct = boostPct;
      this.nBoostRow.setAttribute('aria-valuenow', String(boostPct));
      this.nBoostRow.setAttribute('aria-valuetext', this.messages.hud.meterPercent(boostPct));
    }
    const unavailable = t.boostLocked === true || t.energy <= 0.035;
    if (unavailable !== this.pBoostUnavailable) {
      this.pBoostUnavailable = unavailable;
      this.nBoostRow.classList.toggle('is-empty', unavailable);
      this.nBoostRow.dataset['usableSeconds'] = String(BOOST_USABLE_SECONDS);
      this.nBoostRow.dataset['rearmPercent'] = String(BOOST_REARM_PERCENT);
      this.nBoostRow.dataset['availability'] = unavailable ? 'unavailable' : 'available';
      this.nBoostCap.textContent = unavailable ? this.messages.hud.locked : BOOST_USABLE_LABEL;
      this.nBoostCap.lang = 'en';
      this.nBoostRow.setAttribute(
        'aria-label',
        unavailable
          ? this.messages.hud.boostRecharging(BOOST_REARM_PERCENT)
          : this.messages.hud.boostUsable(BOOST_USABLE_SECONDS),
      );
    }
    if (t.boosting !== this.pBoosting) {
      this.pBoosting = t.boosting;
      this.nBoostRow.classList.toggle('is-live', t.boosting);
      this.nBoostFx.dataset['on'] = t.boosting ? '1' : '0';
    }

    this.eHull.target = clamp(t.hull, 0, 1);
    const hull = this.eHull.step(dt);
    const hq = Math.round(hull * 400);
    if (hq !== this.pHull) {
      this.pHull = hq;
      this.nHullFill.style.transform = `scaleX(${(hq / 400).toFixed(4)})`;
    }
    const hullPct = Math.round(hull * 100);
    if (hullPct !== this.pHullPct) {
      this.pHullPct = hullPct;
      this.nHullRow.setAttribute('aria-valuenow', String(hullPct));
      this.nHullRow.setAttribute('aria-valuetext', this.messages.hud.meterPercent(hullPct));
    }
    const state = hull < 0.3 ? 'crit' : hull < 0.65 ? 'warn' : 'ok';
    if (state !== this.pHullState) {
      this.pHullState = state;
      this.nHullRow.dataset['state'] = state;
    }
  }

  private updateCallout(t: Telemetry, _dt: number): void {
    const c = t.callout;
    if (!c) {
      if (this.pCalloutId !== -1) {
        this.pCalloutId = -1;
        this.nCallout.dataset['on'] = '0';
        this.calloutOn = false;
        this.syncCalloutAccessibility();
      }
      return;
    }
    if (c.id !== this.pCalloutId) {
      this.pCalloutId = c.id;
      if (c.titleMessage) {
        this.writeDynamicText(this.nCalloutTitle, this.translator.domain(c.titleMessage));
        this.nCalloutTitle.lang = 'en';
      } else {
        this.writeLegacyEnglish(this.nCalloutTitle, c.title);
      }
      const sub = c.subMessage ? this.translator.domain(c.subMessage) : c.sub;
      if (c.subMessage) {
        this.writeDynamicText(this.nCalloutSub, sub ?? '');
        if (c.subMessage.type === 'callout-sub.gate-progress') this.nCalloutSub.lang = 'en';
      } else this.writeLegacyEnglish(this.nCalloutSub, sub ?? '');
      this.nCalloutSub.dataset['on'] = sub ? '1' : '0';
      if (c.tone !== this.pCalloutTone) {
        this.pCalloutTone = c.tone;
        this.nCallout.dataset['tone'] = c.tone;
      }
      this.nCallout.dataset['on'] = '1';
      this.calloutOn = true;
      this.syncCalloutAccessibility();
      retrigger(this.nCallout, 'is-in');
      this.pCalloutFade = -1;
    }
    const fade = clamp(c.ttl / 0.45, 0, 1);
    const fq = Math.round(fade * 20);
    if (fq !== this.pCalloutFade) {
      this.pCalloutFade = fq;
      this.nCallout.style.setProperty('--f', (fq / 20).toFixed(2));
    }
  }

  private updateLog(lines: LogLine[], _dt: number): void {
    /* structural reconcile only when the id set changed */
    let structural = lines.length !== this.logNodes.size;
    if (!structural) {
      for (let i = 0; i < lines.length; i++) {
        if (!this.logNodes.has(lines[i]!.id)) {
          structural = true;
          break;
        }
      }
    }

    if (structural) {
      /* drop nodes whose line is gone */
      for (const [id, node] of this.logNodes) {
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.id === id) {
            found = true;
            break;
          }
        }
        if (!found) {
          node.remove();
          this.logNodes.delete(id);
          this.logAlpha.delete(id);
          if (this.logPool.length < 12) this.logPool.push(node);
        }
      }
      /* add + order */
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let node = this.logNodes.get(line.id);
        if (!node) {
          node = this.logPool.pop() ?? el('li', 'lv-log-line');
          node.className = 'lv-log-line';
          if (!line.message) {
            this.writeLegacyEnglish(node, line.text);
          } else if (line.message.type === 'log.pointer-lock-refused') {
            node.removeAttribute('lang');
            node.textContent = this.translator.domain(line.message);
          } else {
            this.writeDynamicText(node, this.translator.domain(line.message));
            node.lang = 'en';
          }
          node.dataset['tone'] = line.tone;
          this.logNodes.set(line.id, node);
          this.nLog.appendChild(node);
          retrigger(node, 'is-in');
          this.logAlpha.set(line.id, -1);
        } else if (this.nLog.children[i] !== node) {
          this.nLog.appendChild(node);
        }
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const node = this.logNodes.get(line.id);
      if (!node) continue;
      const recency = lines.length - 1 - i;
      /* Floors raised for the graded plate: at 0.12 an aged line was invisible over lit
         nebula, which made the feed look broken rather than fading. */
      const byAge = clamp(1 - (line.age - 3.4) / 2.2, 0.34, 1);
      const byDepth = clamp(1 - recency * 0.14, 0.48, 1);
      const a = Math.round(byAge * byDepth * 20);
      if (a !== this.logAlpha.get(line.id)) {
        this.logAlpha.set(line.id, a);
        node.style.opacity = (a / 20).toFixed(2);
      }
    }
  }

  private updateSplits(t: Telemetry, dt: number): void {
    if (t.bestSplits.length !== this.pBestSplitCount || t.gate.total !== this.pSplitTotal) {
      this.pBestSplitCount = t.bestSplits.length;
      this.pSplitTotal = t.gate.total;
      this.splitComparable =
        t.gate.total > 0 &&
        t.bestSplits.length === t.gate.total &&
        t.bestSplits.every((split) => Number.isFinite(split) && split >= 0);
      this.nSplitFeed.dataset['delta'] = this.splitComparable ? '1' : '0';
    }
    if (this.pSplitCount === -1) this.pSplitCount = t.splits.length;
    if (t.splits.length > this.pSplitCount) {
      for (let i = this.pSplitCount; i < t.splits.length; i++) {
        const prev = i > 0 ? t.splits[i - 1]! : 0;
        const seg = t.splits[i]! - prev;
        const node = el('li', 'lv-splitfeed-row');
        const splitIndex = el('span', 'lv-splitfeed-i', PAD2(i + 1));
        const splitTime = el('span', 'lv-splitfeed-t', formatTime(t.splits[i]!));
        /* Unsigned. This is a leg duration, which cannot be negative, so a leading "+"
           reads as a delta and tells a player they are down time they may in fact be up.
           The results table prints the identical quantity unsigned; these must agree. */
        const splitDuration = el('span', 'lv-splitfeed-d', seg.toFixed(2));
        splitIndex.lang = 'en';
        splitTime.lang = 'en';
        splitDuration.lang = 'en';
        node.append(splitIndex, splitTime, splitDuration);
        if (this.splitComparable) {
          const bestPrev = i > 0 ? t.bestSplits[i - 1]! : 0;
          const bestSeg = t.bestSplits[i]! - bestPrev;
          if (Number.isFinite(bestSeg) && bestSeg >= 0) {
            const delta = seg - bestSeg;
            const splitDelta = el('span', 'lv-splitfeed-dlt');
            this.writeDynamicText(
              splitDelta,
              this.messages.results.splitDelta(formatDelta(delta)),
            );
            splitDelta.lang = 'en';
            splitDelta.dataset['tone'] =
              Math.round(delta * 100) === 0 ? 'flat' : delta < 0 ? 'good' : 'bad';
            node.appendChild(splitDelta);
          }
        }
        this.nSplitFeed.appendChild(node);
        retrigger(node, 'is-in');
        this.splitNodes.push(node);
        this.splitTtl.push(3.6);
      }
      this.pSplitCount = t.splits.length;
    } else if (t.splits.length < this.pSplitCount) {
      this.pSplitCount = t.splits.length;
    }

    for (let i = this.splitTtl.length - 1; i >= 0; i--) {
      this.splitTtl[i] = this.splitTtl[i]! - dt;
      if (this.splitTtl[i]! <= 0) {
        const node = this.splitNodes[i]!;
        if (!node.classList.contains('is-out')) node.classList.add('is-out');
        if (this.splitTtl[i]! < -0.5) {
          node.remove();
          this.splitNodes.splice(i, 1);
          this.splitTtl.splice(i, 1);
        }
      }
    }
  }

  private updateRadio(dt: number): void {
    if (this.radioTtl <= 0) return;
    this.radioTtl -= dt;
    if (this.radioTtl <= 0) {
      this.nRadio.dataset['on'] = '0';
      this.radioOn = false;
      this.syncRadioAccessibility();
    }
  }

  private updateFx(t: Telemetry, dt: number): void {
    this.eProx.target = clamp(t.proximity, 0, 1);
    const prox = this.eProx.step(dt);
    const pq = Math.round(prox * 50);
    if (pq !== this.pProx) {
      this.pProx = pq;
      this.nProxVignette.style.setProperty('--p', (pq / 50).toFixed(2));
      this.nProxVignette.dataset['crit'] = prox > 0.72 ? '1' : '0';
    }
    /* Explicit impact signal. The old heuristic watched `hull` fall frame to frame, which
       missed a glancing contact that cost no hull and misfired whenever the value was
       re-clamped. `impactFlash` spikes on the strike and decays on its own, so the pulse is
       retriggered on the leading edge only. */
    if (t.impactFlash > 0.05 && this.pImpactFlash <= 0.05) {
      retrigger(this.nImpact, 'is-hit');
      this.nImpact.style.setProperty('--i', clamp(t.impactFlash, 0.35, 1).toFixed(2));
    }
    this.pImpactFlash = t.impactFlash;
  }

  /* ----------------------------------------------------------- canvas layer */

  private paint(t: Telemetry, dt: number, alpha: number): void {
    /*
     * No per-frame layout read. `resize()` calls getBoundingClientRect *before* its own
     * early-out, so calling it every frame forced a style and layout flush on a dirty tree —
     * profiled at 220.7 us a frame, 16% of the CPU budget and 5x the largest three.js entry,
     * for a value that almost never changes. Size changes already arrive through the window
     * resize listener and the ResizeObserver in Overlay. The one thing neither catches is a
     * density change with no size change — dragging the window to a different display — and
     * reading devicePixelRatio costs nothing because it forces no layout.
     */
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    if (dpr !== this.dpr) this.resize();
    const ctx = this.ctx;
    const w = this.cw;
    const h = this.ch;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (alpha <= 0.01) return;

    const vs = this.vs;
    vs.time = this.clock;
    vs.alpha = alpha;

    /* --- attitude ---
     * Roll only. There is no horizon out here for a pitch ladder to reference. */
    this.eRoll.target = t.roll;
    vs.roll = this.eRoll.step(dt);

    /* --- flight-path marker ---
     * The real projected velocity vector, not an approximation of one. The gap between this
     * and the pipper is the drift the flight model is actually producing. Below a few m/s the
     * vector is meaningless and `onScreen` goes false, so the marker is hidden rather than
     * pinned to centre — a marker sitting dead centre would be a claim, and a false one. */
    const va = t.velocityAnchor;
    this.eSlipOn.target = va.onScreen ? 1 : 0;
    vs.slipOn = this.eSlipOn.step(dt);
    if (va.onScreen) {
      if (this.slipHidden) {
        /* Snap on reacquire: easing in from wherever it was last visible would fly the marker
           across the screen on a value that was never real. */
        this.eSlipX.snap(va.x);
        this.eSlipY.snap(va.y);
        this.slipHidden = false;
      } else {
        this.eSlipX.target = va.x;
        this.eSlipY.target = va.y;
      }
    } else {
      this.slipHidden = true;
    }
    vs.slipX = this.eSlipX.step(dt);
    vs.slipY = this.eSlipY.step(dt);

    /* --- gate director --- */
    const gate = t.gate;
    this.eGateOn.target = gate.anchor.onScreen ? 1 : 0;
    vs.gateOn = this.eGateOn.step(dt);
    vs.gateAngle = gate.anchor.angle;
    vs.gateDist = gate.distance;
    this.eAlign.target = clamp(gate.alignment, 0, 1);
    vs.gateAlign = this.eAlign.step(dt);

    /* Upper clamp is 0.26h, not 0.34h: past that the brackets stop reading as a reticle and
       start reading as four unrelated corner marks parked near the screen edges. */
    const targetR = clamp((140 / Math.max(gate.distance, 60)) * h * 0.62, h * 0.022, h * 0.26);
    this.eGateR.target = targetR;
    vs.gateR = this.eGateR.step(dt);
    vs.gateX = w * 0.5 + gate.anchor.x * w * 0.5;
    vs.gateY = h * 0.5 - gate.anchor.y * h * 0.5;
    vs.proximity = this.eProx.value;

    const dx = vs.gateX - w * 0.5;
    const dy = vs.gateY - h * 0.5;
    const boreR = Math.sqrt(dx * dx + dy * dy);
    vs.bore = gate.anchor.onScreen ? clamp(1 - boreR / (h * 0.055), 0, 1) : 0;

    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this.drawRollArc(ctx, w, h, vs);
    this.drawProximity(ctx, w, h, vs);
    if (vs.gateOn > 0.01) this.drawGateReticle(ctx, vs, Math.min(w, h));
    if (vs.gateOn < 0.99) this.drawChaseArrow(ctx, w, h, vs);
    this.drawFlightMarker(ctx, w, h, vs);
    this.drawPipper(ctx, w, h, vs);

    ctx.globalAlpha = 1;
    this.placeGateTag(w, h, vs, gate.anchor.onScreen);
  }

  /** Compact roll scale sat above the pipper. Reads as part of the sight, not a horizon line. */
  private drawRollArc(ctx: CanvasRenderingContext2D, w: number, h: number, vs: VecState): void {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const vmin = Math.min(w, h);
    const r = vmin * 0.152;
    const span = 0.78;

    ctx.save();

    ctx.globalAlpha = vs.alpha * 0.3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2 - span, -Math.PI / 2 + span);
    casedStroke(ctx, INK_SOLID, 1, 2.4);

    for (let i = -3; i <= 3; i++) {
      const a = -Math.PI / 2 + (i / 3) * span;
      const major = i === 0 || Math.abs(i) === 3;
      const len = major ? vmin * 0.014 : vmin * 0.008;
      ctx.globalAlpha = vs.alpha * (major ? 0.72 : 0.42);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * (r + len), cy + Math.sin(a) * (r + len));
      casedStroke(ctx, INK_SOLID, 1.4, 2.6);
    }

    const pa = -Math.PI / 2 + clamp(vs.roll, -span, span);
    const px = cx + Math.cos(pa) * (r - vmin * 0.003);
    const py = cy + Math.sin(pa) * (r - vmin * 0.003);
    const s = vmin * 0.0095;
    ctx.globalAlpha = vs.alpha;
    ctx.translate(px, py);
    ctx.rotate(pa + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.9);
    ctx.lineTo(s * 0.78, s * 0.55);
    ctx.lineTo(-s * 0.78, s * 0.55);
    ctx.closePath();
    ctx.strokeStyle = CASING;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = rgba(C.primary, 0.95);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Proximity: a tight ring that closes on the sight. The heavy lifting is done by the DOM
   * edge vignette — a big ring across the view just reads as clutter.
   */
  private drawProximity(ctx: CanvasRenderingContext2D, w: number, h: number, vs: VecState): void {
    const p = vs.proximity;
    if (p < 0.03) return;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const vmin = Math.min(w, h);
    const pulse = this.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(vs.time * (5 + p * 9));
    const r = vmin * (0.088 - p * 0.014);
    const col = mix(C.warn, C.bad, clamp((p - 0.3) / 0.5, 0, 1), this.mixBuf);
    ctx.save();
    ctx.globalAlpha = vs.alpha * clamp(p, 0, 1) * (0.42 + pulse * 0.5);
    const lw = Math.max(1.6, vmin * 0.0026);
    const seg = 4;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2 + 0.34;
      const a1 = a0 + (Math.PI * 2) / seg - 0.68;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a1);
      casedStroke(ctx, col, lw);
    }
    ctx.restore();
  }

  /**
   * Gate director. One shape language only: four brackets that track the gate's true angular
   * size, plus an acquisition diamond while it is still too far to have any size at all.
   */
  private drawGateReticle(ctx: CanvasRenderingContext2D, vs: VecState, vmin: number): void {
    const r = vs.gateR;
    const near = clamp(1 - vs.gateDist / FLIGHT_THRESHOLDS.gateReticleRange, 0, 1);
    /**
     * White, not amber. An armed cairn renders as a hot gold ring and its aperture blows out
     * to cyan at close range, so amber-on-gold and amber-on-cyan both vanish exactly when the
     * player is on the approach and needs the director most. Alignment is now signalled by
     * stroke weight plus the amber arc, never by tinting the brackets themselves.
     */
    const col = mix(C.ink, C.primary, 0.35 - vs.gateAlign * 0.25, this.mixBuf);
    const a = vs.alpha * vs.gateOn;
    const small = vmin * 0.05;

    ctx.save();
    ctx.translate(vs.gateX, vs.gateY);
    ctx.globalAlpha = a;

    if (r < small) {
      /* far: a fixed-size acquisition diamond keeps the target findable at a glance */
      const d = vmin * 0.016;
      ctx.beginPath();
      ctx.moveTo(0, -d);
      ctx.lineTo(d, 0);
      ctx.lineTo(0, d);
      ctx.lineTo(-d, 0);
      ctx.closePath();
      casedStroke(ctx, col, 1.8);
      /* same bracket language as the near reticle, just fixed-size */
      const br = d * 2.15;
      const arm = d * 0.5;
      ctx.globalAlpha = a * 0.75;
      for (let i = 0; i < 4; i++) {
        const sx = i === 0 || i === 3 ? -1 : 1;
        const sy = i < 2 ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(sx * br, sy * (br - arm));
        ctx.lineTo(sx * br, sy * br);
        ctx.lineTo(sx * (br - arm), sy * br);
        casedStroke(ctx, col, 1.5);
      }
    } else {
      const br = r * (1.2 - near * 0.14);
      const arm = r * (0.4 - near * 0.24) + vmin * 0.006;
      const lw = Math.max(1.8, Math.min(r * 0.03, vmin * 0.006)) * (1 + vs.gateAlign * 0.45);
      for (let i = 0; i < 4; i++) {
        const sx = i === 0 || i === 3 ? -1 : 1;
        const sy = i < 2 ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(sx * br, sy * (br - arm));
        ctx.lineTo(sx * br, sy * br);
        ctx.lineTo(sx * (br - arm), sy * br);
        casedStroke(ctx, col, lw);
      }

      /* Alignment: a short arc under the reticle, grouped with the range readout. Kept off
         the top so it never fights the roll scale, and radius-capped so a gate filling the
         frame does not sweep a 900 px arc across the lower third. */
      const ar = Math.min(br * 1.13, vmin * 0.17);
      const aw = Math.max(1.5, Math.min(r * 0.022, vmin * 0.0045));
      ctx.beginPath();
      ctx.arc(0, 0, ar, Math.PI * 0.26, Math.PI * 0.74);
      casedStroke(ctx, rgba(C.ink, 0.16), aw);
      ctx.beginPath();
      ctx.arc(
        0,
        0,
        ar,
        Math.PI * 0.5 - Math.PI * 0.24 * vs.gateAlign,
        Math.PI * 0.5 + Math.PI * 0.24 * vs.gateAlign,
      );
      casedStroke(ctx, rgba(C.accent, 0.95), aw);
    }

    ctx.restore();
  }

  /**
   * Off-screen chase arrow — the single most important readability element (Q5). One head,
   * big and amber and pulsing. It previously trailed a runway of chevrons; they were cut
   * because the head already reads at a glance and the runway carried nothing the head did
   * not. The range readout beside it is the second signal.
   */
  private drawChaseArrow(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    vs: VecState,
  ): void {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const vmin = Math.min(w, h);
    const a = vs.gateAngle;
    const ax = cx + Math.cos(a) * Math.min(w * 0.375, vmin * 0.58);
    const ay = cy - Math.sin(a) * Math.min(h * 0.375, vmin * 0.58);
    const vis = vs.alpha * (1 - vs.gateOn);
    if (vis <= 0.01) return;

    const pulse = this.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(vs.time * 4.4);
    const s = vmin * 0.033 * (1 + pulse * 0.1);

    ctx.save();
    ctx.globalAlpha = vis;

    /* soft scrim so amber-on-nebula still reads */
    const grad = ctx.createRadialGradient(ax, ay, s * 0.6, ax, ay, s * 2.6);
    grad.addColorStop(0, 'rgba(3,7,14,0.44)');
    grad.addColorStop(1, 'rgba(3,7,14,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(ax, ay, s * 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(ax, ay);
    ctx.rotate(-a);

    /* head */
    ctx.globalAlpha = vis;
    ctx.fillStyle = rgba(C.accent, 0.96);
    ctx.beginPath();
    ctx.moveTo(s * 1.05, 0);
    ctx.lineTo(-s * 0.5, -s * 0.8);
    ctx.lineTo(-s * 0.14, 0);
    ctx.lineTo(-s * 0.5, s * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(3,7,14,0.9)';
    ctx.lineWidth = Math.max(1, s * 0.07);
    ctx.lineJoin = 'miter';
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Flight-path marker: where the ship is actually going. Positioned by the same NDC mapping
   * as the gate director, so the on-screen gap between this and the pipper is the real drift
   * angle rather than a scaled stand-in for it.
   */
  private drawFlightMarker(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    vs: VecState,
  ): void {
    if (vs.slipOn <= 0.01) return;
    const vmin = Math.min(w, h);
    const x = w * 0.5 + vs.slipX * w * 0.5;
    const y = h * 0.5 - vs.slipY * h * 0.5;
    const r = vmin * 0.0125;

    ctx.save();
    ctx.globalAlpha = vs.alpha * 0.9 * vs.slipOn;
    const lw = Math.max(1.4, vmin * 0.0018);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    casedStroke(ctx, rgba(C.primary, 0.95), lw);
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.lineTo(x - r * 2.15, y);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + r * 2.15, y);
    ctx.moveTo(x, y - r);
    ctx.lineTo(x, y - r * 1.9);
    casedStroke(ctx, rgba(C.primary, 0.95), lw);
    ctx.restore();
  }

  /** Fixed boresight. Tiny by design — the centre of the screen stays clear. */
  private drawPipper(ctx: CanvasRenderingContext2D, w: number, h: number, vs: VecState): void {
    const cx = w * 0.5;
    const cy = h * 0.5;
    const vmin = Math.min(w, h);
    const r = vmin * 0.0055;
    const locked = vs.bore;

    ctx.save();
    ctx.globalAlpha = vs.alpha * (0.62 + locked * 0.38);
    /* White core, never amber: the pipper sits dead centre, which is exactly where a lit gate
       aperture ends up on the approach. Lock is signalled by the ring, not by a hue swap. */
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = CASING;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = INK_SOLID;
    ctx.fill();

    const g0 = vmin * 0.014;
    const g1 = vmin * 0.024;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + dx * g0, cy + dy * g0);
      ctx.lineTo(cx + dx * g1, cy + dy * g1);
      casedStroke(ctx, INK_SOLID, 1.2, 2.4);
    }

    if (locked > 0.02) {
      ctx.globalAlpha = vs.alpha * locked;
      ctx.beginPath();
      ctx.arc(cx, cy, vmin * 0.0285, 0, Math.PI * 2);
      casedStroke(ctx, rgba(C.accent, 0.95), 1.6);
    }
    ctx.restore();
  }

  /** Crisp DOM label welded to whichever director is live. */
  private placeGateTag(w: number, h: number, vs: VecState, onScreen: boolean): void {
    const vmin = Math.min(w, h);
    let x: number;
    let y: number;
    if (onScreen) {
      x = vs.gateX;
      y = vs.gateY + Math.max(vs.gateR * 1.2, vmin * 0.026) + vmin * 0.026;
    } else {
      /* Set just inside the arrow head, on the same bearing, so head + range read as one
         object. With the chevrons gone this readout is the arrow's only second signal. */
      const cx = w * 0.5;
      const cy = h * 0.5;
      const rx = Math.min(w * 0.375, vmin * 0.58) - vmin * 0.058;
      const ry = Math.min(h * 0.375, vmin * 0.58) - vmin * 0.058;
      x = cx + Math.cos(vs.gateAngle) * rx;
      y = cy - Math.sin(vs.gateAngle) * ry + vmin * 0.048;
    }
    x = clamp(x, w * 0.06, w * 0.94);
    y = clamp(y, h * 0.08, h * 0.9);

    const qx = Math.round(x);
    const qy = Math.round(y);
    if (qx !== this.pLabelX || qy !== this.pLabelY) {
      this.pLabelX = qx;
      this.pLabelY = qy;
      this.nGateLabel.style.transform = `translate3d(${qx}px,${qy}px,0) translate(-50%,-50%)`;
    }
    const dist = formatDistance(vs.gateDist);
    if (dist !== this.pLabelDist) {
      this.pLabelDist = dist;
      this.nGateLabelDist.textContent = dist;
    }
    const unit = distanceUnit(vs.gateDist);
    if (unit !== this.pLabelUnit) {
      this.pLabelUnit = unit;
      this.nGateLabelUnit.textContent = unit;
    }
    if (onScreen !== this.pLabelOn) {
      this.pLabelOn = onScreen;
      this.nGateLabel.dataset['off'] = onScreen ? '0' : '1';
    }
  }
}
