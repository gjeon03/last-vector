/**
 * Root of the interface layer. Owns the DOM tree, the phase -> screen mapping, global
 * keyboard routing, and the pause state (which the Phase contract does not model).
 *
 * The game only ever talks to this class. Everything below it is private.
 */

import './styles.css';

import type { HudHost, MissionResult, Phase, Settings, Telemetry } from '../core/contracts.ts';
import { FONT, UI } from '../core/art.ts';
import type { Translator } from '../i18n/index.ts';
import { Hud, el } from './Hud.ts';
import {
  Screens,
  type CampaignViewModel,
  type ScreenFocusToken,
  type ScreenView,
  type UiSound,
} from './Screens.ts';

/** Views that are reachable from more than one place and therefore need a return target. */
const SUB_VIEWS: readonly ScreenView[] = ['settings', 'controls'];

export class Overlay {
  private readonly root: HTMLElement;
  private readonly hud: Hud;
  private readonly screens: Screens;
  private readonly host: HudHost;
  private readonly grain: HTMLElement;

  private phase: Phase = 'boot';
  private paused = false;
  private returnTo: ScreenView = 'title';
  private pointerLocked = false;
  private showFps = false;
  private countdown: number | null = null;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(rootEl: HTMLElement, host: HudHost, translator: Translator) {
    this.host = host;

    this.root = el('div', 'lv-root');
    this.root.dataset['phase'] = 'boot';
    this.applyTokens(translator);

    this.grain = el('div', 'lv-veneer');
    this.grain.setAttribute('aria-hidden', 'true');
    this.grain.append(el('i', 'lv-veneer-scan'), el('i', 'lv-veneer-grain'));
    this.root.appendChild(this.grain);

    this.hud = new Hud(translator);
    this.hud.mount(this.root);

    this.screens = new Screens(this.proxyHost(), {
      onSettingChanged: () => this.syncSettings(),
      onSound: (kind) => this.emitSound(kind),
      onBack: () => this.back(),
    }, translator);
    this.screens.mount(this.root);

    rootEl.appendChild(this.root);

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.root);
    }

    this.syncSettings();
    this.hud.resize();
  }

  /* ------------------------------------------------------------------ tokens */

  private applyTokens(translator: Translator): void {
    const s = this.root.style;
    s.setProperty('--c-primary', UI.primary);
    s.setProperty('--c-primary-dim', UI.primaryDim);
    s.setProperty('--c-accent', UI.accent);
    s.setProperty('--c-good', UI.good);
    s.setProperty('--c-warn', UI.warn);
    s.setProperty('--c-bad', UI.bad);
    s.setProperty('--c-ink', UI.ink);
    s.setProperty('--c-ink-dim', UI.inkDim);
    s.setProperty('--c-ink-faint', UI.inkFaint);
    s.setProperty('--c-panel', UI.panel);
    s.setProperty('--c-panel-solid', UI.panelSolid);
    s.setProperty('--c-hairline', UI.hairline);
    s.setProperty('--c-scanline', UI.scanline);
    const hangul = translator.locale === 'ko' ? `${FONT.hangul}, ` : '';
    s.setProperty('--f-mono', `${hangul}${FONT.mono}`);
    s.setProperty('--f-display', `${hangul}${FONT.display}`);
  }

  /* ------------------------------------------------------------- host bridge */

  /** Wraps the game host so screen state stays consistent with what the game is told. */
  private proxyHost(): HudHost {
    const host = this.host;
    return {
      // Pass-through only. The call sites — hover, click, back on the actual widgets — are the
      // real work and are not done here.
      audio: host.audio,
      start: () => {
        this.paused = false;
        host.start();
      },
      /* `start` opens the briefing; `engage` is what actually launches the run. Routing the
         briefing's own button through `start` would send it back to itself. */
      engage: () => {
        this.paused = false;
        host.engage();
      },
      restart: () => {
        /* Close the pause screen before handing off, so the menu never lingers over a run
           that has already been torn down and rebuilt underneath it. */
        this.paused = false;
        this.applyView();
        host.restart();
      },
      resume: () => {
        this.paused = false;
        this.applyView();
        host.resume();
      },
      quitToTitle: () => {
        this.paused = false;
        host.quitToTitle();
      },
      selectMission: (missionId) => host.selectMission(missionId),
      showMissionSelect: () => {
        this.paused = false;
        host.showMissionSelect();
      },
      pause: () => host.pause(),
      requestLocale: (locale) => host.requestLocale(locale),
      setSetting: (key, value) => host.setSetting(key, value),
      getSettings: () => host.getSettings(),
    };
  }

  private syncSettings(): void {
    const settings: Settings = this.host.getSettings();
    if (settings.showFps !== this.showFps) {
      this.showFps = settings.showFps;
      this.hud.setShowFps(settings.showFps);
    }
  }

  /**
   * Single funnel for interface audio. Every widget already reports through here, so the bus
   * is driven from one place rather than sprinkled across the screens — which also means a new
   * control cannot be added silently: it has to opt in to `onSound` to be navigable at all.
   *
   * `move` (keyboard selection changed) maps to `hover` (pointer selection changed) because
   * they are the same event to the player: the highlighted thing is now a different thing.
   */
  private emitSound(kind: UiSound): void {
    const audio = this.host.audio;
    if (kind === 'click') audio.click();
    else if (kind === 'back') audio.back();
    else audio.hover();
    this.root.dispatchEvent(
      new CustomEvent('lv-ui', { detail: kind, bubbles: true, composed: true }),
    );
  }

  /* --------------------------------------------------------------- lifecycle */

  update(t: Telemetry, dt: number): void {
    if (this.disposed) return;
    this.hud.update(t, dt);
    /* Course facts the briefing states. Guarded inside; they change once per run at most. */
    this.screens.setCourseFacts(t.courseLength, t.gate.total);
  }

  syncCampaign(viewModel: CampaignViewModel): void {
    this.screens.syncCampaign(viewModel);
  }

  focusStageSelection(): void {
    this.screens.focusStageSelection();
  }

  captureFocusToken(): ScreenFocusToken | null {
    return this.screens.captureFocusToken();
  }

  restoreFocusToken(token: ScreenFocusToken | null): void {
    this.screens.restoreFocusToken(token);
  }

  setPhase(phase: Phase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.root.dataset['phase'] = phase;
    if (phase !== 'flying') this.paused = false;
    if (phase === 'title' || phase === 'briefing') this.returnTo = phase;
    this.applyView();
  }

  showResult(result: MissionResult): void {
    this.screens.showResult(result);
  }

  showFailure(elapsed: number): void {
    this.screens.showFailure(elapsed);
  }

  setCountdown(value: number | null): void {
    this.countdown = value;
    this.screens.setCountdown(value);
    this.hud.setCountdownActive(value !== null);
    this.applyHudActivity();
  }

  radio(speaker: string, text: string, durationBasisLength?: number): void {
    this.hud.radio(speaker, text, durationBasisLength);
  }

  setPointerLocked(locked: boolean): void {
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    this.root.dataset['locked'] = locked ? '1' : '0';
    /* Losing the pointer mid-run is the universal "I need a menu" gesture. */
    if (!locked && this.inRun() && !this.paused) {
      this.paused = true;
      this.applyView();
      this.host.pause();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.screens.dispose();
    this.hud.dispose();
    this.root.remove();
  }

  /**
   * Phases in which the player is committed to a run and the pointer is captured. `beginRun`
   * takes the lock during `countdown`, so gating recovery on `flying` alone left a ~3 s window
   * where Esc and losing focus did nothing and the run went live and timed with a dead mouse.
   * It is also a predicate the shipped copy depends on: CONTROLS states "ESC releases it and
   * holds the flight" and lists ESC -> Pause unconditionally, and during the countdown that
   * was simply false. One predicate for all three call sites so a fourth cannot drift.
   */
  private inRun(): boolean {
    return this.phase === 'flying' || this.phase === 'countdown';
  }

  /* -------------------------------------------------------------- view logic */

  /**
   * The game's phase always wins: if the run ends while the player is buried in the settings
   * menu, they get the results screen, not a stuck sub-view.
   */
  private applyView(): void {
    this.screens.show(this.viewForState());
    this.applyHudActivity();
  }

  private viewForState(): ScreenView {
    if (this.paused && this.inRun()) return 'pause';
    switch (this.phase) {
      case 'title':
        return 'title';
      case 'briefing':
        return 'briefing';
      case 'failed':
      case 'finished':
        return 'results';
      default:
        return 'none';
    }
  }

  private applyHudActivity(): void {
    const flying = this.phase === 'flying';
    const counting = this.phase === 'countdown' || this.countdown !== null;
    this.hud.setActive(flying || counting, counting || this.paused);
    const menuish =
      this.phase === 'title' ||
      this.phase === 'briefing' ||
      this.phase === 'failed' ||
      this.phase === 'finished' ||
      this.paused;
    this.grain.dataset['on'] = menuish ? '1' : '0';
  }

  private back(): void {
    const view = this.screens.current();
    if (SUB_VIEWS.includes(view)) {
      const target = this.paused && this.phase === 'flying' ? 'pause' : this.viewForState();
      this.screens.show(target === 'none' ? this.returnTo : target);
      this.applyHudActivity();
      this.emitSound('back');
      return;
    }
    if (view === 'pause') {
      this.paused = false;
      this.applyView();
      this.host.resume();
      this.emitSound('back');
      return;
    }
    if (view === 'briefing') {
      this.host.quitToTitle();
      this.emitSound('back');
    }
  }

  /* ---------------------------------------------------------------- keyboard */

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (this.disposed) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      /* Tab is allowed through so the interface moves focus itself. Input.ts unconditionally
         preventDefaults Tab on a window listener — correct in flight — so relying on the
         browser's native focus move would leave the five range widgets as keyboard traps.
         Left/Right still fall through to the range, which owns them. */
      if (
        ev.key !== 'Escape' &&
        ev.key !== 'ArrowUp' &&
        ev.key !== 'ArrowDown' &&
        ev.key !== 'Tab'
      ) {
        return;
      }
    }

    if (ev.key === 'Escape') {
      const view = this.screens.current();
      if (view === 'none') {
        if (this.inRun()) {
          ev.preventDefault();
          this.paused = true;
          this.applyView();
          this.host.pause();
          this.emitSound('back');
        }
        return;
      }
      ev.preventDefault();
      this.back();
      return;
    }

    if (this.screens.current() === 'none') return;
    if (this.screens.handleKey(ev)) ev.preventDefault();
  };

  private onResize = (): void => {
    this.hud.resize();
  };
}
