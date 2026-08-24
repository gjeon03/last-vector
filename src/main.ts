import './boot.css';
import { Game } from './game/Game.ts';
import { UI } from './core/art.ts';
import { clamp01 } from './core/mathx.ts';
import type { HarnessApi, HarnessInput, PerfSample } from './core/harness.ts';
import type { Settings } from './core/contracts.ts';
import {
  createTranslator,
  LocaleStore,
  prepareLocaleFonts,
  type Translator,
} from './i18n/index.ts';

/**
 * Entry point. Three jobs: prove the browser can run the thing, hold a loading screen while
 * the procedural sky bakes, and expose the automation surface the playtest harness drives.
 */

const localeStore = new LocaleStore();
const bootLocale = localeStore.reload();
document.documentElement.lang = bootLocale;
const bootTranslator = createTranslator(bootLocale);
document.title = bootTranslator.messages.meta.documentTitle;
document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
  'content',
  bootTranslator.messages.meta.documentDescription,
);
// boot.css is imported before this module executes, so its @font-face rules are registered before
// the coordinator probes them. This is the only preparation created for the boot locale.
const bootFontPreparation = prepareLocaleFonts(bootLocale);

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

function fail(title: string, detail: string): void {
  const box = document.createElement('div');
  box.className = 'lv-fatal';
  const heading = document.createElement('h1');
  heading.textContent = title;
  const message = document.createElement('p');
  message.textContent = detail;
  box.append(heading, message);
  root!.replaceChildren(box);
}

function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

/**
 * The nebula bake and the asteroid generation block the main thread for a moment, so the
 * loading card is written and painted *before* the Game constructor runs.
 */
function showLoader(translator: Translator): { setProgress: (v: number, label: string) => void; done: () => void } {
  const loader = document.createElement('div');
  loader.className = 'lv-loader';
  const inner = document.createElement('div');
  inner.className = 'lv-loader__inner';
  const title = document.createElement('div');
  title.className = 'lv-loader__title';
  title.textContent = translator.messages.meta.gameTitle;
  const barTrack = document.createElement('div');
  barTrack.className = 'lv-loader__bar';
  const bar = document.createElement('i');
  barTrack.appendChild(bar);
  const label = document.createElement('div');
  label.className = 'lv-loader__label';
  label.textContent = translator.messages.loader.initialising;
  inner.append(title, barTrack, label);
  loader.appendChild(inner);
  root!.appendChild(loader);
  return {
    setProgress(v: number, text: string) {
      bar.style.transform = `scaleX(${clamp01(v)})`;
      label.textContent = text;
    },
    done() {
      loader.classList.add('is-done');
      window.setTimeout(() => loader.remove(), 700);
    },
  };
}

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function boot(): Promise<void> {
  if (!supportsWebGL2()) {
    bootFontPreparation.cancel();
    fail(
      bootTranslator.messages.loader.webglRequiredTitle,
      bootTranslator.messages.loader.webglRequiredDetail,
    );
    return;
  }

  const loader = showLoader(bootTranslator);
  await nextPaint();
  loader.setProgress(0.15, bootTranslator.messages.loader.chartingDrift);
  await nextPaint();
  const bootFontResult = await bootFontPreparation.initial;

  // A seed can be pinned from the URL so a failing headless run is reproducible. The world
  // is generated once at construction, which is why this is a boot-time input, not a method.
  const seedParam = new URLSearchParams(window.location.search).get('seed');
  const parsedSeed = seedParam !== null ? Number.parseInt(seedParam, 10) : NaN;
  const seed = Number.isFinite(parsedSeed) ? parsedSeed >>> 0 : undefined;

  let game: Game;
  try {
    const fonts = {
      result: bootFontResult,
      settled: bootFontPreparation.settled,
      cancel: bootFontPreparation.cancel,
    };
    game = new Game(seed === undefined
      ? { root: root!, localeStore, fonts }
      : { root: root!, localeStore, fonts, seed });
  } catch (error) {
    bootFontPreparation.cancel();
    const translator = createTranslator(localeStore.get());
    fail(
      translator.messages.loader.launchFailedTitle,
      String(error instanceof Error ? error.message : error),
    );
    return;
  }

  // Install this before any awaited boot work. A context loss during shader/audio prewarm used to
  // happen before the handler existed, leaving ready() unresolved behind an immortal loader.
  let graphicsFailed = false;
  game.onContextLost = () => {
    graphicsFailed = true;
    const locale = game.getLocaleState();
    const translator = createTranslator(locale.active ?? locale.selected);
    fail(
      translator.messages.loader.graphicsContextLostTitle,
      translator.messages.loader.graphicsContextLostDetail,
    );
  };

  loader.setProgress(0.8, bootTranslator.messages.loader.lightingCairns);
  await nextPaint();

  /* Build the audio graph HERE, behind the loader, not on the player's first gesture.
     `AudioEngine.build()` is declared async but has no await before its work: it generates a
     3.6 s stereo reverb impulse, a 4 s pink buffer and a 2.5 s white buffer — roughly 970,000
     samples of JS DSP with exp and pow per sample — synchronously in the caller's task. The
     unlock listener is a capture-phase window pointerdown/keydown, so that ran inside the very
     first interaction with the page and froze the main thread for 0.07-0.43 s, measured, scaling
     linearly with CPU throttle to 433.9 ms at 6x. Worst on exactly the machines the low profile
     exists for.
     `unlock()` stays the resume-only path: it finds `building` already resolved and does nothing
     but resume a suspended context, which it already handles. Creating a context outside a
     gesture is allowed — it starts suspended; only resuming needs the gesture. */
  loader.setProgress(0.88, bootTranslator.messages.loader.spinningDrive);
  await nextPaint();
  /* `prewarm()`, NOT `unlock()`, and raced against a timeout.
     The first draft of this awaited `unlock()`, which resumes as well as builds. On an
     autoplay-gated browser the context is suspended at boot, and `resume()` on a context the
     browser has not authorised leaves its promise UNSETTLED — the spec appends it to
     [[pending resume promises]] and aborts — so `.catch()` cannot catch it and the loader hangs
     on this line forever. It would also have started the score before the player touched
     anything, wherever autoplay is permitted. Nothing on the boot critical path may await an
     unbounded promise, hence the race as well as the narrower call. */
  await Promise.race([
    game.audio.prewarm().catch(() => {
      /* Audio is a garnish. A browser that refuses us here must not stop the game from booting. */
    }),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 2000);
    }),
  ]);

  game.start();
  await game.ready();
  if (graphicsFailed) return;
  loader.setProgress(1, bootTranslator.messages.loader.ready);
  loader.done();

  installHarness(game);
}

function installHarness(game: Game): void {
  const waitFrames = (n: number): Promise<void> =>
    new Promise((resolve) => {
      let left = n;
      const tick = (): void => {
        if (--left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  const api: HarnessApi = {
    version: '1.6.0',
    seed: game.seed,
    ready: () => game.ready(),
    startRun: (options) => game.beginRun(options?.skipIntro === true),
    telemetry: () => game.getTelemetry(),
    phase: () => game.getPhase(),
    result: () => game.getResult(),
    damageHull: (amount) => game.damageHull(amount),
    stageCollision: () => game.stageCollision(),
    setInput: (input: HarnessInput | null) => game.setHarnessInput(input),
    setAutopilot: (enabled, options) => game.setAutopilot(enabled, options?.skill ?? 1),
    seekCourse: (t) => game.seekCourse(t),
    vantage: (name) => game.setVantage(name),
    clearVantage: () => game.clearVantage(),
    vantages: () => game.vantageNames(),
    vantageSubjects: () => game.vantageSubjects(),
    setDriven: (driven: boolean) => {
      game.setDriven(driven);
      if (!driven) game.setFixedTimestep(null);
    },
    step: async (frames, dt = 1 / 60) => {
      // Driven mode stays on for the whole call *and* afterwards: releasing it before the
      // await lets the rAF loop sneak in an extra simulated frame, which silently corrupts
      // any measurement that assumes elapsed === frames * dt.
      game.setDriven(true);
      game.setFixedTimestep(dt);
      for (let i = 0; i < frames; i++) game.frame(dt);
      await Promise.resolve();
    },
    present: async () => {
      // Safe in either mode: while driven the rAF loop advances nothing, so this only waits
      // for the compositor to show what the last step already rendered.
      await waitFrames(2);
    },
    pose: () => game.getPose(),
    shipDebug: () => game.getShipDebug(),
    activeInput: () => game.getActiveInput(),
    gateHistory: () => game.getGateHistory(),
    hazard: (samples?: number) => game.getHazard(samples),
    channelExcursion: () => game.getChannelExcursion(),
    audioState: () => game.getAudioState(),
    profile: async (seconds: number): Promise<PerfSample> => {
      game.setDriven(false);
      game.setFixedTimestep(null);
      await waitFrames(30);
      game.beginProfile();
      const start = performance.now();
      await new Promise<void>((resolve) => window.setTimeout(resolve, seconds * 1000));
      return game.collectProfile((performance.now() - start) / 1000);
    },
    settings: () => game.settings.value,
    setSettings: (patch: Partial<Settings>) => game.settings.patch(patch),
    locale: () => game.getLocaleState(),
    cameraMode: () => game.getCameraMode(),
    cockpitDebug: () => game.getCockpitDebug(),
    cockpitMfd: () => game.getCockpitMfd(),
    setPaused: (paused) => game.setPaused(paused),
    pauseMenu: (on) => game.pauseMenu(on),
    setFixedTimestep: (dt) => game.setFixedTimestep(dt),
    errors: () => game.getErrors(),
  };

  window.__LV = api;
  document.documentElement.dataset.lvReady = '1';
}

document.documentElement.style.setProperty('--lv-ink', UI.ink);

void boot();
