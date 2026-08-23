#!/usr/bin/env node

import {
  callHarness,
  inspectHarness,
  openBootScenario,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const LOCALE_STORAGE_KEY = 'last-vector.locale.v1';
const REQUIRED_METHODS = ['ready', 'startRun', 'phase', 'damageHull', 'setDriven', 'step', 'locale', 'errors'];
const EXPECTED_METADATA = {
  ko: {
    title: 'LAST VECTOR — THE CAIRN DRIFT',
    description: '붕괴하는 잔해 항로를 가르는 우주 비행 게임.',
  },
  en: {
    title: 'LAST VECTOR — The Cairn Drift',
    description: 'Fly the cairn line through a collapsing debris corridor.',
  },
};

await runManagedSuite({
  suite: 'localization',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runLocalization,
});

async function runLocalization({ report, session, options }) {
  const page = session.page;
  await callHarness(page, 'ready', [], options.timeoutMs);

  await report.check({
    id: 'I18N.default-korean',
    name: 'A clean first boot selects Korean before player-facing UI',
    assertion:
      'An isolated empty-storage boot uses lang=ko before both loader and Overlay insertion, exposes '
      + 'the exact 1.4.0 locale contract, and remains unlocked on the title screen.',
  }, async () => {
    const scenario = await openBootScenario(session, { initScripts: [installBootProbe] });
    try {
      await ready(scenario.page, options.timeoutMs);
      const inspection = await inspectHarness(scenario.page, REQUIRED_METHODS);
      const locale = await localeSnapshot(scenario.page);
      const boot = await scenario.page.evaluate(() => window.__LV_BOOT_PROBE ?? []);
      const title = await titleLocaleEvidence(scenario.page);
      const evidence = { inspection, locale, boot, title, requests: scenario.requests };
      verify(inspection.version === '1.4.0', 'Harness version is not exactly 1.4.0.', evidence);
      verify(inspection.methods.locale === true, 'Harness locale() capability is missing.', evidence);
      verify(locale.selected === 'ko' && locale.active === null && locale.locked === false,
        'Empty storage did not produce an unlocked Korean title.', evidence);
      verify(locale.documentLang === 'ko', 'The clean document language is not Korean.', evidence);
      verify(boot.some((entry) => entry.kind === 'loader' && entry.lang === 'ko'),
        'Korean was not active when the loader entered the document.', evidence);
      verify(boot.some((entry) => entry.kind === 'overlay' && entry.lang === 'ko'),
        'Korean was not active when the Overlay entered the document.', evidence);
      verify(title.value === 'ko' && title.checked.length === 1 && title.checked[0] === 'ko',
        'The clean title selector does not contain exactly one checked Korean option.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.persisted-english-clean-boot',
    name: 'Persisted English is applied before first boot UI construction',
    assertion:
      'A separate storageState-seeded context uses lang=en when its loader and Overlay are inserted, '
      + 'without sharing context, cache, requests, or init scripts with the Korean boot.',
  }, async () => {
    const scenario = await openBootScenario(session, {
      localStorageSeed: { [LOCALE_STORAGE_KEY]: 'en' },
      initScripts: [installBootProbe],
    });
    try {
      await ready(scenario.page, options.timeoutMs);
      const locale = await localeSnapshot(scenario.page);
      const boot = await scenario.page.evaluate(() => window.__LV_BOOT_PROBE ?? []);
      const title = await titleLocaleEvidence(scenario.page);
      const evidence = { locale, boot, title, requests: scenario.requests };
      verify(locale.selected === 'en' && locale.active === null && locale.locked === false,
        'Persisted English did not produce an unlocked English title.', evidence);
      verify(locale.documentLang === 'en', 'The persisted-English document language is not English.', evidence);
      verify(boot.some((entry) => entry.kind === 'loader' && entry.lang === 'en'),
        'English was not active when the loader entered the document.', evidence);
      verify(boot.some((entry) => entry.kind === 'overlay' && entry.lang === 'en'),
        'English was not active when the Overlay entered the document.', evidence);
      verify(boot.some((entry) => entry.kind === 'loader' && entry.text.includes('initialising')),
        'The first persisted-English loader did not use the English loader catalog.', evidence);
      verify(title.value === 'en' && title.checked.length === 1 && title.checked[0] === 'en',
        'The persisted-English title selector does not contain exactly one checked English option.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });

  await report.check({
    id: 'I18N.title-selector',
    name: 'Title locale changes update document state and preserve semantic focus',
    assertion:
      'From the initially focused BEGIN RUN action, keyboard navigation performs ko -> en -> ko; '
      + 'each change persists, replaces the visible Overlay, updates metadata, and keeps focus on '
      + 'the locale radiogroup; directly focused radios are restored, and an independent context-loss '
      + 'scenario resolves fatal copy from the current locale.',
  }, async () => {
    const initial = await localeSnapshot(page);
    verify(initial.selected === 'ko' && initial.active === null, 'Managed title did not start unlocked in Korean.', initial);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await assertLocaleFocus(page);

    const koreanRoot = await page.locator('.lv-root').elementHandle();
    await page.keyboard.press('ArrowRight');
    await waitForSelected(page, 'en');
    const english = await localeSnapshot(page);
    const englishTitle = await titleLocaleEvidence(page);
    const englishMetadata = await metadataEvidence(page);
    const englishFocus = await assertLocaleFocus(page);
    const englishStored = await page.evaluate((key) => localStorage.getItem(key), LOCALE_STORAGE_KEY);
    const koreanDetached = koreanRoot ? !(await koreanRoot.evaluate((node) => node.isConnected)) : false;

    const englishRoot = await page.locator('.lv-root').elementHandle();
    await page.keyboard.press('ArrowLeft');
    await waitForSelected(page, 'ko');
    const korean = await localeSnapshot(page);
    const koreanTitle = await titleLocaleEvidence(page);
    const koreanMetadata = await metadataEvidence(page);
    const koreanFocus = await assertLocaleFocus(page);
    const koreanStored = await page.evaluate((key) => localStorage.getItem(key), LOCALE_STORAGE_KEY);
    const englishDetached = englishRoot ? !(await englishRoot.evaluate((node) => node.isConnected)) : false;

    const directEnglishRoot = await page.locator('.lv-root').elementHandle();
    await page.locator('[data-view="title"][data-open="1"] [data-locale="en"]').evaluate((radio) => {
      radio.focus();
      radio.click();
    });
    await waitForSelected(page, 'en');
    const directEnglishFocus = await directLocaleFocus(page);
    const directEnglishDetached = directEnglishRoot
      ? !(await directEnglishRoot.evaluate((node) => node.isConnected))
      : false;

    const directKoreanRoot = await page.locator('.lv-root').elementHandle();
    await page.locator('[data-view="title"][data-open="1"] [data-locale="ko"]').evaluate((radio) => {
      radio.focus();
      radio.click();
    });
    await waitForSelected(page, 'ko');
    const directKoreanFocus = await directLocaleFocus(page);
    const directKoreanDetached = directKoreanRoot
      ? !(await directKoreanRoot.evaluate((node) => node.isConnected))
      : false;

    const lossScenario = await openBootScenario(session);
    let contextLoss;
    try {
      await ready(lossScenario.page, options.timeoutMs);
      await focusLocale(lossScenario.page);
      await lossScenario.page.keyboard.press('ArrowRight');
      await waitForSelected(lossScenario.page, 'en');
      const beforeLoss = await metadataEvidence(lossScenario.page);
      await lossScenario.page.evaluate(() => {
        const canvas = document.querySelector('.lv-canvas');
        if (!canvas) throw new Error('Game canvas is missing.');
        canvas.dispatchEvent(new Event('webglcontextlost', { bubbles: false, cancelable: true }));
      });
      await lossScenario.page.locator('.lv-fatal').waitFor({ state: 'visible', timeout: 5_000 });
      const fatal = await lossScenario.page.evaluate(() => ({
        title: document.querySelector('.lv-fatal h1')?.textContent ?? null,
        detail: document.querySelector('.lv-fatal p')?.textContent ?? null,
      }));
      contextLoss = { beforeLoss, fatal };
    } finally {
      await lossScenario.close();
    }

    const evidence = {
      initial,
      english: {
        locale: english,
        title: englishTitle,
        metadata: englishMetadata,
        focus: englishFocus,
        stored: englishStored,
        oldRootDetached: koreanDetached,
      },
      korean: {
        locale: korean,
        title: koreanTitle,
        metadata: koreanMetadata,
        focus: koreanFocus,
        stored: koreanStored,
        oldRootDetached: englishDetached,
      },
      directRadio: {
        english: { focus: directEnglishFocus, oldRootDetached: directEnglishDetached },
        korean: { focus: directKoreanFocus, oldRootDetached: directKoreanDetached },
      },
      contextLoss,
    };
    verify(english.selected === 'en' && englishStored === 'en' && koreanDetached,
      'The Korean-to-English keyboard change did not persist and replace the Overlay.', evidence);
    verify(korean.selected === 'ko' && koreanStored === 'ko' && englishDetached,
      'The English-to-Korean keyboard change did not persist and replace the Overlay.', evidence);
    for (const state of [englishTitle, koreanTitle]) {
      verify(state.checked.length === 1 && state.checked[0] === state.value,
        'A reconstructed selector does not have exactly one checked option matching its value.', evidence);
    }
    verify(JSON.stringify(englishMetadata) === JSON.stringify({ lang: 'en', ...EXPECTED_METADATA.en })
      && JSON.stringify(koreanMetadata) === JSON.stringify({ lang: 'ko', ...EXPECTED_METADATA.ko }),
    'Title locale switching did not update lang, document title, and meta description together.', evidence);
    verify(directEnglishDetached && directEnglishFocus.locale === 'en'
      && directEnglishFocus.checked === 'true'
      && directKoreanDetached && directKoreanFocus.locale === 'ko'
      && directKoreanFocus.checked === 'true',
    'A directly focused locale radio was not restored after Overlay replacement.', evidence);
    verify(contextLoss.beforeLoss.lang === 'en'
      && contextLoss.fatal.title === 'GRAPHICS CONTEXT LOST'
      && contextLoss.fatal.detail
        === 'The browser dropped the WebGL context — usually a driver reset, a GPU switch, or another tab exhausting video memory. Reload the page to continue.',
    'Context-loss fatal UI did not resolve the current English locale at event time.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.run-lock',
    name: 'Beginning the briefing locks the selected locale for the run',
    assertion:
      'A title-only English selection becomes the active run locale before phase changes to briefing, '
      + 'and no visible locale control remains available after that boundary.',
  }, async () => {
    await focusLocale(page);
    await page.keyboard.press('ArrowRight');
    await waitForSelected(page, 'en');
    await page.locator('[data-view="title"][data-open="1"] [data-action="begin"]').click();
    await page.waitForFunction(() => window.__LV?.phase() === 'briefing');
    const storedBeforeRejectedRequest = await page.evaluate(
      (key) => localStorage.getItem(key),
      LOCALE_STORAGE_KEY,
    );
    await page.evaluate(() => {
      document.querySelector('[data-view="title"] [data-locale="ko"]')?.click();
    });
    const storedAfterRejectedRequest = await page.evaluate(
      (key) => localStorage.getItem(key),
      LOCALE_STORAGE_KEY,
    );
    const locale = await localeSnapshot(page);
    const activeViewControls = await page.locator('[data-view][data-open="1"] [data-locale]').count();
    const evidence = {
      locale,
      phase: await callHarness(page, 'phase'),
      activeViewControls,
      storedBeforeRejectedRequest,
      storedAfterRejectedRequest,
    };
    verify(locale.selected === 'en' && locale.active === 'en' && locale.locked,
      'The briefing boundary did not lock the selected English locale.', evidence);
    verify(activeViewControls === 0, 'A locale control remained in the active view after the run lock.', evidence);
    verify(storedBeforeRejectedRequest === 'en' && storedAfterRejectedRequest === 'en',
      'An out-of-title locale request mutated persistence.', evidence);

    const directScenario = await openBootScenario(session, {
      localStorageSeed: { [LOCALE_STORAGE_KEY]: 'en' },
    });
    try {
      await ready(directScenario.page, options.timeoutMs);
      const directBefore = await localeSnapshot(directScenario.page);
      await callHarness(directScenario.page, 'startRun', [{ skipIntro: true }]);
      const directAfter = await localeSnapshot(directScenario.page);
      evidence.directStart = { before: directBefore, after: directAfter };
      verify(directBefore.active === null && directAfter.active === 'en' && directAfter.locked,
        'Harness direct-start did not establish the run locale lock.', evidence);
    } finally {
      await directScenario.close();
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.restart-lock',
    name: 'Restart and failure retry preserve the active run locale',
    assertion:
      'External storage changes cannot alter the active locale through restart or failure retry; '
      + 'selected and active remain the locale captured at the run boundary.',
  }, async () => {
    const before = await localeSnapshot(page);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await page.evaluate((key) => localStorage.setItem(key, 'ko'), LOCALE_STORAGE_KEY);
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__LV?.phase() === 'countdown');
    const afterRestart = await localeSnapshot(page);

    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'damageHull', [2]);
    await callHarness(page, 'step', [1, 1 / 60]);
    await page.waitForFunction(() => window.__LV?.phase() === 'failed');
    await page.locator('[data-view="results"][data-open="1"] [data-action="retry"]').click();
    await page.waitForFunction(() => window.__LV?.phase() === 'countdown');
    const afterRetry = await localeSnapshot(page);
    const evidence = { before, afterRestart, afterRetry };
    for (const state of [before, afterRestart, afterRetry]) {
      verify(state.selected === 'en' && state.active === 'en' && state.locked,
        'Restart or retry changed the locked English run locale.', evidence);
    }
    return evidence;
  });

  await report.check({
    id: 'I18N.return-title-unlock',
    name: 'Returning to title unlocks and reloads the persisted locale',
    assertion:
      'After run cleanup and the title phase transition, storage is reloaded, the run locale becomes '
      + 'nullable/unlocked, Korean is applied, and the visible title BEGIN RUN action regains focus.',
  }, async () => {
    const locked = await localeSnapshot(page);
    if (await page.locator('[data-view="pause"][data-open="1"] [data-action="abort"]').count() === 0) {
      await page.keyboard.press('Escape');
    }
    const abort = page.locator('[data-view="pause"][data-open="1"] [data-action="abort"]');
    await abort.waitFor({ state: 'visible', timeout: 5_000 });
    await abort.click();
    await page.waitForFunction(() => window.__LV?.phase() === 'title');
    const locale = await localeSnapshot(page);
    const title = await page.evaluate(() => {
      const begin = document.querySelector('[data-view="title"][data-open="1"] [data-action="begin"]');
      return {
        beginVisible: begin instanceof HTMLElement && begin.getClientRects().length > 0,
        beginFocused: document.activeElement === begin,
      };
    });
    const evidence = { locked, locale, title };
    verify(locked.active === 'en' && locked.locked, 'The run was not locked before returning to title.', evidence);
    verify(locale.selected === 'ko' && locale.active === null && locale.locked === false,
      'Returning to title did not reload Korean and clear the active run locale.', evidence);
    verify(locale.documentLang === 'ko', 'Returning to title did not apply lang=ko.', evidence);
    verify(title.beginVisible && title.beginFocused,
      'The visible title BEGIN RUN action was not restored and focused.', evidence);
    return evidence;
  });

  await report.check({
    id: 'I18N.overlay-listener-stability',
    name: 'Repeated Overlay replacement keeps active listeners and subscribers stable',
    assertion:
      'A pre-document EventTarget/ResizeObserver census reports the same active listener population '
      + 'by semantic target/type/capture after repeated switches, one active ResizeObserver, and '
      + 'exactly one SettingsStore subscriber throughout.',
  }, async () => {
    const scenario = await openBootScenario(session, { initScripts: [installListenerCensus] });
    try {
      await ready(scenario.page, options.timeoutMs);
      await scenario.page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
      const firstLocale = await localeSnapshot(scenario.page);
      await focusLocale(scenario.page);
      const before = await scenario.page.evaluate(() => window.__LV_LISTENER_CENSUS.snapshot());
      const snapshots = [firstLocale];
      for (let i = 0; i < 8; i++) {
        await scenario.page.keyboard.press(i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
        await waitForSelected(scenario.page, i % 2 === 0 ? 'en' : 'ko');
        snapshots.push(await localeSnapshot(scenario.page));
        await assertLocaleFocus(scenario.page);
      }
      const after = await scenario.page.evaluate(() => window.__LV_LISTENER_CENSUS.snapshot());
      const evidence = { before, after, localeSnapshots: snapshots };
      const listenerKeys = before.listeners.map(({ key }) => key);
      verify(listenerKeys.some((key) => key.includes('::click::'))
        && listenerKeys.some((key) => key.includes('::keydown::'))
        && listenerKeys.some((key) => key.includes('::resize::'))
        && listenerKeys.some((key) => key.includes('::pointerlockchange::'))
        && listenerKeys.some((key) => key.includes('::pointerlockerror::')),
      'The listener census did not observe every required listener category.', evidence);
      verify(JSON.stringify(after.listeners) === JSON.stringify(before.listeners),
        'The active listener population changed across Overlay replacements.', evidence);
      verify(before.resize.active === 1 && after.resize.active === 1,
        'Overlay replacement did not preserve exactly one active ResizeObserver.', evidence);
      verify(after.resize.constructed - before.resize.constructed === 8
        && after.resize.disconnected - before.resize.disconnected === 8,
      'Each replacement did not pair one ResizeObserver construction with one disconnection.', evidence);
      verify(snapshots.every((snapshot) => snapshot.settingsSubscribers === 1),
        'SettingsStore subscriber count did not remain exactly one.', evidence);
      return evidence;
    } finally {
      await scenario.close();
    }
  });
}

async function ready(page, timeoutMs) {
  verify(await waitForHarness(page, timeoutMs), 'Harness did not appear during isolated boot.');
  await callHarness(page, 'ready', [], timeoutMs);
}

async function localeSnapshot(page) {
  const state = await callHarness(page, 'locale');
  const documentLang = await page.evaluate(() => document.documentElement.lang);
  const evidence = { ...state, documentLang };
  verify((state?.active === null || state?.active === 'ko' || state?.active === 'en')
    && (state?.selected === 'ko' || state?.selected === 'en')
    && typeof state?.locked === 'boolean'
    && Number.isInteger(state?.settingsSubscribers),
  'locale() returned an invalid state shape.', evidence);
  verify(state.locked === (state.active !== null),
    'Locale invariant failed: locked must equal (active !== null).', evidence);
  return evidence;
}

async function titleLocaleEvidence(page) {
  return page.evaluate(() => {
    const title = document.querySelector('[data-view="title"][data-open="1"]');
    const group = title?.querySelector('[data-nav="segmented"]');
    return {
      titleVisible: title instanceof HTMLElement && title.getClientRects().length > 0,
      value: group instanceof HTMLElement ? group.dataset.value ?? null : null,
      checked: group
        ? Array.from(group.querySelectorAll('[data-locale][aria-checked="true"]'))
          .map((node) => node.getAttribute('data-locale'))
        : [],
    };
  });
}

async function metadataEvidence(page) {
  return page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
  }));
}

async function directLocaleFocus(page) {
  return page.evaluate(() => ({
    locale: document.activeElement?.getAttribute('data-locale') ?? null,
    checked: document.activeElement?.getAttribute('aria-checked') ?? null,
    view: document.activeElement?.closest('[data-view]')?.getAttribute('data-view') ?? null,
  }));
}

async function focusLocale(page) {
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-nav') === 'segmented'
    && document.activeElement?.closest('[data-view]')?.getAttribute('data-view') === 'title');
  if (focused) return;
  const beginFocused = await page.evaluate(() => document.activeElement?.getAttribute('data-action') === 'begin');
  if (beginFocused) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
  } else {
    await page.locator('[data-view="title"][data-open="1"] [data-action="begin"]').focus();
    await page.keyboard.press('ArrowUp');
  }
  await assertLocaleFocus(page);
}

async function assertLocaleFocus(page) {
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      view: active?.closest('[data-view]')?.getAttribute('data-view') ?? null,
      nav: active?.getAttribute('data-nav') ?? null,
      value: active instanceof HTMLElement ? active.dataset.value ?? null : null,
    };
  });
  verify(focus.view === 'title' && focus.nav === 'segmented',
    'Keyboard focus did not remain on the title locale radiogroup.', focus);
  return focus;
}

async function waitForSelected(page, locale) {
  await page.waitForFunction((expected) => window.__LV?.locale?.().selected === expected, locale);
}

function installBootProbe() {
  window.__LV_BOOT_PROBE = [];
  const seen = new Set();
  const inspect = (node) => {
    if (!(node instanceof Element)) return;
    for (const [kind, selector] of [['loader', '.lv-loader'], ['overlay', '.lv-root']]) {
      const target = node.matches(selector) ? node : node.querySelector(selector);
      if (!target || seen.has(kind)) continue;
      seen.add(kind);
      window.__LV_BOOT_PROBE.push({
        kind,
        lang: document.documentElement?.lang ?? '',
        text: target.textContent ?? '',
      });
    }
  };
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) inspect(node);
  }).observe(document, { childList: true, subtree: true });
}

function installListenerCensus() {
  const NativeResizeObserver = window.ResizeObserver;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const records = [];
  const resize = { constructed: 0, disconnected: 0, entries: [] };
  const captureOf = (options) => typeof options === 'boolean' ? options : options?.capture === true;

  EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    const capture = captureOf(options);
    if (listener !== null && !records.some((record) => record.active
      && record.target === this && record.type === type && record.listener === listener
      && record.capture === capture)) {
      records.push({ target: this, type, listener, capture, active: true });
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
    const capture = captureOf(options);
    const record = records.find((candidate) => candidate.active
      && candidate.target === this && candidate.type === type && candidate.listener === listener
      && candidate.capture === capture);
    if (record) record.active = false;
    return nativeRemove.call(this, type, listener, options);
  };

  if (typeof NativeResizeObserver === 'function') {
    window.ResizeObserver = class CensusResizeObserver extends NativeResizeObserver {
      constructor(callback) {
        super(callback);
        resize.constructed += 1;
        resize.entries.push({ observer: this, active: true });
      }

      disconnect() {
        const entry = resize.entries.find((candidate) => candidate.observer === this && candidate.active);
        if (entry) {
          entry.active = false;
          resize.disconnected += 1;
        }
        return super.disconnect();
      }
    };
  }

  const targetName = (target) => {
    if (target === window) return 'window';
    if (target === document) return 'document';
    if (!(target instanceof Element)) return target.constructor?.name ?? 'EventTarget';
    const view = target.closest('[data-view]')?.getAttribute('data-view');
    const setting = target.getAttribute('data-setting')
      ?? target.closest('[data-setting]')?.getAttribute('data-setting');
    const semantic = [
      ['view', view],
      ['action', target.getAttribute('data-action')],
      ['nav', target.getAttribute('data-nav')],
      ['locale', target.getAttribute('data-locale')],
      ['seg', target.getAttribute('data-seg')],
      ['setting', setting],
      ['control', target.getAttribute('data-control')],
    ].filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join('|');
    return `${target.tagName.toLowerCase()}${semantic ? `|${semantic}` : ''}`;
  };

  window.__LV_LISTENER_CENSUS = {
    snapshot() {
      const populations = new Map();
      for (const record of records) {
        if (!record.active) continue;
        if (record.target instanceof Node && !record.target.isConnected) continue;
        const key = `${targetName(record.target)}::${record.type}::${record.capture ? 'capture' : 'bubble'}`;
        populations.set(key, (populations.get(key) ?? 0) + 1);
      }
      return {
        listeners: Array.from(populations, ([key, count]) => ({ key, count }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        resize: {
          constructed: resize.constructed,
          disconnected: resize.disconnected,
          active: resize.entries.filter((entry) => entry.active).length,
        },
      };
    },
  };
}
