/**
 * Full-screen interface states for LAST VECTOR: title, briefing, countdown, pause,
 * settings, controls and results.
 *
 * Every screen sits over the live 3D scene, so nothing here uses an opaque panel — depth
 * comes from gradients, hairlines and local scrims. Navigation is real DOM focus, so the
 * keyboard path and the pointer path are the same path.
 */

import type {
  HudHost,
  Locale,
  QualityLevel,
  RunResult,
  Settings,
  SurvivalRunResult,
} from '../core/contracts.ts';
import {
  CAMPAIGN_MODE_ENABLED,
  PRECISION_MAX_OFFSET,
  type CourseId,
} from '../core/Courses.ts';
import {
  DEFAULT_RUN_MODE_ID,
  SURVIVAL_RUN_MODE_ID,
  type RunModeId,
} from '../core/GameModes.ts';
import type { Translator } from '../i18n/index.ts';
import type { ControlMessages, SettingMessages } from '../i18n/messages.ts';
import {
  clamp,
  distanceUnit,
  el,
  formatDelta,
  formatDistance,
  formatTime,
  retrigger,
} from './Hud.ts';
import { formatPrecisionOffsetPercent } from './precision.ts';

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

export type ScreenAction =
  | 'begin'
  | 'settings'
  | 'controls'
  | 'engage'
  | 'return'
  | 'resume'
  | 'restart'
  | 'abort'
  | 'again'
  | 'retry'
  | 'select-route'
  | 'next-route'
  | 'route-select';

export type CampaignRouteState = 'locked' | 'available' | 'cleared';
export type CampaignNavigationError = 'navigation-failed' | 'storage-unavailable';

export interface CampaignCourseView {
  readonly id: CourseId;
  readonly state: CampaignRouteState;
  readonly highestRank: string | null;
  readonly objectives: {
    readonly firstClear: boolean;
    readonly cleanClear: boolean;
    readonly precision: boolean;
  };
}

/** Complete, presentation-ready campaign state. Screens never reads storage or derives unlocks. */
export interface CampaignViewModel {
  readonly activeCourseId: CourseId;
  readonly routes: readonly CampaignCourseView[];
  readonly newlyUnlockedCourseId?: CourseId | null;
  readonly navigationError?: CampaignNavigationError | null;
}

export interface ScreenFocusToken {
  view: ScreenView;
  action?: ScreenAction;
  nav?: string;
  locale?: Locale;
  route?: CourseId;
  runMode?: RunModeId;
}

const COURSE_IDS = ['cairn-drift', 'needle-grave'] as const satisfies readonly CourseId[];
const CAMPAIGN_BRIEF_KEYS = [
  'briefingLine1',
  'briefingLine2',
  'briefingLine3',
] as const;

function defaultCampaignView(): CampaignViewModel {
  return {
    activeCourseId: 'cairn-drift',
    newlyUnlockedCourseId: null,
    navigationError: null,
    routes: [
      {
        id: 'cairn-drift',
        state: 'available',
        highestRank: null,
        objectives: { firstClear: false, cleanClear: false, precision: false },
      },
      {
        id: 'needle-grave',
        state: 'locked',
        highestRank: null,
        objectives: { firstClear: false, cleanClear: false, precision: false },
      },
    ],
  };
}

export type ControlId =
  | 'mouse-steer'
  | 'throttle'
  | 'roll'
  | 'boost'
  | 'brake'
  | 'strafe-horizontal'
  | 'strafe-vertical'
  | 'keyboard-steer'
  | 'camera-toggle'
  | 'pause'
  | 'restart';

interface ControlRow {
  /** Stable semantic identifier for UI contracts, independent of the displayed copy. */
  readonly id: ControlId;
  /**
   * Alternative bindings for one verb. Keys inside a group are a set ("W / S"); separate
   * groups are alternatives and render with an "or" between them ("SHIFT or LMB").
   */
  readonly groups: readonly (readonly string[])[];
  readonly action: keyof ControlMessages;
  /** Also shown in the briefing primer. Flagged per row so reordering cannot silently change it. */
  readonly primer?: boolean;
  /**
   * Terser wording for the primer, which sits in a narrow column and has to read at a glance.
   * The full legend keeps the longer text — that screen has the width and the reader's
   * attention; the primer has neither.
   */
  readonly short?: keyof ControlMessages;
}

/**
 * Authoritative bindings, mirrored from src/core/Input.ts. The primer includes both steering
 * paths and the view toggle: a first-run player must not conclude that mouse capture is required
 * or miss the cockpit that makes the ship readable from the pilot's seat.
 */
const CONTROLS: readonly ControlRow[] = [
  { id: 'mouse-steer', groups: [['MOUSE']], action: 'mouseSteer', primer: true, short: 'mouseSteerShort' },
  { id: 'throttle', groups: [['W', 'S']], action: 'throttle', primer: true },
  { id: 'roll', groups: [['A', 'D']], action: 'roll', primer: true },
  { id: 'boost', groups: [['SHIFT'], ['LMB']], action: 'boost', primer: true },
  { id: 'brake', groups: [['SPACE'], ['RMB']], action: 'brake', primer: true },
  { id: 'strafe-horizontal', groups: [['Q', 'E']], action: 'strafeHorizontal' },
  { id: 'strafe-vertical', groups: [['R', 'F']], action: 'strafeVertical' },
  {
    id: 'keyboard-steer',
    groups: [['↑', '↓', '←', '→']],
    action: 'keyboardSteer',
    primer: true,
    short: 'keyboardSteerShort',
  },
  {
    id: 'camera-toggle',
    groups: [['C']],
    action: 'cameraToggle',
    primer: true,
    short: 'cameraToggleShort',
  },
  { id: 'pause', groups: [['ESC']], action: 'pause' },
  { id: 'restart', groups: [['N']], action: 'restart' },
];

/** Key chips for one binding row, shared by the CONTROLS legend and the briefing primer. */
function keyChips(row: ControlRow, orLabel: string): HTMLElement {
  const wrap = el('span', 'lv-key-keys');
  for (let g = 0; g < row.groups.length; g++) {
    if (g > 0) wrap.appendChild(el('span', 'lv-key-or', orLabel));
    const group = row.groups[g]!;
    for (let k = 0; k < group.length; k++) {
      const chip = el('kbd', '', group[k]!);
      chip.lang = 'en';
      wrap.appendChild(chip);
    }
  }
  return wrap;
}

/**
 * Writes one complete catalog string while exposing a deliberately small set of Latin tokens
 * to assistive technology. Text is never parsed as markup: ordinary runs become text nodes and
 * exact token matches become `lang=en` spans.
 */
function writeEnglishTokens(node: HTMLElement, text: string, tokens: readonly string[]): HTMLElement {
  node.textContent = '';
  let offset = 0;
  while (offset < text.length) {
    let nextToken = '';
    let nextIndex = text.length;
    for (const token of tokens) {
      const index = text.indexOf(token, offset);
      if (index >= 0 && index < nextIndex) {
        nextIndex = index;
        nextToken = token;
      }
    }
    if (!nextToken) {
      node.appendChild(document.createTextNode(text.slice(offset)));
      break;
    }
    if (nextIndex > offset) node.appendChild(document.createTextNode(text.slice(offset, nextIndex)));
    const token = el('span', '', nextToken);
    token.lang = 'en';
    node.appendChild(token);
    offset = nextIndex + nextToken.length;
  }
  if (text.length === 0) node.textContent = '';
  return node;
}

function englishText(tag: keyof HTMLElementTagNameMap, cls: string, text: string): HTMLElement {
  const node = el(tag, cls, text);
  node.lang = 'en';
  return node;
}

/* -------------------------------------------------------------- settings map */

type SettingTextKey = keyof SettingMessages;
type EnumSettingKey = 'assistLevel' | 'cameraMode' | 'quality';
type RangeSettingKey =
  | 'mouseSensitivity'
  | 'fov'
  | 'cameraShake'
  | 'renderScale'
  | 'masterVolume'
  | 'musicVolume';
type BoolSettingKey = 'invertY' | 'showFps' | 'motionBlur' | 'filmGrain' | 'chromaticAberration';

type EnumRow = {
  [K in EnumSettingKey]: {
    readonly kind: 'enum';
    readonly key: K;
    readonly label: SettingTextKey;
    readonly hint?: SettingTextKey;
    readonly options: readonly (readonly [value: Settings[K], label: SettingTextKey])[];
  }
}[EnumSettingKey];

type RangeRow = {
  [K in RangeSettingKey]: {
    readonly kind: 'range';
    readonly key: K;
    readonly label: SettingTextKey;
    readonly hint?: SettingTextKey;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly fmt: (v: number) => string;
  }
}[RangeSettingKey];

type BoolRow = {
  [K in BoolSettingKey]: {
    readonly kind: 'bool';
    readonly key: K;
    readonly label: SettingTextKey;
    readonly hint?: SettingTextKey;
  }
}[BoolSettingKey];

type RowSpec = EnumRow | RangeRow | BoolRow;

interface SettingGroup {
  readonly title: SettingTextKey;
  readonly rows: readonly RowSpec[];
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const mult = (v: number): string => `${v.toFixed(2)}×`;
const deg = (v: number): string => `${Math.round(v)}°`;

const SETTING_GROUPS = [
  {
    title: 'sectionFlight',
    rows: [
      {
        kind: 'enum',
        key: 'assistLevel',
        label: 'flightAssist',
        hint: 'flightAssistHint',
        options: [
          ['arcade', 'arcade'],
          ['standard', 'standard'],
          ['raw', 'raw'],
        ],
      },
      {
        kind: 'enum',
        key: 'cameraMode',
        label: 'defaultCamera',
        hint: 'defaultCameraHint',
        options: [
          ['chase', 'chase'],
          ['cockpit', 'cockpit'],
        ],
      },
      {
        kind: 'range',
        key: 'mouseSensitivity',
        label: 'mouseSensitivity',
        min: 0.2,
        max: 3,
        step: 0.05,
        fmt: mult,
      },
      { kind: 'bool', key: 'invertY', label: 'invertPitch' },
      {
        kind: 'range',
        key: 'fov',
        label: 'fieldOfView',
        hint: 'fieldOfViewHint',
        /* 100, not 110: `Settings.ts` sanitises fov to [60, 100] and `commit -> syncSettings ->
           apply()` rewrites input.value from the sanitised store on every input event, so the
           thumb was actively driven back down and the top 20% of the track was dead. `.lv-slider-in`
           is opacity 0, so there is no native thumb underneath to show it — the control simply
           froze. Both the row max and the clamp date to the same initial commit, so neither is
           newer; the clamp wins because no player has ever seen fov above 100 and widening it
           would ship a range nothing has tested. */
        min: 60,
        max: 100,
        step: 1,
        fmt: deg,
      },
      {
        kind: 'range',
        key: 'cameraShake',
        label: 'cameraShake',
        /* 1, not 2: `Settings.ts` sanitises cameraShake with clamp01. Same defect as fov above —
           half this track was dead travel. */
        min: 0,
        max: 1,
        step: 0.05,
        fmt: mult,
      },
    ],
  },
  {
    title: 'sectionDisplay',
    rows: [
      {
        kind: 'enum',
        key: 'quality',
        label: 'quality',
        options: [
          ['low', 'low'],
          ['medium', 'medium'],
          ['high', 'high'],
          ['ultra', 'ultra'],
        ],
      },
      {
        kind: 'range',
        key: 'renderScale',
        label: 'renderScale',
        hint: 'renderScaleHint',
        // 0.6, not 0.5: the sanitiser clamps to the adaptive controller's own floor of 0.58, so
        // everything below that was travel the player could move and the game could not honour.
        min: 0.6,
        max: 1,
        /* 0.02, not 0.05, so every quality profile's renderScale is a REACHABLE stop:
           0.6 + 6*0.02 = 0.72 (low), + 13*0.02 = 0.86 (medium), + 20*0.02 = 1.00 (high/ultra).
           Those three are bit-exact against the profile constants in binary64, not merely close.

           On the old 0.05 grid 0.72 and 0.86 were not stops, so the input element held "0.7" and
           "0.85" while the store held the profile value — `Number(input.value) === store` was
           false at two of four profiles, and survived a reload.

           Two claims an earlier version of this comment made that did NOT reproduce, recorded so
           nobody re-derives them: a net-zero *pointer* drag commits nothing on either grid, and
           the visible thumb is the JS-driven fill rather than the native one (`.lv-slider-in` is
           opacity 0), so "thumb and readout disagreed" was the wrong description of a real
           mismatch between input value and store. The net-zero *keyboard* gesture does still flip
           state at high and ultra, but through endpoint clamping rather than the grid.

           Note this change alone made `renderScaleForQuality`'s old value-equality test unsound —
           see the correction on that function. Reachability was the property that test depended
           on. */
        step: 0.02,
        fmt: pct,
      },
      { kind: 'bool', key: 'showFps', label: 'frameCounter' },
    ],
  },
  {
    title: 'sectionImage',
    rows: [
      { kind: 'bool', key: 'motionBlur', label: 'motionBlur' },
      { kind: 'bool', key: 'filmGrain', label: 'filmGrain' },
      { kind: 'bool', key: 'chromaticAberration', label: 'chromaticAberration' },
    ],
  },
  {
    title: 'sectionAudio',
    rows: [
      {
        kind: 'range',
        key: 'masterVolume',
        label: 'masterVolume',
        min: 0,
        max: 1,
        step: 0.01,
        fmt: pct,
      },
      {
        kind: 'range',
        key: 'musicVolume',
        label: 'music',
        min: 0,
        max: 1,
        step: 0.01,
        fmt: pct,
      },
    ],
  },
] as const satisfies readonly SettingGroup[];

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
  private readonly translator: Translator;
  private readonly runMode: RunModeId;
  private readonly views = new Map<ScreenView, HTMLElement>();
  private view: ScreenView = 'none';
  private campaign: CampaignViewModel = defaultCampaignView();

  private nTitleSector: HTMLElement | null = null;
  private nTitleTagline: HTMLElement | null = null;
  private nBeginDestination: HTMLElement | null = null;
  private nBriefTitle: HTMLElement | null = null;
  private nBriefTransit: HTMLElement | null = null;
  private readonly nBriefLines: HTMLElement[] = [];
  private readonly routeNodes = new Map<CourseId, {
    button: HTMLButtonElement;
    status: HTMLElement;
    selected: HTMLElement;
    rank: HTMLElement;
    lock: HTMLElement;
  }>();

  private readonly nCountNum: HTMLElement;
  private readonly nCountRing: SVGCircleElement;
  private readonly nCountLabel: HTMLElement;
  private readonly nResultBody: HTMLElement;
  private readonly nSettingsBody: HTMLElement;
  private readonly settingNodes: {
    row: RowSpec;
    apply(value: unknown): void;
  }[] = [];

  /* Briefing stats that are facts about the course rather than fiction. Held so they can be
     read from telemetry instead of typed — see setCourseFacts. */
  private nStatCorridor: HTMLElement | null = null;
  private nStatMarkers: HTMLElement | null = null;
  private pCorridor = -1;
  private pMarkers = -1;

  private navItems: HTMLElement[] = [];
  private navIndex = 0;
  private lastCountdown: number | null = null;

  constructor(host: HudHost, opts: ScreensOptions, translator: Translator) {
    this.host = host;
    this.opts = opts;
    this.translator = translator;
    this.runMode = host.getRunMode?.() ?? DEFAULT_RUN_MODE_ID;
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

  /**
   * Synchronises campaign presentation from a single host-owned snapshot. The host remains the
   * authority for unlock and persistence rules; this layer only renders the supplied states.
   */
  syncCampaign(viewModel: CampaignViewModel): void {
    const active = viewModel.routes.find(
      (route) => route.id === viewModel.activeCourseId && route.state !== 'locked',
    );
    const fallback = viewModel.routes.find(
      (route) => route.id === 'cairn-drift' && route.state !== 'locked',
    );
    const activeCourseId = active?.id ?? fallback?.id ?? 'cairn-drift';
    this.campaign = { ...viewModel, activeCourseId };

    const m = this.translator.messages;
    const routeCopy = m.campaign.routes[activeCourseId];
    if (this.runMode === DEFAULT_RUN_MODE_ID) {
      if (this.nTitleSector) this.nTitleSector.textContent = routeCopy.sectorName;
      if (this.nTitleTagline) {
        writeEnglishTokens(
          this.nTitleTagline,
          routeCopy.tagline,
          ['CAIRN', 'TERMINUS', 'NEEDLE GRAVE', 'NADIR RELAY'],
        );
      }
      if (this.nBeginDestination) this.nBeginDestination.textContent = routeCopy.destination;
      if (this.nBriefTitle) this.nBriefTitle.textContent = routeCopy.sectorName;
      if (this.nBriefTransit) {
        writeEnglishTokens(
          this.nBriefTransit,
          `${m.screens.transitTo} ${routeCopy.destination}`,
          [routeCopy.destination],
        );
      }
      for (let i = 0; i < this.nBriefLines.length; i++) {
        writeEnglishTokens(
          this.nBriefLines[i]!,
          routeCopy[CAMPAIGN_BRIEF_KEYS[i]!] ?? '',
          ['ACHRA', 'CAIRN', 'NEEDLE GRAVE', 'SHEAR'],
        );
      }
    }

    for (const id of COURSE_IDS) {
      const route = viewModel.routes.find((candidate) => candidate.id === id);
      const nodes = this.routeNodes.get(id);
      if (!nodes) continue;
      const state = route?.state ?? (id === 'cairn-drift' ? 'available' : 'locked');
      const selected = id === activeCourseId;
      const storageBlocked =
        viewModel.navigationError === 'storage-unavailable' && !selected && state !== 'locked';
      nodes.button.dataset['routeState'] = state;
      nodes.button.setAttribute('aria-checked', selected ? 'true' : 'false');
      nodes.button.setAttribute(
        'aria-disabled',
        state === 'locked' || storageBlocked ? 'true' : 'false',
      );
      if (state === 'locked') nodes.button.setAttribute('aria-describedby', nodes.lock.id);
      else if (storageBlocked) nodes.button.setAttribute('aria-describedby', 'lv-campaign-error-title');
      else nodes.button.removeAttribute('aria-describedby');
      nodes.status.textContent = m.campaign[state];
      nodes.selected.textContent = selected ? m.campaign.selected : '';
      nodes.selected.hidden = !selected;
      nodes.rank.textContent = route?.highestRank ?? m.campaign.noRank;
      writeEnglishTokens(
        nodes.lock,
        state === 'locked' ? m.campaign.routes[id].lockReason : '',
        ['CAIRN DRIFT', 'NEEDLE GRAVE'],
      );
      nodes.lock.hidden = state !== 'locked';
    }

    this.syncCampaignErrors();
    this.syncObjectiveLists();
  }

  private campaignCourse(id: CourseId = this.campaign.activeCourseId): CampaignCourseView {
    return this.campaign.routes.find((route) => route.id === id) ?? {
      id,
      state: id === 'cairn-drift' ? 'available' : 'locked',
      highestRank: null,
      objectives: { firstClear: false, cleanClear: false, precision: false },
    };
  }

  private syncCampaignErrors(): void {
    const error = this.campaign.navigationError;
    const text = error ? this.translator.messages.campaign[
      error === 'storage-unavailable' ? 'storageUnavailable' : 'navigationFailed'
    ] : '';
    const nodes = this.el.querySelectorAll<HTMLElement>('[data-campaign-error]');
    for (let i = 0; i < nodes.length; i++) {
      nodes[i]!.textContent = text;
      nodes[i]!.hidden = text.length === 0;
    }
  }

  private syncObjectiveLists(): void {
    const route = this.campaignCourse();
    const lists = this.el.querySelectorAll<HTMLElement>('[data-objective-list]');
    for (let i = 0; i < lists.length; i++) this.writeObjectiveList(lists[i]!, route);
  }

  private writeObjectiveList(
    list: HTMLElement,
    route: CampaignCourseView,
    result?: RunResult,
  ): void {
    const m = this.translator.messages;
    const copy = m.campaign.routes[route.id].objectives;
    const rows = [
      { id: 'first-clear', label: copy.firstClear, complete: route.objectives.firstClear, value: '', target: true },
      { id: 'clean-clear', label: copy.cleanClear, complete: route.objectives.cleanClear, value: '', target: true },
      { id: 'precision', label: copy.precision, complete: route.objectives.precision, value: '', target: true },
      {
        id: 'highest-rank',
        label: copy.highestRank,
        complete: route.highestRank !== null,
        value: route.highestRank ?? m.campaign.noRank,
        target: false,
      },
    ];
    const focusId = result
      ? rows.find((row) => row.target && !row.complete)?.id ?? null
      : null;
    list.textContent = '';
    if (result) list.dataset['mastered'] = focusId === null ? '1' : '0';
    else delete list.dataset['mastered'];
    for (const { id, label, complete, value } of rows) {
      const row = el('li', 'lv-objective');
      row.dataset['objective'] = id;
      row.dataset['complete'] = complete ? '1' : '0';
      if (id === focusId) row.dataset['focus'] = '1';
      const state = el('span', 'lv-objective-state', complete ? '◆' : '◇');
      state.setAttribute('aria-hidden', 'true');
      const name = writeEnglishTokens(
        el('span', 'lv-objective-name'),
        label,
        ['CAIRN DRIFT', 'NEEDLE GRAVE'],
      );
      name.lang = this.translator.locale;
      if (id === focusId) {
        name.appendChild(englishText('span', 'lv-objective-next', m.campaign.nextObjective));
      }
      const valueNode = englishText(
        'span',
        'lv-objective-value',
        value || (complete ? m.campaign.complete : m.campaign.incomplete),
      );
      row.append(state, name, valueNode);
      list.appendChild(row);
    }
  }

  captureFocusToken(): ScreenFocusToken | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.el.contains(active)) return null;
    const view = active.closest<HTMLElement>('[data-view]');
    if (!view || view.dataset['open'] !== '1') return null;
    const nav = active.closest<HTMLElement>('[data-nav]');
    const checked = nav?.querySelector<HTMLElement>('[aria-checked="true"]') ?? null;
    return {
      view: view.dataset['view'] as ScreenView,
      action: active.dataset['action'] as ScreenAction | undefined,
      nav: nav?.dataset['nav'],
      locale: (active.dataset['locale'] ?? checked?.dataset['locale']) as Locale | undefined,
      route: active.dataset['route'] as CourseId | undefined,
      runMode: (active.dataset['runMode'] ?? checked?.dataset['runMode']) as RunModeId | undefined,
    };
  }

  restoreFocusToken(token: ScreenFocusToken | null): void {
    if (!token || token.view !== this.view) return;
    const view = this.views.get(token.view);
    if (!view) return;
    const candidates = view.querySelectorAll<HTMLElement>('[data-nav], [data-locale], [data-run-mode]');
    let match: HTMLElement | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (candidate.closest('[hidden]')) continue;
      const candidateNav = candidate.closest<HTMLElement>('[data-nav]');
      if (token.action !== undefined && candidate.dataset['action'] !== token.action) continue;
      if (token.nav !== undefined && candidateNav?.dataset['nav'] !== token.nav) continue;
      if (token.locale !== undefined && candidate.dataset['locale'] !== token.locale) continue;
      if (token.route !== undefined && candidate.dataset['route'] !== token.route) continue;
      if (token.runMode !== undefined && candidate.dataset['runMode'] !== token.runMode) continue;
      match = candidate;
      break;
    }
    if (!match) return;
    const nav = match.closest<HTMLElement>('[data-nav]');
    const index = nav ? this.navItems.indexOf(nav) : -1;
    if (index >= 0) this.navIndex = index;
    match.focus({ preventScroll: true });
    match.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    /* The route strip is visually above BEGIN, but the established title keyboard contract starts
       on BEGIN and uses S/W to reach SETTINGS and return. When campaign mode is enabled, append
       its visible route cards without moving their visual placement. Hidden feature-gated regions
       are always filtered below so their descendants cannot become invisible focus stops. */
    let found: HTMLElement[];
    if (root.dataset['view'] === 'title') {
      found = [
        ...root.querySelectorAll<HTMLElement>('.lv-menu [data-nav]'),
        ...root.querySelectorAll<HTMLElement>('.lv-mode-select [data-nav]'),
        ...root.querySelectorAll<HTMLElement>('.lv-route-strip [data-nav]'),
      ];
    } else {
      const all = [...root.querySelectorAll<HTMLElement>('[data-nav]')];
      /* A scrollable article is reachable, but not the first thing focused when a briefing or
         result opens. Primary actions retain their established landing point; one more Tab (or
         Shift+Tab from the first action) reaches the clipped evidence and lets PageDown/End work
         natively. */
      found = [
        ...all.filter((node) => node.dataset['nav'] !== 'scroll'),
        ...all.filter((node) => node.dataset['nav'] === 'scroll'),
      ];
    }
    this.navItems.length = 0;
    for (let i = 0; i < found.length; i++) {
      const node = found[i]!;
      if (node.dataset['nav'] === 'mode' && node.tabIndex < 0) continue;
      if (node.dataset['disabled'] !== '1' && !node.closest('[hidden]')) this.navItems.push(node);
    }
    this.navIndex = 0;
  }

  private focusNav(index: number, sound = true): void {
    if (this.navItems.length === 0) return;
    const n = this.navItems.length;
    this.navIndex = ((index % n) + n) % n;
    const node = this.navItems[this.navIndex]!;
    /*
     * Suppress the browser's own scroll, then scroll deliberately. `preventScroll` alone left a
     * keyboard-only player focused on a control below the fold in a container that never
     * scrolled — measured at 375x667, the Score slider sat at y 677 against a 667 viewport with
     * the settings scroller at scrollTop 0, and ArrowRight then changed a setting the player
     * could not see. `block: 'nearest'` moves the nearest scrollable ancestor by the minimum
     * needed and leaves everything else alone, which is what the plain default cannot promise.
     *
     * This is the keyboard and programmatic path only. Pointer focus in `onPointerOver` keeps
     * `preventScroll` with no scroll call, because hovering a control must never move the page
     * under the pointer.
     */
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (sound) this.opts.onSound('move');
  }

  /**
   * Result actions reflow from a horizontal row to a vertical stack on compact screens. Follow
   * their rendered geometry instead of pretending one DOM-order axis describes both layouts.
   * Returning true with no candidate deliberately consumes the perpendicular arrow: pressing
   * Down on a horizontal row (or Right on a vertical stack) must not move focus sideways.
   */
  private moveResultArrow(key: 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight'): boolean {
    if (this.view !== 'results') return false;
    const current = this.navItems[this.navIndex];
    const group = current?.closest<HTMLElement>('.lv-actions--res');
    if (!current || !group) return false;

    const direction = key === 'ArrowLeft'
      ? { x: -1, y: 0 }
      : key === 'ArrowRight'
        ? { x: 1, y: 0 }
        : key === 'ArrowUp'
          ? { x: 0, y: -1 }
          : { x: 0, y: 1 };
    const origin = current.getBoundingClientRect();
    const originX = origin.left + origin.width / 2;
    const originY = origin.top + origin.height / 2;
    let bestIndex = -1;
    let bestScore = Infinity;

    for (let i = 0; i < this.navItems.length; i++) {
      const candidate = this.navItems[i]!;
      if (candidate === current || candidate.closest('.lv-actions--res') !== group) continue;
      const rect = candidate.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - originX;
      const dy = rect.top + rect.height / 2 - originY;
      const forward = dx * direction.x + dy * direction.y;
      if (forward <= 1) continue;
      const cross = Math.abs(dx * direction.y - dy * direction.x);
      const score = forward + cross * 2;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) this.focusNav(bestIndex);
    return true;
  }

  private onPointerOver = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>('[data-nav]');
    if (!item) return;
    /* Scroll articles are keyboard stops, not hover controls. Focusing one merely because a new
       screen appeared under the stationary pointer steals the intended ENGAGE/RETRY landing. */
    if (item.dataset['nav'] === 'scroll') return;
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

    /*
     * Trust the document, not the bookkeeping. `navIndex` only advanced when this class moved
     * focus, so anything else that focused a control — a click, assistive technology, a test
     * harness — left the index stale and the next Tab appeared to do nothing because it
     * "moved" to where focus already was. Derive it from what is actually focused instead.
     */
    if (active) {
      const actual = this.navItems.indexOf(active);
      if (actual >= 0) this.navIndex = actual;
    }

    if (
      (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight')
      && this.moveResultArrow(key)
    ) {
      return true;
    }

    const activeMode = active?.closest<HTMLButtonElement>('.lv-mode-option') ?? null;
    if (activeMode && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      this.adjustModeOption(activeMode, key === 'ArrowLeft' ? -1 : 1);
      return true;
    }

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
      /* Roving radio focus can be moved by assistive technology independently of navIndex.
         Activate the radio that actually owns focus; never fall through to a stale BEGIN item. */
      if (activeMode) {
        activeMode.click();
        return true;
      }
      const node = this.navItems[this.navIndex];
      if (!node) return true;
      if (node.dataset['nav'] === 'scroll') return false;
      if (node.dataset['nav'] === 'segmented') {
        /* A radiogroup has no click behaviour of its own, so Enter used to be a dead key that
           still played a confirm. Advance through the options instead, wrapping. */
        const buttons = node.querySelectorAll<HTMLElement>('[data-seg]');
        if (buttons.length > 0) {
          let cur = 0;
          for (let i = 0; i < buttons.length; i++) {
            if (buttons[i]!.getAttribute('aria-checked') === 'true') cur = i;
          }
          buttons[(cur + 1) % buttons.length]!.click();
        }
        return true;
      }
      /* No sound here: the widget's own click handler reports it. Firing one as well double-
         struck every keyboard activation — inaudible while this was an unlistened event, a
         real double click now that it drives the bus. */
      node.click();
      return true;
    }
    return false;
  }

  private adjust(dir: number): void {
    const node = this.navItems[this.navIndex];
    if (!node) return;
    if (node.dataset['nav'] === 'mode' && node instanceof HTMLButtonElement) {
      this.adjustModeOption(node, dir);
      return;
    }
    if (node.dataset['nav'] === 'route') {
      const current = COURSE_IDS.indexOf(node.dataset['route'] as CourseId);
      const next = clamp(current + dir, 0, COURSE_IDS.length - 1);
      const nextNode = this.routeNodes.get(COURSE_IDS[next]!)?.button;
      if (nextNode && next !== current) {
        const navIndex = this.navItems.indexOf(nextNode);
        if (navIndex >= 0) this.focusNav(navIndex);
      }
      return;
    }
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

  private adjustModeOption(option: HTMLButtonElement, dir: number): void {
    const group = option.closest<HTMLElement>('[role="radiogroup"]');
    if (!group) return;
    const options = [...group.querySelectorAll<HTMLButtonElement>('.lv-mode-option')];
    if (options.length === 0) return;
    const current = Math.max(0, options.indexOf(option));
    const next = (current + dir + options.length) % options.length;
    const target = options[next]!;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (target !== option) target.click();
  }

  /* ------------------------------------------------------------ shell helper */

  private makeView(name: ScreenView, label: string, cls = ''): HTMLElement {
    const view = el('section', `lv-screen lv-screen--${name} ${cls}`.trim());
    view.dataset['view'] = name;
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
    action: ScreenAction,
    onClick: () => void,
    sub?: string,
    hint?: string,
  ): HTMLElement {
    const b = el('button', `lv-btn ${cls}`.trim());
    b.type = 'button';
    b.dataset['nav'] = 'button';
    b.dataset['action'] = action;
    const marker = el('span', 'lv-btn-mark');
    const wrap = el('span', 'lv-btn-body');
    if (hint) {
      const line = el('span', 'lv-btn-line');
      const chip = el('kbd', 'lv-btn-hint', hint);
      chip.lang = 'en';
      /* The chip is decoration for the eye; the shortcut is announced via aria-keyshortcuts,
         which is what it is for. Without this the accessible name comes out as "RESTARTN". */
      chip.setAttribute('aria-hidden', 'true');
      b.setAttribute('aria-keyshortcuts', hint.toLowerCase());
      line.append(englishText('span', 'lv-btn-t', text), chip);
      wrap.appendChild(line);
    } else {
      wrap.appendChild(englishText('span', 'lv-btn-t', text));
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

  /** Marks an actual overflow owner as a keyboard-readable region without changing its layout. */
  private scrollRegion(node: HTMLElement, id: string, label: string): HTMLElement {
    node.tabIndex = 0;
    node.dataset['nav'] = 'scroll';
    node.dataset['scrollRegion'] = id;
    node.setAttribute('role', 'region');
    node.setAttribute('aria-label', label);
    return node;
  }

  /**
   * The physical C binding is shared, but survival has one additional camera stop. Keeping the
   * mode branch at the presentation boundary means the time-trial legend remains byte-for-byte
   * the copy players already learned while the survival primer tells the whole truth.
   */
  private controlCopy(row: ControlRow, short: boolean): string {
    if (row.id === 'camera-toggle' && this.runMode === SURVIVAL_RUN_MODE_ID) {
      return short
        ? this.translator.messages.survival.cameraCycleShort
        : this.translator.messages.survival.cameraCycle;
    }
    return this.translator.messages.controls[short ? row.short ?? row.action : row.action];
  }

  /** A single instrument strip, deliberately distinct from the dormant campaign card grid. */
  private buildModeSelector(): HTMLElement {
    const m = this.translator.messages.survival;
    const section = el('section', 'lv-mode-select');
    section.dataset['modeSelector'] = 'title';
    section.hidden = this.host.getRunMode === undefined || this.host.selectRunMode === undefined;
    section.appendChild(englishText('div', 'lv-kicker lv-mode-kicker', m.mode));

    const group = el('div', 'lv-mode-seg');
    group.dataset['value'] = this.runMode;
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', m.modeSelection);

    const options: readonly (readonly [RunModeId, string])[] = [
      [DEFAULT_RUN_MODE_ID, m.timeTrial],
      [SURVIVAL_RUN_MODE_ID, m.meteorSurvival],
    ];
    for (const [mode, label] of options) {
      const option = englishText('button', 'lv-mode-option', label) as HTMLButtonElement;
      option.type = 'button';
      option.tabIndex = mode === this.runMode ? 0 : -1;
      option.dataset['nav'] = 'mode';
      option.dataset['seg'] = mode;
      option.dataset['runMode'] = mode;
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', mode === this.runMode ? 'true' : 'false');
      option.addEventListener('click', () => {
        if (mode === this.runMode || !this.host.selectRunMode) return;
        this.opts.onSound('click');
        this.host.selectRunMode(mode);
      });
      group.appendChild(option);
    }
    section.appendChild(group);
    return section;
  }

  private buildRouteStrip(): HTMLElement {
    const m = this.translator.messages;
    const section = el('section', 'lv-route-select');
    section.appendChild(englishText('div', 'lv-kicker lv-route-kicker', m.campaign.routeSelection));
    const group = el('div', 'lv-route-strip');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', m.campaign.routeSelection);

    for (let index = 0; index < COURSE_IDS.length; index++) {
      const id = COURSE_IDS[index]!;
      const copy = m.campaign.routes[id];
      const button = el('button', 'lv-route-card');
      button.type = 'button';
      button.dataset['nav'] = 'route';
      button.dataset['action'] = 'select-route';
      button.dataset['route'] = id;
      button.dataset['routeState'] = id === 'cairn-drift' ? 'available' : 'locked';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', id === 'cairn-drift' ? 'true' : 'false');
      button.setAttribute('aria-disabled', id === 'needle-grave' ? 'true' : 'false');

      const top = el('span', 'lv-route-top');
      top.append(
        englishText('span', 'lv-route-index', String(index + 1).padStart(2, '0')),
        englishText('span', 'lv-route-state', id === 'cairn-drift' ? m.campaign.available : m.campaign.locked),
        englishText('span', 'lv-route-selected', id === 'cairn-drift' ? m.campaign.selected : ''),
      );
      const selected = top.querySelector<HTMLElement>('.lv-route-selected')!;
      selected.hidden = id !== 'cairn-drift';

      const name = englishText('span', 'lv-route-name', copy.name);
      const destination = englishText('span', 'lv-route-destination', copy.destination);
      const rankWrap = el('span', 'lv-route-rank');
      rankWrap.append(
        englishText('span', 'lv-route-rank-key', m.results.rank),
        englishText('span', 'lv-route-rank-value', m.campaign.noRank),
      );
      const rank = rankWrap.querySelector<HTMLElement>('.lv-route-rank-value')!;
      const lock = writeEnglishTokens(
        el('span', 'lv-route-lock'),
        id === 'needle-grave' ? copy.lockReason : '',
        ['CAIRN DRIFT', 'NEEDLE GRAVE'],
      );
      lock.id = `lv-route-lock-${id}`;
      lock.hidden = id !== 'needle-grave';
      button.setAttribute('aria-describedby', lock.id);
      button.append(top, name, destination, rankWrap, lock);
      button.addEventListener('click', () => {
        const route = this.campaignCourse(id);
        if (
          route.state === 'locked' ||
          id === this.campaign.activeCourseId ||
          this.campaign.navigationError === 'storage-unavailable'
        ) return;
        this.opts.onSound('click');
        this.host.selectRoute(id);
      });
      group.appendChild(button);
      this.routeNodes.set(id, {
        button,
        status: top.querySelector<HTMLElement>('.lv-route-state')!,
        selected,
        rank,
        lock,
      });
    }

    section.appendChild(group);
    return section;
  }

  /* ------------------------------------------------------------------- title */

  private buildTitle(): HTMLElement {
    const m = this.translator.messages;
    const survival = this.runMode === SURVIVAL_RUN_MODE_ID;
    const view = this.makeView('title', m.a11y.mainMenu);
    view.dataset['modeContext'] = this.runMode;
    const inner = el('div', 'lv-title');

    const eyebrow = el('div', 'lv-title-eyebrow');
    eyebrow.lang = 'en';
    this.nTitleSector = englishText(
      'span',
      'lv-title-sector',
      survival ? m.survival.meteorSurvival : m.meta.sectorName,
    );
    eyebrow.append(
      englishText('span', '', survival ? m.survival.mode : m.screens.sector),
      el('i', 'lv-dot'),
      this.nTitleSector,
    );

    const mark = el('h1', 'lv-wordmark');
    mark.lang = 'en';
    mark.setAttribute('aria-label', m.meta.gameTitle);
    const words = m.meta.gameTitle.split(' ');
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

    const tag = writeEnglishTokens(
      el('p', 'lv-tagline'),
      survival ? m.survival.titleTagline : m.meta.tagline,
      survival ? ['METEOR'] : ['CAIRN', 'TERMINUS'],
    );
    this.nTitleTagline = tag;

    const modeSelector = this.buildModeSelector();

    const routes = this.buildRouteStrip();
    routes.hidden = !CAMPAIGN_MODE_ENABLED;

    const campaignError = el('p', 'lv-campaign-error');
    campaignError.id = 'lv-campaign-error-title';
    if (CAMPAIGN_MODE_ENABLED) campaignError.dataset['campaignError'] = '1';
    campaignError.setAttribute('role', 'status');
    campaignError.setAttribute('aria-live', 'polite');
    campaignError.hidden = true;

    const menu = el('nav', 'lv-menu');
    menu.setAttribute('aria-label', m.a11y.mainMenu);
    const begin = this.button(
      m.screens.beginRun,
      'is-primary',
      'begin',
      () => this.host.start(),
      survival ? m.survival.endure : m.meta.destinationName,
    );
    const destination = begin.querySelector<HTMLElement>('.lv-btn-s');
    this.nBeginDestination = survival ? null : destination;
    if (destination) destination.lang = 'en';
    menu.append(
      begin,
      this.button(m.screens.settings, '', 'settings', () => this.show('settings')),
      this.button(m.screens.controls, '', 'controls', () => this.show('controls')),
    );

    const locale = el('div', 'lv-seg');
    locale.dataset['nav'] = 'segmented';
    locale.dataset['value'] = this.translator.locale;
    locale.tabIndex = 0;
    locale.setAttribute('role', 'radiogroup');
    locale.setAttribute('aria-label', this.translator.messages.a11y.languageSelection);
    const localeOptions: readonly (readonly [Locale, string])[] = [
      ['ko', this.translator.messages.screens.korean],
      ['en', this.translator.messages.screens.english],
    ];
    for (const [value, text] of localeOptions) {
      const button = el('button', 'lv-seg-b', text);
      button.lang = value;
      button.type = 'button';
      button.tabIndex = -1;
      button.dataset['seg'] = value;
      button.dataset['locale'] = value;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', value === this.translator.locale ? 'true' : 'false');
      button.addEventListener('click', () => {
        this.opts.onSound('click');
        this.host.requestLocale(value);
      });
      locale.appendChild(button);
    }
    menu.appendChild(locale);

    const foot = el('div', 'lv-title-foot');
    foot.lang = 'en';
    const hull = englishText('span', '', '');
    hull.append(document.createTextNode(`${m.screens.hullPrefix} `), englishText('span', '', m.meta.shipName));
    const primary = englishText('span', '', '');
    primary.append(document.createTextNode(`${m.screens.primaryPrefix} `), englishText('span', '', m.meta.starName));
    foot.append(
      hull,
      el('i', 'lv-dot'),
      primary,
      el('i', 'lv-dot'),
      englishText('span', '', m.screens.navigationNominal),
    );

    inner.append(eyebrow, mark, rule, tag, modeSelector, routes, campaignError, menu, foot);
    view.append(el('div', 'lv-veil'), inner);
    return view;
  }

  /* ---------------------------------------------------------------- briefing */

  private buildBriefing(): HTMLElement {
    return this.runMode === SURVIVAL_RUN_MODE_ID
      ? this.buildSurvivalBriefing()
      : this.buildTimeTrialBriefing();
  }

  private buildTimeTrialBriefing(): HTMLElement {
    const m = this.translator.messages;
    const routeCopy = m.campaign.routes[this.campaign.activeCourseId];
    const view = this.makeView('briefing', m.a11y.runBriefing);
    const panel = Screens.frame(el('div', 'lv-brief'));

    const head = el('header', 'lv-brief-head');
    const transit = writeEnglishTokens(
      el('div', 'lv-brief-sub'),
      `${m.screens.transitTo} ${routeCopy.destination}`,
      [routeCopy.destination],
    );
    transit.lang = 'en';
    this.nBriefTransit = transit;
    this.nBriefTitle = englishText('h2', 'lv-brief-title', routeCopy.sectorName);
    head.append(
      englishText('div', 'lv-kicker', m.screens.runBriefing),
      this.nBriefTitle,
      transit,
    );

    const cols = el('div', 'lv-brief-cols');
    this.scrollRegion(cols, 'briefing-content', m.a11y.runBriefing);

    const stats = el('dl', 'lv-stats');
    const addStat = (k: string, v: string, valueLang?: 'en'): HTMLElement => {
      const row = el('div', 'lv-stat');
      const value = el('dd', '', v);
      if (valueLang) value.lang = valueLang;
      row.append(englishText('dt', '', k), value);
      stats.appendChild(row);
      return value;
    };
    /*
     * These two are measurements, not fiction, so they are read rather than typed. CORRIDOR
     * shipped as the literal "48.6 KM" against a real 54,362 m — wrong by 10-12% in a block
     * whose other rows were all true — and MARKERS was "09" hard-coded beside a course that
     * publishes its own gate count. A copied number in this file has to track a generator in
     * another one, which is the arrangement that goes stale silently. `--` until the first
     * telemetry frame, because a placeholder is honest and a stale literal is not.
     */
    this.nStatMarkers = addStat(m.screens.markers, '--');
    this.nStatCorridor = addStat(m.screens.corridor, '--', 'en');
    addStat(m.screens.primary, m.meta.starName, 'en');
    addStat(m.screens.hull, m.meta.shipName, 'en');
    addStat(m.screens.drift, m.screens.closing, 'en');

    const objectives = el('section', 'lv-objectives');
    objectives.hidden = !CAMPAIGN_MODE_ENABLED;
    objectives.appendChild(englishText('div', 'lv-kicker', m.campaign.routeObjectives));
    const objectiveList = el('ul', 'lv-objective-list');
    objectiveList.dataset['objectiveList'] = 'briefing';
    objectives.appendChild(objectiveList);
    this.writeObjectiveList(objectiveList, this.campaignCourse());

    const meta = el('div', 'lv-brief-meta');
    meta.append(stats, objectives);

    const prose = el('div', 'lv-prose');
    for (let i = 0; i < CAMPAIGN_BRIEF_KEYS.length; i++) {
      const p = writeEnglishTokens(
        el('p', 'lv-prose-l'),
        routeCopy[CAMPAIGN_BRIEF_KEYS[i]!],
        ['ACHRA', 'CAIRN', 'NEEDLE GRAVE', 'SHEAR'],
      );
      p.style.setProperty('--n', String(i));
      prose.appendChild(p);
      this.nBriefLines.push(p);
    }

    const primer = this.buildControlPrimer();

    cols.append(meta, prose, primer);

    const actions = el('div', 'lv-actions');
    actions.append(
      this.button(m.screens.engage, 'is-primary', 'engage', () => this.host.engage()),
      this.button(m.screens.back, 'is-ghost', 'return', () => this.opts.onBack()),
    );

    panel.append(head, cols, actions);
    view.append(el('div', 'lv-veil'), panel);
    return view;
  }

  private buildSurvivalBriefing(): HTMLElement {
    const m = this.translator.messages;
    const s = m.survival;
    const view = this.makeView('briefing', m.a11y.runBriefing);
    view.dataset['modeContext'] = SURVIVAL_RUN_MODE_ID;
    const panel = Screens.frame(el('div', 'lv-brief lv-brief--survival'));

    const head = el('header', 'lv-brief-head');
    head.append(
      englishText('div', 'lv-kicker', m.screens.runBriefing),
      englishText('h2', 'lv-brief-title', s.meteorSurvival),
      englishText('div', 'lv-brief-sub', s.briefingSub),
    );

    const stats = el('dl', 'lv-stats lv-stats--survival');
    const addStat = (key: string, value: string): void => {
      const row = el('div', 'lv-stat');
      row.append(englishText('dt', '', key), englishText('dd', '', value));
      stats.appendChild(row);
    };
    addStat(s.activeThreat, s.ballistic);
    addStat(s.intensity, s.rising);
    addStat(s.pressure, s.continuous);
    addStat(m.screens.hull, m.meta.shipName);
    addStat(s.viewCycle, 'CHASE / COCKPIT / FAR CHASE');

    const prose = el('div', 'lv-prose lv-prose--survival');
    const lines = [s.briefingLine1, s.briefingLine2, s.briefingLine3] as const;
    for (let i = 0; i < lines.length; i++) {
      const paragraph = writeEnglishTokens(
        el('p', 'lv-prose-l'),
        lines[i]!,
        ['METEOR FIELD', 'BALLISTIC', 'FIELD'],
      );
      paragraph.style.setProperty('--n', String(i));
      prose.appendChild(paragraph);
    }

    const meta = el('div', 'lv-brief-meta');
    meta.appendChild(stats);
    const primer = this.buildControlPrimer();
    const cols = el('div', 'lv-brief-cols lv-brief-cols--survival');
    this.scrollRegion(cols, 'survival-briefing-content', m.a11y.runBriefing);
    cols.append(meta, prose, primer);

    const actions = el('div', 'lv-actions');
    actions.append(
      this.button(m.screens.engage, 'is-primary', 'engage', () => this.host.engage()),
      this.button(m.screens.back, 'is-ghost', 'return', () => this.opts.onBack()),
    );

    panel.append(head, cols, actions);
    view.append(el('div', 'lv-veil'), panel);
    return view;
  }

  private buildControlPrimer(): HTMLElement {
    const m = this.translator.messages;
    const primer = el('div', 'lv-primer');
    primer.appendChild(englishText('div', 'lv-kicker', m.screens.coreControls));
    const keys = el('ul', 'lv-primer-list');
    for (let i = 0; i < CONTROLS.length; i++) {
      const row = CONTROLS[i]!;
      if (!row.primer) continue;
      const li = el('li');
      li.dataset['control'] = row.id;
      li.append(keyChips(row, m.controls.or), el('span', '', this.controlCopy(row, true)));
      keys.appendChild(li);
    }
    primer.appendChild(keys);
    return primer;
  }

  /**
   * Course facts from telemetry. Cheap enough for the frame loop: two integer comparisons that
   * fail on every frame after the first.
   */
  setCourseFacts(courseLength: number | undefined, gateTotal: number): void {
    if (this.nStatMarkers && gateTotal !== this.pMarkers) {
      this.pMarkers = gateTotal;
      this.nStatMarkers.textContent = gateTotal > 0 ? (gateTotal < 10 ? '0' : '') + gateTotal : '--';
    }
    if (this.nStatCorridor) {
      const m = courseLength !== undefined && courseLength > 0 ? Math.round(courseLength) : -1;
      if (m !== this.pCorridor) {
        this.pCorridor = m;
        this.nStatCorridor.textContent =
          m > 0 ? `${formatDistance(m)} ${distanceUnit(m)}` : '--';
      }
    }
  }

  /* --------------------------------------------------------------- countdown */

  private buildCountdown(): {
    view: HTMLElement;
    num: HTMLElement;
    ring: SVGCircleElement;
    label: HTMLElement;
  } {
    const m = this.translator.messages;
    const view = this.makeView('countdown', m.a11y.launchCountdown, 'is-passthrough');
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
    num.lang = 'en';
    const label = englishText('div', 'lv-count-k', m.screens.launchSequence);
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
      delete view.dataset['countdownValue'];
      return;
    }
    view.dataset['open'] = '1';
    const go = value <= 0;
    view.dataset['countdownValue'] = go ? 'go' : String(value);
    this.nCountNum.textContent = go ? this.translator.messages.screens.go : String(value);
    this.nCountNum.dataset['go'] = go ? '1' : '0';
    this.nCountLabel.textContent = go
      ? this.translator.messages.screens.vectorLive
      : this.translator.messages.screens.launchSequence;
    retrigger(this.nCountNum, 'is-tick');
    retrigger(this.nCountRing as unknown as HTMLElement, 'is-sweep');
  }

  /* ------------------------------------------------------------------- pause */

  private buildPause(): HTMLElement {
    const m = this.translator.messages;
    const view = this.makeView('pause', m.a11y.paused);
    const panel = Screens.frame(el('div', 'lv-pause'));
    panel.append(
      englishText('div', 'lv-kicker', m.screens.flightHeld),
      englishText('h2', 'lv-pause-title', m.screens.paused),
      el('p', 'lv-pause-sub', m.screens.pauseDetail),
    );
    const menu = el('nav', 'lv-menu lv-menu--tight');
    menu.append(
      this.button(m.screens.resume, 'is-primary', 'resume', () => this.host.resume()),
      /* Second, where the genre puts it: in a time trial "go again" is the common verb, and
         N was previously the only way to do it and was documented nowhere. The sub-label
         teaches the shortcut at the point of use. */
      this.button(m.screens.restart, '', 'restart', () => this.host.restart(), undefined, 'N'),
      this.button(m.screens.settings, '', 'settings', () => this.show('settings')),
      this.button(m.screens.controls, '', 'controls', () => this.show('controls')),
      this.button(m.screens.abortRun, 'is-danger', 'abort', () => this.host.quitToTitle()),
    );
    panel.appendChild(menu);
    view.append(el('div', 'lv-veil lv-veil--blur'), panel);
    return view;
  }

  /* ---------------------------------------------------------------- settings */

  private buildSettings(): { view: HTMLElement; body: HTMLElement } {
    const m = this.translator.messages;
    const view = this.makeView('settings', m.a11y.settings);
    const panel = Screens.frame(el('div', 'lv-settings'));
    panel.append(
      englishText('div', 'lv-kicker', m.screens.configuration),
      englishText('h2', 'lv-panel-title', m.screens.settings),
    );

    const body = el('div', 'lv-set-body');
    for (const group of SETTING_GROUPS) {
      const sec = el('section', 'lv-set-group');
      sec.append(englishText('h3', 'lv-set-grouptitle', m.settings[group.title]));
      for (const row of group.rows) sec.appendChild(this.buildSettingRow(row));
      body.appendChild(sec);
    }

    const actions = el('div', 'lv-actions');
    actions.append(this.button(m.screens.back, 'is-primary', 'return', () => this.opts.onBack()));

    panel.append(body, actions);
    view.append(el('div', 'lv-veil lv-veil--blur'), panel);
    return { view, body };
  }

  private buildSettingRow(row: RowSpec): HTMLElement {
    const m = this.translator.messages;
    const label = m.settings[row.label];
    const node = el('div', `lv-set-row lv-set-row--${row.kind}`);
    const labels = el('div', 'lv-set-labels');
    labels.appendChild(englishText('span', 'lv-set-label', label));
    if (row.hint !== undefined) {
      const hint = writeEnglishTokens(
        el('span', 'lv-set-hint'),
        m.settings[row.hint],
        row.hint === 'defaultCameraHint' ? ['C'] : [],
      );
      labels.appendChild(hint);
    }
    node.appendChild(labels);

    if (row.kind === 'enum') {
      const group = el('div', 'lv-seg');
      group.dataset['nav'] = 'segmented';
      group.dataset['setting'] = row.key;
      group.dataset['value'] = String(this.host.getSettings()[row.key]);
      group.tabIndex = 0;
      group.lang = 'en';
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', label);
      for (const [value, textKey] of row.options) {
        const b = el('button', 'lv-seg-b', m.settings[textKey]);
        b.lang = 'en';
        b.type = 'button';
        b.tabIndex = -1;
        b.dataset['seg'] = value;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.addEventListener('click', () => {
          this.commit(row.key, value as Settings[typeof row.key]);
          this.opts.onSound('click');
        });
        group.appendChild(b);
      }
      node.appendChild(group);
      this.settingNodes.push({
        row,
        apply: (v) => {
          group.dataset['value'] = String(v);
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
      sw.dataset['setting'] = row.key;
      sw.dataset['value'] = String(this.host.getSettings()[row.key]);
      sw.lang = 'en';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', 'false');
      sw.setAttribute('aria-label', label);
      sw.append(el('i', 'lv-switch-knob'), englishText('span', 'lv-switch-t', m.settings.off));
      sw.addEventListener('click', () => {
        const next = sw.getAttribute('aria-checked') !== 'true';
        this.commit(row.key, next);
        this.opts.onSound('click');
      });
      node.appendChild(sw);
      this.settingNodes.push({
        row,
        apply: (v) => {
          sw.dataset['value'] = String(v);
          const on = v === true;
          sw.setAttribute('aria-checked', on ? 'true' : 'false');
          const t = sw.querySelector('.lv-switch-t');
          if (t) t.textContent = on ? m.settings.on : m.settings.off;
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
    input.dataset['setting'] = row.key;
    input.dataset['value'] = String(this.host.getSettings()[row.key]);
    input.lang = 'en';
    input.setAttribute('aria-label', label);
    const read = el('span', 'lv-slider-v', '');
    read.lang = 'en';
    const track = el('div', 'lv-slider-track');
    const fill = el('i', 'lv-slider-fill');
    track.appendChild(fill);
    wrap.append(track, input, read);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      fill.style.transform = `scaleX(${((v - row.min) / (row.max - row.min)).toFixed(4)})`;
      read.textContent = row.fmt(v);
      this.commit(row.key, v);
    });
    node.appendChild(wrap);
    this.settingNodes.push({
      row,
      apply: (v) => {
        const num = typeof v === 'number' ? v : row.min;
        input.dataset['value'] = String(num);
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
    const m = this.translator.messages;
    const view = this.makeView('controls', m.a11y.controls);
    const panel = Screens.frame(el('div', 'lv-controls'));
    panel.append(
      englishText('div', 'lv-kicker', m.controls.heading),
      englishText('h2', 'lv-panel-title', m.screens.controls),
    );

    const list = el('ul', 'lv-keys');
    for (let i = 0; i < CONTROLS.length; i++) {
      const row = CONTROLS[i]!;
      const li = el('li', 'lv-key');
      li.dataset['control'] = row.id;
      li.style.setProperty('--n', String(i));
      li.append(keyChips(row, m.controls.or), el('span', 'lv-key-d', this.controlCopy(row, false)));
      list.appendChild(li);
    }

    const note = writeEnglishTokens(el('p', 'lv-note'), m.controls.pointerLockNote, ['ESC']);
    const actions = el('div', 'lv-actions');
    actions.append(this.button(m.screens.back, 'is-primary', 'return', () => this.opts.onBack()));

    panel.append(list, note, actions);
    view.append(el('div', 'lv-veil lv-veil--blur'), panel);
    return view;
  }

  /* ----------------------------------------------------------------- results */

  private buildResults(): { view: HTMLElement; body: HTMLElement } {
    const view = this.makeView('results', this.translator.messages.a11y.runComplete);
    const panel = el('div', 'lv-results');
    const body = el('div', 'lv-res-body');
    body.lang = 'en';
    panel.appendChild(body);
    view.append(el('div', 'lv-veil lv-veil--results'), panel);
    return { view, body };
  }

  showResult(r: RunResult): void {
    const m = this.translator.messages;
    const campaignCourse = this.campaignCourse(r.courseId ?? this.campaign.activeCourseId);
    const routeCopy = m.campaign.routes[campaignCourse.id];
    const body = this.nResultBody;
    body.textContent = '';
    body.lang = 'en';
    delete body.dataset['state'];
    delete body.dataset['runMode'];
    delete body.dataset['survivalResult'];
    this.views.get('results')?.setAttribute('aria-label', m.a11y.runComplete);

    /* headline: destination left, rating right, so the top edge is not weighted to one side */
    const head = el('header', 'lv-res-head');
    head.style.setProperty('--n', '0');
    const headline = el('div', 'lv-res-headline');
    headline.append(
      el(
        'div',
        'lv-kicker',
        r.gatesCleared >= r.gatesTotal ? m.results.arrivalConfirmed : m.results.runComplete,
      ),
      englishText('h2', 'lv-res-title', routeCopy.destination),
    );
    const rank = el('div', 'lv-res-rank');
    rank.append(el('div', 'lv-res-k', m.results.rank), englishText('div', 'lv-res-letter', r.rank));
    rank.dataset['rank'] = r.rank.charAt(0).toUpperCase();
    head.append(headline, rank);
    body.appendChild(head);

    /* two columns: the run's headline number on the left, its shape on the right */
    const main = el('div', 'lv-res-main');
    this.scrollRegion(main, 'result-content', m.a11y.runComplete);
    main.style.setProperty('--n', '1');

    const left = el('div', 'lv-res-left');
    const newlyUnlocked = r.newlyUnlockedCourseId ?? this.campaign.newlyUnlockedCourseId;
    const unlockedCourse = newlyUnlocked
      ? this.campaign.routes.find((route) => route.id === newlyUnlocked)
      : undefined;
    const revealedCourse =
      unlockedCourse !== undefined &&
      unlockedCourse.state !== 'locked' &&
      unlockedCourse.id !== campaignCourse.id
        ? unlockedCourse
        : undefined;
    const advanceCourse =
      CAMPAIGN_MODE_ENABLED && this.campaign.navigationError !== 'storage-unavailable'
        ? revealedCourse
        : undefined;
    if (CAMPAIGN_MODE_ENABLED && revealedCourse) {
      const unlock = el('div', 'lv-route-unlock');
      unlock.dataset['route'] = revealedCourse.id;
      unlock.dataset['routeState'] = revealedCourse.state;
      const unlockText = writeEnglishTokens(
        el('span'),
        m.campaign.routes[revealedCourse.id].unlockNotice,
        ['CAIRN DRIFT', 'NEEDLE GRAVE'],
      );
      unlockText.lang = this.translator.locale;
      unlock.append(
        el('i', 'lv-route-unlock-mark'),
        unlockText,
      );
      left.appendChild(unlock);
    }
    const timeBlock = el('div', 'lv-res-timeblock');
    timeBlock.append(
      el('div', 'lv-res-k', m.results.totalTime),
      el('div', 'lv-res-time', formatTime(r.totalTime)),
    );
    if (r.isNewBest) {
      const badge = el('div', 'lv-newbest');
      badge.append(el('i', 'lv-newbest-tick'), el('span', '', m.results.newRecord));
      timeBlock.appendChild(badge);
    } else if (r.bestTime != null) {
      const d = r.totalTime - r.bestTime;
      const delta = el(
        'div',
        'lv-res-delta',
        m.results.bestComparison(formatDelta(d), formatTime(r.bestTime)),
      );
      delta.dataset['tone'] = d <= 0 ? 'good' : 'bad';
      timeBlock.appendChild(delta);
    }
    left.appendChild(timeBlock);

    const stats = el('dl', 'lv-res-stats');
    const addStat = (
      k: string,
      v: string,
      tone?: string,
      englishTokens: readonly string[] = [],
      id?: string,
    ): void => {
      const cell = el('div', 'lv-res-stat');
      if (id) cell.dataset['stat'] = id;
      const value = writeEnglishTokens(el('dd', 'lv-res-statv'), v, englishTokens);
      cell.append(el('dt', 'lv-res-statk', k), value);
      if (tone) cell.dataset['tone'] = tone;
      stats.appendChild(cell);
    };
    addStat(m.results.markers, `${r.gatesCleared} / ${r.gatesTotal}`);
    addStat(m.results.topSpeed, `${Math.round(r.topSpeed)} ${m.results.speedUnit}`, undefined, [m.results.speedUnit]);
    addStat(
      m.results.hull,
      r.cleanRun ? m.results.clean : m.results.damaged,
      r.cleanRun ? 'good' : 'warn',
    );
    if (
      r.gatesCleared > 0 &&
      typeof r.maxGateOffset === 'number' &&
      Number.isFinite(r.maxGateOffset)
    ) {
      addStat(
        m.results.widestMarker,
        `${formatPrecisionOffsetPercent(r.maxGateOffset)} / <${(PRECISION_MAX_OFFSET * 100).toFixed(1)}%`,
        r.maxGateOffset < PRECISION_MAX_OFFSET ? 'good' : 'warn',
        [],
        'max-gate-offset',
      );
    }
    left.appendChild(stats);

    const objectives = el('section', 'lv-objectives lv-objectives--result');
    objectives.hidden = !CAMPAIGN_MODE_ENABLED;
    objectives.appendChild(el('div', 'lv-kicker', m.campaign.routeObjectives));
    const objectiveList = el('ul', 'lv-objective-list');
    objectiveList.dataset['objectiveList'] = 'results';
    objectives.appendChild(objectiveList);
    this.writeObjectiveList(objectiveList, campaignCourse, r);
    left.appendChild(objectives);

    /*
     * Splits, with a bar per segment so the shape of the run reads without arithmetic.
     *
     * The delta column compares each leg against THE SAME LEG on the best run, which is the
     * only comparison that means anything: an earlier version compared a leg against the
     * shortest leg of the same run, so a long leg read as lost time when it was merely long.
     * The column is omitted entirely when there is no best to compare against, rather than
     * printed with a placeholder — a column of dashes still implies the comparison exists.
     */
    const bestSplits = r.bestSplits;
    const hasBest = bestSplits.length >= r.splits.length && r.splits.length > 0;

    /*
     * `splits` holds cairn crossing times and stops at the last cairn, but the clock stops at
     * the terminus plane 6800 m further on. Without a row for that run-in the ELAPSED column's
     * last value is not TOTAL and the table cannot account for the run — a reviewer measured
     * 6.06 s, 9.8% of a run, sitting unattributed beside a headline that included it. Worse,
     * a run lost on the approach showed nine near-zero deltas: the only diagnostic in the game
     * reporting nothing wrong about the leg where everything went wrong.
     *
     * The figure is exact rather than derived-and-fragile: `totalTime` and `splits` are the
     * same clock on the same run, so this is plain subtraction with nothing sampled.
     */
    const lastSplit = r.splits.length > 0 ? r.splits[r.splits.length - 1]! : 0;
    const runIn = r.totalTime - lastSplit;
    /*
     * The run-in delta needs the two runs to have cleared the same number of cairns. Leg i is
     * leg i on a fixed course whatever happened afterwards, but "the run-in" spans a different
     * distance if one run started it from cairn 9 and the other from cairn 2.
     */
    const bestLast = bestSplits.length > 0 ? bestSplits[bestSplits.length - 1]! : 0;
    const hasRunInBest =
      hasBest && r.bestTime != null && bestSplits.length === r.splits.length;
    const bestRunIn = hasRunInBest ? r.bestTime! - bestLast : 0;

    const table = el('div', 'lv-res-splits');
    table.dataset['delta'] = hasBest ? '1' : '0';
    const header = el('div', 'lv-res-row is-head');
    header.append(
      el('span', '', m.results.marker),
      el('span', '', m.results.segment),
      el('span', ''),
      el('span', '', m.results.elapsed),
    );
    if (hasBest) header.append(el('span', '', m.results.versusBest));
    table.appendChild(header);

    /* The run-in is a leg like any other for scaling purposes — leaving it out of `slowest`
       would let its bar overflow the track, since it is the third-longest leg on the course. */
    let fastest = Infinity;
    let slowest = 0;
    for (let i = 0; i < r.splits.length; i++) {
      const seg = r.splits[i]! - (i > 0 ? r.splits[i - 1]! : 0);
      if (seg < fastest) fastest = seg;
      if (seg > slowest) slowest = seg;
    }
    if (runIn > slowest) slowest = runIn;
    if (runIn < fastest) fastest = runIn;
    /** One table row. Shared so the run-in cannot drift from the cairn legs. */
    const addRow = (
      n: number,
      label: string,
      seg: number,
      cumulative: number,
      delta: number | null,
      terminus = false,
    ): void => {
      const row = el('div', 'lv-res-row');
      row.style.setProperty('--n', String(n));
      const bar = el('span', 'lv-res-barwrap');
      const fill = el('i', 'lv-res-bar');
      /* Normalised against the slowest segment, floored so the quickest is still a visible
         mark rather than a sliver of nothing. */
      fill.style.setProperty('--w', (slowest > 0 ? 0.08 + 0.92 * (seg / slowest) : 1).toFixed(3));
      bar.appendChild(fill);
      row.append(
        el('span', 'lv-res-idx', label),
        el('span', 'lv-res-seg', seg.toFixed(2)),
        bar,
        el('span', 'lv-res-cum', formatTime(cumulative)),
      );
      if (hasBest) {
        /* An empty cell rather than a skipped one: the grid has the track either way, and a
           blank reads as "not comparable" where a dash reads as a measured zero. */
        const dlt = el('span', 'lv-res-dlt', delta === null ? '' : formatDelta(delta));
        if (delta !== null) {
          /* Tone keys off the rounded value too, so a leg that prints ±0.00 is not coloured as
             a gain. */
          dlt.dataset['tone'] =
            Math.round(delta * 100) === 0 ? 'flat' : delta < 0 ? 'good' : 'bad';
        }
        row.appendChild(dlt);
      }
      row.dataset['fast'] = seg <= fastest + 1e-6 ? '1' : '0';
      if (terminus) row.dataset['term'] = '1';
      if (terminus) row.querySelector<HTMLElement>('.lv-res-idx')!.lang = 'en';
      table.appendChild(row);
    };

    for (let i = 0; i < r.splits.length; i++) {
      const seg = r.splits[i]! - (i > 0 ? r.splits[i - 1]! : 0);
      /* Leg i on this run against leg i on the best run — like for like. */
      const delta = hasBest ? seg - (bestSplits[i]! - (i > 0 ? bestSplits[i - 1]! : 0)) : null;
      addRow(i, (i + 1 < 10 ? '0' : '') + (i + 1), seg, r.splits[i]!, delta);
    }

    /* The run-in to the terminus. Its ELAPSED is TOTAL, which is what makes the column
       reconcile with the headline instead of falling short of it. */
    addRow(
      r.splits.length,
      routeCopy.terminalMarker,
      runIn,
      r.totalTime,
      hasRunInBest ? runIn - bestRunIn : null,
      true,
    );

    const right = el('div', 'lv-res-right');
    right.appendChild(table);
    main.append(left, right);
    body.appendChild(main);

    const actions = el('div', 'lv-actions lv-actions--res');
    actions.style.setProperty('--n', '2');
    if (advanceCourse) {
      const nextRoute = this.button(
          m.campaign.nextRoute,
          'is-primary',
          'next-route',
          () => this.host.selectRoute(advanceCourse.id),
          m.campaign.routes[advanceCourse.id].destination,
        );
      nextRoute.dataset['route'] = advanceCourse.id;
      actions.appendChild(
        nextRoute,
      );
      actions.querySelector<HTMLElement>('.lv-btn-s')!.lang = 'en';
    }
    actions.append(
      this.button(m.results.runAgain, advanceCourse ? '' : 'is-primary', 'again', () => this.host.restart()),
      CAMPAIGN_MODE_ENABLED
        ? this.button(m.campaign.routeSelect, 'is-ghost', 'route-select', () => this.host.showRouteSelect())
        : this.button(m.results.returnToTitle, 'is-ghost', 'return', () => this.host.quitToTitle()),
    );
    const error = el('p', 'lv-campaign-error lv-campaign-error--result');
    error.lang = this.translator.locale;
    if (CAMPAIGN_MODE_ENABLED) error.dataset['campaignError'] = '1';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;
    body.appendChild(error);
    body.appendChild(actions);
    this.syncCampaignErrors();

    if (this.view === 'results') {
      this.collectNav(this.views.get('results')!);
      this.focusNav(0, false);
    }
  }

  /**
   * Survival is scored by duration, not by route splits or rank. It receives its own compact
   * after-action layout so a failed hull is not mislabeled as a failed time trial and so the
   * six numbers worth comparing fit without manufacturing a fake segment graph.
   */
  showSurvivalResult(r: SurvivalRunResult): void {
    const m = this.translator.messages;
    const s = m.survival;
    const body = this.nResultBody;
    body.textContent = '';
    body.lang = this.translator.locale;
    body.dataset['state'] = 'survival';
    body.dataset['runMode'] = SURVIVAL_RUN_MODE_ID;
    body.dataset['survivalResult'] = '1';
    this.views.get('results')?.setAttribute('aria-label', s.resultA11y);

    const head = el('header', 'lv-res-head lv-survival-head');
    head.style.setProperty('--n', '0');
    const headline = el('div', 'lv-res-headline');
    const detail = el('p', 'lv-survival-detail', s.resultDetail);
    detail.lang = this.translator.locale;
    headline.append(
      englishText('div', 'lv-kicker', s.runEnded),
      englishText('h2', 'lv-res-title', s.meteorSurvival),
      detail,
    );

    const lockup = el('div', 'lv-survival-lockup');
    lockup.setAttribute('aria-hidden', 'true');
    lockup.append(
      englishText('span', 'lv-survival-lockup-k', s.mode),
      englishText('span', 'lv-survival-lockup-v', s.arenaName),
      el('i', 'lv-survival-pulse'),
    );
    head.append(headline, lockup);
    body.appendChild(head);

    const main = el('div', 'lv-survival-result-main');
    this.scrollRegion(main, 'survival-result-content', s.resultA11y);
    main.style.setProperty('--n', '1');
    const hero = el('section', 'lv-survival-hero');
    hero.dataset['stat'] = 'survived';
    const timeBlock = el('div', 'lv-res-timeblock');
    timeBlock.append(
      englishText('div', 'lv-res-k', s.survived),
      englishText('div', 'lv-res-time', formatTime(r.totalTime)),
    );
    if (r.isNewBest) {
      const badge = el('div', 'lv-newbest');
      badge.append(el('i', 'lv-newbest-tick'), englishText('span', '', s.newRecord));
      timeBlock.appendChild(badge);
    } else if (r.bestTime != null) {
      const delta = englishText(
        'div',
        'lv-res-delta',
        `${formatDelta(r.totalTime - r.bestTime)} vs ${s.best} ${formatTime(r.bestTime)}`,
      );
      delta.dataset['tone'] = r.totalTime >= r.bestTime ? 'good' : 'bad';
      timeBlock.appendChild(delta);
    }
    hero.appendChild(timeBlock);

    const best = el('div', 'lv-survival-best');
    best.dataset['stat'] = 'best';
    const displayedBest = r.isNewBest ? r.totalTime : r.bestTime;
    best.append(
      englishText('span', 'lv-survival-best-k', s.best),
      englishText('span', 'lv-survival-best-v', formatTime(displayedBest)),
    );
    hero.appendChild(best);

    const ledger = el('section', 'lv-survival-ledger');
    ledger.appendChild(englishText('div', 'lv-kicker', s.endure));
    const stats = el('dl', 'lv-survival-stats');
    const addStat = (id: string, label: string, value: string, tone?: 'good' | 'warn'): void => {
      const row = el('div', 'lv-survival-stat');
      row.dataset['stat'] = id;
      if (tone) row.dataset['tone'] = tone;
      row.append(
        englishText('dt', 'lv-survival-stat-k', label),
        englishText('dd', 'lv-survival-stat-v', value),
      );
      stats.appendChild(row);
    };
    addStat('dodged', s.dodged, String(r.meteorsDodged).padStart(3, '0'), 'good');
    addStat('near-misses', s.nearMisses, String(r.nearMisses).padStart(2, '0'));
    addStat(
      'impacts',
      s.impacts,
      String(r.collisions).padStart(2, '0'),
      r.collisions === 0 ? 'good' : 'warn',
    );
    addStat('peak-threat', s.peakThreat, String(r.peakActive).padStart(2, '0'));
    addStat('top-speed', s.topSpeed, `${Math.round(r.topSpeed)} ${m.results.speedUnit}`);
    ledger.appendChild(stats);
    main.append(hero, ledger);
    body.appendChild(main);

    const actions = el('div', 'lv-actions lv-actions--res lv-survival-actions');
    actions.style.setProperty('--n', '2');
    actions.append(
      this.button(s.retry, 'is-primary', 'retry', () => this.host.restart(), undefined, 'N'),
      this.button(s.returnToTitle, 'is-ghost', 'return', () => this.host.quitToTitle()),
    );
    body.appendChild(actions);

    if (this.view === 'results') {
      this.collectNav(this.views.get('results')!);
      this.focusNav(0, false);
    }
  }

  /**
   * Reuses the results shell for a terminal hull breach without presenting a failed run as a
   * result. Retry remains primary and the route strip is the only alternate exit. The N chip
   * matches Input's real restart binding, so the visible shortcut and action path agree.
   */
  showFailure(elapsed: number): void {
    const m = this.translator.messages;
    const body = this.nResultBody;
    body.textContent = '';
    body.lang = 'en';
    body.dataset['state'] = 'failure';
    delete body.dataset['runMode'];
    delete body.dataset['survivalResult'];
    this.views.get('results')?.setAttribute('aria-label', m.a11y.hullBreach);

    const head = el('header', 'lv-res-head');
    head.style.setProperty('--n', '0');
    head.appendChild(el('h2', 'lv-res-title', m.results.hullBreach));

    const timeBlock = el('div', 'lv-res-timeblock');
    timeBlock.style.setProperty('--n', '1');
    timeBlock.append(
      el('div', 'lv-res-k', m.results.time),
      el('div', 'lv-res-time', formatTime(elapsed)),
    );

    const actions = el('div', 'lv-actions lv-actions--res');
    actions.style.setProperty('--n', '2');
    actions.append(
      this.button(m.results.retry, 'is-primary', 'retry', () => this.host.restart(), undefined, 'N'),
      CAMPAIGN_MODE_ENABLED
        ? this.button(m.campaign.routeSelect, 'is-ghost', 'route-select', () => this.host.showRouteSelect())
        : this.button(m.results.returnToTitle, 'is-ghost', 'return', () => this.host.quitToTitle()),
    );

    body.append(head, timeBlock, actions);

    /* setPhase may have opened this shared view before its failure body was populated. Refresh
       navigation after mutation so keyboard focus lands on RETRY instead of a detached result
       action from the previous run. */
    if (this.view === 'results') {
      this.collectNav(this.views.get('results')!);
      this.focusNav(0, false);
    }
  }
}

/** Re-exported so the lead can label quality options consistently elsewhere. */
export const QUALITY_ORDER: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
