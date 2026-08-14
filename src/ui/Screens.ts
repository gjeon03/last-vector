/**
 * Full-screen interface states for LAST VECTOR: title, briefing, countdown, pause,
 * settings, controls and results.
 *
 * Every screen sits over the live 3D scene, so nothing here uses an opaque panel — depth
 * comes from gradients, hairlines and local scrims. Navigation is real DOM focus, so the
 * keyboard path and the pointer path are the same path.
 */

import type { HudHost, QualityLevel, RunResult, Settings } from '../core/contracts.ts';
import { FICTION } from '../core/art.ts';
import { clamp, el, formatDelta, formatTime, retrigger } from './Hud.ts';

export type ScreenView =
  | 'none'
  | 'title'
  | 'briefing'
  | 'countdown'
  | 'pause'
  | 'settings'
  | 'controls'
  | 'results';

export type UiSound = 'hover' | 'click' | 'back' | 'move';

/** Original pre-run fiction. Short: the visuals carry the mood. */
const BRIEF_LINES: readonly string[] = [
  'ACHRA is going out. Every hour it sheds another kilometre of shelf ice and tumbling iron across the only corridor anything hull-sized can still survive.',
  'The cairns answer a hail — nine of them, set by hands that stopped setting things a long time ago. They are the line.',
  'Fly them in order. Do not trust the quiet between them, and do not slow for anything that is not a marker.',
];

interface ControlRow {
  /**
   * Alternative bindings for one verb. Keys inside a group are a set ("W / S"); separate
   * groups are alternatives and render with an "or" between them ("SHIFT or LMB").
   */
  readonly groups: readonly (readonly string[])[];
  readonly action: string;
  /** Also shown in the briefing primer. Flagged per row so reordering cannot silently change it. */
  readonly primer?: boolean;
}

/**
 * Authoritative bindings, mirrored from src/core/Input.ts. Boost and brake are the two verbs
 * the game is actually about, so they lead the primer alongside steering and throttle.
 */
const CONTROLS: readonly ControlRow[] = [
  { groups: [['MOUSE']], action: 'Steer — virtual stick, self-centring', primer: true },
  { groups: [['W', 'S']], action: 'Throttle up / down', primer: true },
  { groups: [['A', 'D']], action: 'Roll left / right', primer: true },
  { groups: [['SHIFT'], ['LMB']], action: 'Boost', primer: true },
  { groups: [['SPACE'], ['RMB']], action: 'Brake and drift', primer: true },
  { groups: [['Q', 'E']], action: 'Strafe left / right' },
  { groups: [['R', 'F']], action: 'Strafe up / down' },
  { groups: [['↑', '↓', '←', '→']], action: 'Pitch / yaw without the mouse' },
  { groups: [['ESC']], action: 'Pause' },
  { groups: [['N']], action: 'Restart the run' },
];

/** Key chips for one binding row, shared by the CONTROLS legend and the briefing primer. */
function keyChips(row: ControlRow): HTMLElement {
  const wrap = el('span', 'lv-key-keys');
  for (let g = 0; g < row.groups.length; g++) {
    if (g > 0) wrap.appendChild(el('span', 'lv-key-or', 'or'));
    const group = row.groups[g]!;
    for (let k = 0; k < group.length; k++) wrap.appendChild(el('kbd', '', group[k]!));
  }
  return wrap;
}

/* -------------------------------------------------------------- settings map */

type RowSpec =
  | {
      kind: 'enum';
      key: keyof Settings;
      label: string;
      hint: string;
      options: readonly (readonly [string, string])[];
    }
  | {
      kind: 'range';
      key: keyof Settings;
      label: string;
      hint: string;
      min: number;
      max: number;
      step: number;
      fmt: (v: number) => string;
    }
  | { kind: 'bool'; key: keyof Settings; label: string; hint: string };

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const mult = (v: number): string => `${v.toFixed(2)}×`;
const deg = (v: number): string => `${Math.round(v)}°`;

const SETTING_GROUPS: readonly { title: string; rows: readonly RowSpec[] }[] = [
  {
    title: 'FLIGHT',
    rows: [
      {
        kind: 'enum',
        key: 'assistLevel',
        label: 'Flight assist',
        hint: 'How much the avionics damp your inputs.',
        options: [
          ['arcade', 'ARCADE'],
          ['standard', 'STANDARD'],
          ['raw', 'RAW'],
        ],
      },
      {
        kind: 'range',
        key: 'mouseSensitivity',
        label: 'Mouse sensitivity',
        hint: '',
        min: 0.2,
        max: 3,
        step: 0.05,
        fmt: mult,
      },
      { kind: 'bool', key: 'invertY', label: 'Invert pitch', hint: '' },
      {
        kind: 'range',
        key: 'fov',
        label: 'Field of view',
        hint: 'Wider reads faster, narrower reads further.',
        min: 60,
        max: 110,
        step: 1,
        fmt: deg,
      },
      {
        kind: 'range',
        key: 'cameraShake',
        label: 'Camera shake',
        hint: '',
        min: 0,
        max: 2,
        step: 0.05,
        fmt: mult,
      },
    ],
  },
  {
    title: 'DISPLAY',
    rows: [
      {
        kind: 'enum',
        key: 'quality',
        label: 'Quality',
        hint: '',
        options: [
          ['low', 'LOW'],
          ['medium', 'MED'],
          ['high', 'HIGH'],
          ['ultra', 'ULTRA'],
        ],
      },
      {
        kind: 'range',
        key: 'renderScale',
        label: 'Render scale',
        hint: 'Internal resolution. Drop it before you drop quality.',
        min: 0.5,
        max: 1,
        step: 0.05,
        fmt: pct,
      },
      { kind: 'bool', key: 'showFps', label: 'Frame counter', hint: '' },
    ],
  },
  {
    title: 'IMAGE',
    rows: [
      { kind: 'bool', key: 'motionBlur', label: 'Motion blur', hint: '' },
      { kind: 'bool', key: 'filmGrain', label: 'Film grain', hint: '' },
      { kind: 'bool', key: 'chromaticAberration', label: 'Chromatic aberration', hint: '' },
    ],
  },
  {
    title: 'AUDIO',
    rows: [
      {
        kind: 'range',
        key: 'masterVolume',
        label: 'Master',
        hint: '',
        min: 0,
        max: 1,
        step: 0.01,
        fmt: pct,
      },
      {
        kind: 'range',
        key: 'musicVolume',
        label: 'Score',
        hint: '',
        min: 0,
        max: 1,
        step: 0.01,
        fmt: pct,
      },
    ],
  },
];

/* -------------------------------------------------------------------- screens */

export interface ScreensOptions {
  onSettingChanged(): void;
  onSound(kind: UiSound): void;
  /** Asked when the player leaves settings/controls, to decide where to go back to. */
  onBack(): void;
}

export class Screens {
  readonly el: HTMLElement;

  private readonly host: HudHost;
  private readonly opts: ScreensOptions;
  private readonly views = new Map<ScreenView, HTMLElement>();
  private view: ScreenView = 'none';

  private readonly nCountNum: HTMLElement;
  private readonly nCountRing: SVGCircleElement;
  private readonly nCountLabel: HTMLElement;
  private readonly nResultBody: HTMLElement;
  private readonly nSettingsBody: HTMLElement;
  private readonly settingNodes: {
    row: RowSpec;
    apply(value: unknown): void;
  }[] = [];

  private navItems: HTMLElement[] = [];
  private navIndex = 0;
  private lastCountdown: number | null = null;

  constructor(host: HudHost, opts: ScreensOptions) {
    this.host = host;
    this.opts = opts;
    this.el = el('div', 'lv-screens');

    this.el.appendChild(this.buildTitle());
    this.el.appendChild(this.buildBriefing());

    const count = this.buildCountdown();
    this.nCountNum = count.num;
    this.nCountRing = count.ring;
    this.nCountLabel = count.label;
    this.el.appendChild(count.view);

    this.el.appendChild(this.buildPause());

    const settings = this.buildSettings();
    this.nSettingsBody = settings.body;
    this.el.appendChild(settings.view);

    this.el.appendChild(this.buildControls());

    const results = this.buildResults();
    this.nResultBody = results.body;
    this.el.appendChild(results.view);

    this.el.addEventListener('pointerover', this.onPointerOver, { passive: true });
  }

  /* --------------------------------------------------------------- lifecycle */

  mount(parent: HTMLElement): void {
    parent.appendChild(this.el);
  }

  dispose(): void {
    this.el.removeEventListener('pointerover', this.onPointerOver);
    this.el.remove();
  }

  current(): ScreenView {
    return this.view;
  }

  show(view: ScreenView): void {
    if (view === this.view) return;
    const prev = this.views.get(this.view);
    if (prev) {
      prev.dataset['open'] = '0';
      prev.setAttribute('aria-hidden', 'true');
    }
    this.view = view;
    const next = this.views.get(view);
    if (!next) {
      this.navItems = [];
      return;
    }
    if (view === 'settings') this.syncSettings();
    next.dataset['open'] = '1';
    next.removeAttribute('aria-hidden');
    retrigger(next, 'is-in');
    this.collectNav(next);
    this.focusNav(0, false);
  }

  /* -------------------------------------------------------------- navigation */

  private collectNav(root: HTMLElement): void {
    const found = root.querySelectorAll<HTMLElement>('[data-nav]');
    this.navItems.length = 0;
    for (let i = 0; i < found.length; i++) {
      const node = found[i]!;
      if (node.dataset['disabled'] !== '1') this.navItems.push(node);
    }
    this.navIndex = 0;
  }

  private focusNav(index: number, sound = true): void {
    if (this.navItems.length === 0) return;
    const n = this.navItems.length;
    this.navIndex = ((index % n) + n) % n;
    const node = this.navItems[this.navIndex]!;
    node.focus({ preventScroll: true });
    if (sound) this.opts.onSound('move');
  }

  private onPointerOver = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>('[data-nav]');
    if (!item) return;
    const idx = this.navItems.indexOf(item);
    if (idx >= 0 && idx !== this.navIndex) {
      this.navIndex = idx;
      item.focus({ preventScroll: true });
      this.opts.onSound('hover');
    }
  };

  /** Returns true when the key was consumed by the interface. */
  handleKey(ev: KeyboardEvent): boolean {
    if (this.view === 'none' || this.view === 'countdown') return false;
    const key = ev.key;
    const active = document.activeElement as HTMLElement | null;
    const isRange = active instanceof HTMLInputElement && active.type === 'range';

    if (key === 'ArrowDown' || key === 's' || key === 'S' || (key === 'Tab' && !ev.shiftKey)) {
      this.focusNav(this.navIndex + 1);
      return true;
    }
    if (key === 'ArrowUp' || key === 'w' || key === 'W' || (key === 'Tab' && ev.shiftKey)) {
      this.focusNav(this.navIndex - 1);
      return true;
    }
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') {
      if (isRange) return false;
      this.adjust(-1);
      return true;
    }
    if (key === 'ArrowRight' || key === 'd' || key === 'D') {
      if (isRange) return false;
      this.adjust(1);
      return true;
    }
    if (key === 'Enter' || key === ' ') {
      if (isRange) return true;
      const node = this.navItems[this.navIndex];
      if (node) {
        node.click();
        this.opts.onSound('click');
      }
      return true;
    }
    return false;
  }

  private adjust(dir: number): void {
    const node = this.navItems[this.navIndex];
    if (!node) return;
    if (node.dataset['nav'] === 'segmented' || node.dataset['nav'] === 'switch') {
      const buttons = node.querySelectorAll<HTMLElement>('[data-seg]');
      if (buttons.length === 0) {
        node.click();
        return;
      }
      let cur = 0;
      for (let i = 0; i < buttons.length; i++) {
        if (buttons[i]!.getAttribute('aria-checked') === 'true') cur = i;
      }
      const next = clamp(cur + dir, 0, buttons.length - 1);
      if (next !== cur) {
        buttons[next]!.click();
        this.opts.onSound('move');
      }
    }
  }

  /* ------------------------------------------------------------ shell helper */

  private makeView(name: ScreenView, label: string, cls = ''): HTMLElement {
    const view = el('section', `lv-screen lv-screen--${name} ${cls}`.trim());
    view.dataset['open'] = '0';
    view.setAttribute('aria-hidden', 'true');
    view.setAttribute('role', 'dialog');
    view.setAttribute('aria-modal', 'true');
    view.setAttribute('aria-label', label);
    this.views.set(name, view);
    return view;
  }

  /**
   * `sub` is a second line under the label; `hint` is a keyboard shortcut chip set inline
   * beside it. A shortcut has to stay on the label's line — as a second line it reads as a
   * stray glyph and makes that one row taller than its neighbours, which wrecks the menu's
   * vertical rhythm.
   */
  private button(
    text: string,
    cls: string,
    onClick: () => void,
    sub?: string,
    hint?: string,
  ): HTMLElement {
    const b = el('button', `lv-btn ${cls}`.trim());
    b.type = 'button';
    b.dataset['nav'] = 'button';
    const marker = el('span', 'lv-btn-mark');
    const wrap = el('span', 'lv-btn-body');
    if (hint) {
      const line = el('span', 'lv-btn-line');
      const chip = el('kbd', 'lv-btn-hint', hint);
      /* The chip is decoration for the eye; the shortcut is announced via aria-keyshortcuts,
         which is what it is for. Without this the accessible name comes out as "RESTARTN". */
      chip.setAttribute('aria-hidden', 'true');
      b.setAttribute('aria-keyshortcuts', hint.toLowerCase());
      line.append(el('span', 'lv-btn-t', text), chip);
      wrap.appendChild(line);
    } else {
      wrap.appendChild(el('span', 'lv-btn-t', text));
    }
    if (sub) wrap.appendChild(el('span', 'lv-btn-s', sub));
    b.append(marker, wrap);
    b.addEventListener('click', () => {
      this.opts.onSound('click');
      onClick();
    });
    return b;
  }

  private static frame(node: HTMLElement): HTMLElement {
    for (let i = 0; i < 4; i++) node.appendChild(el('i', `lv-brk lv-brk--${i}`));
    return node;
  }

  /* ------------------------------------------------------------------- title */

  private buildTitle(): HTMLElement {
    const view = this.makeView('title', 'Main menu');
    const inner = el('div', 'lv-title');

    const eyebrow = el('div', 'lv-title-eyebrow');
    eyebrow.append(
      el('span', '', 'SECTOR'),
      el('i', 'lv-dot'),
      el('span', 'lv-title-sector', FICTION.sectorName),
    );

    const mark = el('h1', 'lv-wordmark');
    mark.setAttribute('aria-label', FICTION.gameTitle);
    const words = FICTION.gameTitle.split(' ');
    for (let w = 0; w < words.length; w++) {
      const word = el('span', 'lv-word');
      const chars = words[w]!;
      for (let i = 0; i < chars.length; i++) {
        const glyph = el('span', 'lv-glyph', chars[i]!);
        glyph.style.setProperty('--n', String(w * 6 + i));
        glyph.setAttribute('aria-hidden', 'true');
        word.appendChild(glyph);
      }
      mark.appendChild(word);
    }

    const rule = el('div', 'lv-rule');
    rule.appendChild(el('i', 'lv-rule-glint'));

    const tag = el('p', 'lv-tagline', FICTION.tagline);

    const menu = el('nav', 'lv-menu');
    menu.setAttribute('aria-label', 'Main menu');
    menu.append(
      this.button('BEGIN RUN', 'is-primary', () => this.host.start(), FICTION.destinationName),
      this.button('SETTINGS', '', () => this.show('settings')),
      this.button('CONTROLS', '', () => this.show('controls')),
    );

    const foot = el('div', 'lv-title-foot');
    foot.append(
      el('span', '', `HULL ${FICTION.shipName}`),
      el('i', 'lv-dot'),
      el('span', '', `PRIMARY ${FICTION.starName}`),
      el('i', 'lv-dot'),
      el('span', '', 'NAV LOCK NOMINAL'),
    );

    inner.append(eyebrow, mark, rule, tag, menu, foot);
    view.append(el('div', 'lv-veil'), inner);
    return view;
  }

  /* ---------------------------------------------------------------- briefing */

  private buildBriefing(): HTMLElement {
    const view = this.makeView('briefing', 'Run briefing');
    const panel = Screens.frame(el('div', 'lv-brief'));

    const head = el('header', 'lv-brief-head');
    head.append(
      el('div', 'lv-kicker', 'RUN BRIEFING'),
      el('h2', 'lv-brief-title', FICTION.sectorName),
      el('div', 'lv-brief-sub', `TRANSIT TO ${FICTION.destinationName}`),
    );

    const cols = el('div', 'lv-brief-cols');

    const stats = el('dl', 'lv-stats');
    const addStat = (k: string, v: string): void => {
      const row = el('div', 'lv-stat');
      row.append(el('dt', '', k), el('dd', '', v));
      stats.appendChild(row);
    };
    addStat('MARKERS', '09');
    addStat('CORRIDOR', '48.6 KM');
    addStat('PRIMARY', FICTION.starName);
    addStat('HULL', FICTION.shipName);
    addStat('DRIFT', 'CLOSING');

    const prose = el('div', 'lv-prose');
    for (let i = 0; i < BRIEF_LINES.length; i++) {
      const p = el('p', 'lv-prose-l', BRIEF_LINES[i]!);
      p.style.setProperty('--n', String(i));
      prose.appendChild(p);
    }

    const primer = el('div', 'lv-primer');
    primer.appendChild(el('div', 'lv-kicker', 'PRIMER'));
    const keys = el('ul', 'lv-primer-list');
    for (let i = 0; i < CONTROLS.length; i++) {
      const row = CONTROLS[i]!;
      if (!row.primer) continue;
      const li = el('li');
      li.append(keyChips(row), el('span', '', row.action));
      keys.appendChild(li);
    }
    primer.appendChild(keys);

    cols.append(stats, prose, primer);

    const actions = el('div', 'lv-actions');
    actions.append(
      this.button('ENGAGE', 'is-primary', () => this.host.start()),
      this.button('BACK', 'is-ghost', () => this.opts.onBack()),
    );

    panel.append(head, cols, actions);
    view.append(el('div', 'lv-veil'), panel);
    return view;
  }

  /* --------------------------------------------------------------- countdown */

  private buildCountdown(): {
    view: HTMLElement;
    num: HTMLElement;
    ring: SVGCircleElement;
    label: HTMLElement;
  } {
    const view = this.makeView('countdown', 'Launch countdown', 'is-passthrough');
    view.setAttribute('role', 'status');
    view.removeAttribute('aria-modal');
    const wrap = el('div', 'lv-count');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('class', 'lv-count-svg');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('cx', '100');
    track.setAttribute('cy', '100');
    track.setAttribute('r', '86');
    track.setAttribute('class', 'lv-count-track');
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('cx', '100');
    ring.setAttribute('cy', '100');
    ring.setAttribute('r', '86');
    ring.setAttribute('class', 'lv-count-ring');
    svg.append(track, ring);

    const num = el('div', 'lv-count-n', '');
    const label = el('div', 'lv-count-k', 'LAUNCH SEQUENCE');
    wrap.append(svg, num, label);
    view.appendChild(wrap);
    return { view, num, ring, label };
  }

  setCountdown(value: number | null): void {
    if (value === this.lastCountdown) return;
    this.lastCountdown = value;
    const view = this.views.get('countdown');
    if (!view) return;
    if (value === null) {
      view.dataset['open'] = '0';
      return;
    }
    view.dataset['open'] = '1';
    const go = value <= 0;
    this.nCountNum.textContent = go ? 'GO' : String(value);
    this.nCountNum.dataset['go'] = go ? '1' : '0';
    this.nCountLabel.textContent = go ? 'VECTOR LIVE' : 'LAUNCH SEQUENCE';
    retrigger(this.nCountNum, 'is-tick');
    retrigger(this.nCountRing as unknown as HTMLElement, 'is-sweep');
  }

  /* ------------------------------------------------------------------- pause */

  private buildPause(): HTMLElement {
    const view = this.makeView('pause', 'Paused');
    const panel = Screens.frame(el('div', 'lv-pause'));
    panel.append(
      el('div', 'lv-kicker', 'FLIGHT HELD'),
      el('h2', 'lv-pause-title', 'PAUSED'),
      el('p', 'lv-pause-sub', 'Drift continues. The corridor does not wait.'),
    );
    const menu = el('nav', 'lv-menu lv-menu--tight');
    menu.append(
      this.button('RESUME', 'is-primary', () => this.host.resume()),
      /* Second, where the genre puts it: in a time trial "go again" is the common verb, and
         N was previously the only way to do it and was documented nowhere. The sub-label
         teaches the shortcut at the point of use. */
      this.button('RESTART', '', () => this.host.restart(), undefined, 'N'),
      this.button('SETTINGS', '', () => this.show('settings')),
      this.button('CONTROLS', '', () => this.show('controls')),
      this.button('ABORT RUN', 'is-danger', () => this.host.quitToTitle()),
    );
    panel.appendChild(menu);
    view.append(el('div', 'lv-veil lv-veil--blur'), panel);
    return view;
  }

  /* ---------------------------------------------------------------- settings */

  private buildSettings(): { view: HTMLElement; body: HTMLElement } {
    const view = this.makeView('settings', 'Settings');
    const panel = Screens.frame(el('div', 'lv-settings'));
    panel.append(el('div', 'lv-kicker', 'CONFIGURATION'), el('h2', 'lv-panel-title', 'SETTINGS'));

    const body = el('div', 'lv-set-body');
    for (const group of SETTING_GROUPS) {
      const sec = el('section', 'lv-set-group');
      sec.append(el('h3', 'lv-set-grouptitle', group.title));
      for (const row of group.rows) sec.appendChild(this.buildSettingRow(row));
      body.appendChild(sec);
    }

    const actions = el('div', 'lv-actions');
    actions.append(this.button('BACK', 'is-primary', () => this.opts.onBack()));

    panel.append(body, actions);
    view.append(el('div', 'lv-veil lv-veil--blur'), panel);
    return { view, body };
  }

  private buildSettingRow(row: RowSpec): HTMLElement {
    const node = el('div', `lv-set-row lv-set-row--${row.kind}`);
    const labels = el('div', 'lv-set-labels');
    labels.appendChild(el('span', 'lv-set-label', row.label));
    if (row.hint) labels.appendChild(el('span', 'lv-set-hint', row.hint));
    node.appendChild(labels);

    if (row.kind === 'enum') {
      const group = el('div', 'lv-seg');
      group.dataset['nav'] = 'segmented';
      group.tabIndex = 0;
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', row.label);
      for (const [value, text] of row.options) {
        const b = el('button', 'lv-seg-b', text);
        b.type = 'button';
        b.tabIndex = -1;
        b.dataset['seg'] = value;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.addEventListener('click', () => {
          this.commit(row.key, value as Settings[keyof Settings]);
          this.opts.onSound('click');
        });
        group.appendChild(b);
      }
      node.appendChild(group);
      this.settingNodes.push({
        row,
        apply: (v) => {
          const buttons = group.querySelectorAll<HTMLElement>('[data-seg]');
          for (let i = 0; i < buttons.length; i++) {
            const b = buttons[i]!;
            b.setAttribute('aria-checked', b.dataset['seg'] === v ? 'true' : 'false');
          }
        },
      });
      return node;
    }

    if (row.kind === 'bool') {
      const sw = el('button', 'lv-switch');
      sw.type = 'button';
      sw.dataset['nav'] = 'switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', 'false');
      sw.setAttribute('aria-label', row.label);
      sw.append(el('i', 'lv-switch-knob'), el('span', 'lv-switch-t', 'OFF'));
      sw.addEventListener('click', () => {
        const next = sw.getAttribute('aria-checked') !== 'true';
        this.commit(row.key, next as Settings[keyof Settings]);
        this.opts.onSound('click');
      });
      node.appendChild(sw);
      this.settingNodes.push({
        row,
        apply: (v) => {
          const on = v === true;
          sw.setAttribute('aria-checked', on ? 'true' : 'false');
          const t = sw.querySelector('.lv-switch-t');
          if (t) t.textContent = on ? 'ON' : 'OFF';
        },
      });
      return node;
    }

    const wrap = el('div', 'lv-slider');
    const input = el('input', 'lv-slider-in');
    input.type = 'range';
    input.min = String(row.min);
    input.max = String(row.max);
    input.step = String(row.step);
    input.dataset['nav'] = 'range';
    input.setAttribute('aria-label', row.label);
    const read = el('span', 'lv-slider-v', '');
    const track = el('div', 'lv-slider-track');
    const fill = el('i', 'lv-slider-fill');
    track.appendChild(fill);
    wrap.append(track, input, read);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      fill.style.transform = `scaleX(${((v - row.min) / (row.max - row.min)).toFixed(4)})`;
      read.textContent = row.fmt(v);
      this.commit(row.key, v as Settings[keyof Settings]);
    });
    node.appendChild(wrap);
    this.settingNodes.push({
      row,
      apply: (v) => {
        const num = typeof v === 'number' ? v : row.min;
        input.value = String(num);
        fill.style.transform = `scaleX(${((num - row.min) / (row.max - row.min)).toFixed(4)})`;
        read.textContent = row.fmt(num);
      },
    });
    return node;
  }

  private commit<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.host.setSetting(key, value);
    this.syncSettings();
    this.opts.onSettingChanged();
  }

  private syncSettings(): void {
    const s = this.host.getSettings();
    for (const entry of this.settingNodes) {
      entry.apply(s[entry.row.key] as unknown);
    }
  }

  /** Exposed for the harness / lead: re-read settings from the host. */
  refreshSettings(): void {
    if (this.nSettingsBody.childElementCount > 0) this.syncSettings();
  }

  /* ---------------------------------------------------------------- controls */

  private buildControls(): HTMLElement {
    const view = this.makeView('controls', 'Controls');
    const panel = Screens.frame(el('div', 'lv-controls'));
    panel.append(el('div', 'lv-kicker', 'PILOT REFERENCE'), el('h2', 'lv-panel-title', 'CONTROLS'));

    const list = el('ul', 'lv-keys');
    for (let i = 0; i < CONTROLS.length; i++) {
      const row = CONTROLS[i]!;
      const li = el('li', 'lv-key');
      li.style.setProperty('--n', String(i));
      li.append(keyChips(row), el('span', 'lv-key-d', row.action));
      list.appendChild(li);
    }

    const note = el(
      'p',
      'lv-note',
      'Pointer lock captures the mouse on launch. ESC releases it and holds the flight.',
    );
    const actions = el('div', 'lv-actions');
    actions.append(this.button('BACK', 'is-primary', () => this.opts.onBack()));

    panel.append(list, note, actions);
    view.append(el('div', 'lv-veil lv-veil--blur'), panel);
    return view;
  }

  /* ----------------------------------------------------------------- results */

  private buildResults(): { view: HTMLElement; body: HTMLElement } {
    const view = this.makeView('results', 'Run complete');
    const panel = el('div', 'lv-results');
    const body = el('div', 'lv-res-body');
    panel.appendChild(body);
    view.append(el('div', 'lv-veil lv-veil--results'), panel);
    return { view, body };
  }

  showResult(r: RunResult): void {
    const body = this.nResultBody;
    body.textContent = '';

    /* headline: destination left, rating right, so the top edge is not weighted to one side */
    const head = el('header', 'lv-res-head');
    head.style.setProperty('--n', '0');
    const headline = el('div', 'lv-res-headline');
    headline.append(
      el('div', 'lv-kicker', r.gatesCleared >= r.gatesTotal ? 'ARRIVAL CONFIRMED' : 'RUN ENDED'),
      el('h2', 'lv-res-title', r.destinationName),
    );
    const rank = el('div', 'lv-res-rank');
    rank.append(el('div', 'lv-res-k', 'RATING'), el('div', 'lv-res-letter', r.rank));
    rank.dataset['rank'] = r.rank.charAt(0).toUpperCase();
    head.append(headline, rank);
    body.appendChild(head);

    /* two columns: the run's headline number on the left, its shape on the right */
    const main = el('div', 'lv-res-main');
    main.style.setProperty('--n', '1');

    const left = el('div', 'lv-res-left');
    const timeBlock = el('div', 'lv-res-timeblock');
    timeBlock.append(el('div', 'lv-res-k', 'TOTAL'), el('div', 'lv-res-time', formatTime(r.totalTime)));
    if (r.isNewBest) {
      const badge = el('div', 'lv-newbest');
      badge.append(el('i', 'lv-newbest-tick'), el('span', '', 'NEW BEST'));
      timeBlock.appendChild(badge);
    } else if (r.bestTime != null) {
      const d = r.totalTime - r.bestTime;
      const delta = el('div', 'lv-res-delta', `${formatDelta(d)} vs BEST ${formatTime(r.bestTime)}`);
      delta.dataset['tone'] = d <= 0 ? 'good' : 'bad';
      timeBlock.appendChild(delta);
    }
    left.appendChild(timeBlock);

    const stats = el('dl', 'lv-res-stats');
    const addStat = (k: string, v: string, tone?: string): void => {
      const cell = el('div', 'lv-res-stat');
      cell.append(el('dt', 'lv-res-statk', k), el('dd', 'lv-res-statv', v));
      if (tone) cell.dataset['tone'] = tone;
      stats.appendChild(cell);
    };
    addStat('MARKERS', `${r.gatesCleared} / ${r.gatesTotal}`);
    addStat('TOP SPEED', `${Math.round(r.topSpeed)} M/S`);
    addStat('HULL', r.cleanRun ? 'UNTOUCHED' : 'SCARRED', r.cleanRun ? 'good' : 'warn');
    left.appendChild(stats);

    /* splits, with a bar per segment so the shape of the run reads without arithmetic */
    const table = el('div', 'lv-res-splits');
    const header = el('div', 'lv-res-row is-head');
    header.append(
      el('span', '', 'MARKER'),
      el('span', '', 'SEGMENT'),
      el('span', ''),
      el('span', '', 'ELAPSED'),
      el('span', '', 'Δ BEST'),
    );
    table.appendChild(header);

    let fastest = Infinity;
    let slowest = 0;
    for (let i = 0; i < r.splits.length; i++) {
      const seg = r.splits[i]! - (i > 0 ? r.splits[i - 1]! : 0);
      if (seg < fastest) fastest = seg;
      if (seg > slowest) slowest = seg;
    }
    for (let i = 0; i < r.splits.length; i++) {
      const seg = r.splits[i]! - (i > 0 ? r.splits[i - 1]! : 0);
      const row = el('div', 'lv-res-row');
      row.style.setProperty('--n', String(i));
      const isFast = seg <= fastest + 1e-6;
      const bar = el('span', 'lv-res-barwrap');
      const fill = el('i', 'lv-res-bar');
      /* Normalised against the slowest segment, floored so the quickest is still a visible
         mark rather than a sliver of nothing. */
      fill.style.setProperty('--w', (slowest > 0 ? 0.08 + 0.92 * (seg / slowest) : 1).toFixed(3));
      bar.appendChild(fill);
      row.append(
        el('span', 'lv-res-idx', (i + 1 < 10 ? '0' : '') + (i + 1)),
        el('span', 'lv-res-seg', seg.toFixed(2)),
        bar,
        el('span', 'lv-res-cum', formatTime(r.splits[i]!)),
        el('span', 'lv-res-dlt', isFast ? 'BEST' : formatDelta(seg - fastest)),
      );
      row.dataset['fast'] = isFast ? '1' : '0';
      table.appendChild(row);
    }

    const right = el('div', 'lv-res-right');
    right.appendChild(table);
    main.append(left, right);
    body.appendChild(main);

    const actions = el('div', 'lv-actions lv-actions--res');
    actions.style.setProperty('--n', '2');
    actions.append(
      this.button('RUN AGAIN', 'is-primary', () => this.host.restart()),
      this.button('RETURN', 'is-ghost', () => this.host.quitToTitle()),
    );
    body.appendChild(actions);

    if (this.view === 'results') {
      this.collectNav(this.views.get('results')!);
      this.focusNav(0, false);
    }
  }
}

/** Re-exported so the lead can label quality options consistently elsewhere. */
export const QUALITY_ORDER: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
