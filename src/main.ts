import './boot.css';
import { Game } from './game/Game.ts';
import { FICTION, UI } from './core/art.ts';
import { clamp01 } from './core/mathx.ts';
import type { HarnessApi, HarnessInput, PerfSample } from './core/harness.ts';
import type { Settings } from './core/contracts.ts';

/**
 * Entry point. Three jobs: prove the browser can run the thing, hold a loading screen while
 * the procedural sky bakes, and expose the automation surface the playtest harness drives.
 */

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

function fail(title: string, detail: string): void {
  root!.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'lv-fatal';
  box.innerHTML = `<h1>${title}</h1><p>${detail}</p>`;
  root!.appendChild(box);
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
function showLoader(): { setProgress: (v: number, label: string) => void; done: () => void } {
  const el = document.createElement('div');
  el.className = 'lv-loader';
  el.innerHTML = `
    <div class="lv-loader__inner">
      <div class="lv-loader__title">${FICTION.gameTitle}</div>
      <div class="lv-loader__bar"><i></i></div>
      <div class="lv-loader__label">initialising</div>
    </div>
  `;
  root!.appendChild(el);
  const bar = el.querySelector('i') as HTMLElement;
  const label = el.querySelector('.lv-loader__label') as HTMLElement;
  return {
    setProgress(v: number, text: string) {
      bar.style.transform = `scaleX(${clamp01(v)})`;
      label.textContent = text;
    },
    done() {
      el.classList.add('is-done');
      window.setTimeout(() => el.remove(), 700);
    },
  };
}

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function boot(): Promise<void> {
  if (!supportsWebGL2()) {
    fail(
      'WEBGL2 REQUIRED',
      'This browser could not create a WebGL2 context. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.',
    );
    return;
  }

  const loader = showLoader();
  await nextPaint();
  loader.setProgress(0.15, 'charting the drift');
  await nextPaint();

  // A seed can be pinned from the URL so a failing headless run is reproducible. The world
  // is generated once at construction, which is why this is a boot-time input, not a method.
  const seedParam = new URLSearchParams(window.location.search).get('seed');
  const parsedSeed = seedParam !== null ? Number.parseInt(seedParam, 10) : NaN;
  const seed = Number.isFinite(parsedSeed) ? parsedSeed >>> 0 : undefined;

  let game: Game;
  try {
    game = new Game(seed === undefined ? { root: root! } : { root: root!, seed });
  } catch (error) {
    fail('FAILED TO LAUNCH', String(error instanceof Error ? error.message : error));
    return;
  }

  loader.setProgress(0.8, 'lighting the cairns');
  await nextPaint();

  game.start();
  await game.ready();
  loader.setProgress(1, 'ready');
  loader.done();

  game.onContextLost = () => {
    fail(
      'GRAPHICS CONTEXT LOST',
      'The browser dropped the WebGL context — usually a driver reset, a GPU switch, or another tab exhausting video memory. Reload the page to continue.',
    );
  };

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
    version: '1.0.0',
    seed: game.seed,
    ready: () => game.ready(),
    startRun: () => game.beginRun(),
    telemetry: () => game.getTelemetry(),
    phase: () => game.getPhase(),
    result: () => game.getResult(),
    setInput: (input: HarnessInput | null) => game.setHarnessInput(input),
    setAutopilot: (enabled, options) => game.setAutopilot(enabled, options?.skill ?? 1),
    seekCourse: (t) => game.seekCourse(t),
    vantage: (name) => game.setVantage(name),
    vantages: () => game.vantageNames(),
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
    activeInput: () => game.getActiveInput(),
    gateHistory: () => game.getGateHistory(),
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
    setPaused: (paused) => game.setPaused(paused),
    setFixedTimestep: (dt) => game.setFixedTimestep(dt),
    errors: () => game.getErrors(),
  };

  window.__LV = api;
  document.documentElement.dataset.lvReady = '1';
}

document.documentElement.style.setProperty('--lv-ink', UI.ink);

void boot();
