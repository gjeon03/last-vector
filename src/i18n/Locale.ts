import type { Locale } from '../core/contracts.ts';

export type { Locale } from '../core/contracts.ts';

export const LOCALE_STORAGE_KEY = 'last-vector.locale.v1';
export const LOCALE_HANDOFF_KEY = 'last-vector.locale-handoff.v1';
export const DEFAULT_LOCALE: Locale = 'ko';

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * Carries the run-locked locale across the single route-change reload.
 *
 * This is deliberately tab-scoped and one-shot: the durable locale preference can still be
 * changed from another tab while a run is active, but that must not change the language between
 * a result screen and the next route's briefing.
 */
export function writeLocaleHandoff(
  locale: Locale,
  storage: LocaleStorage | null = readGlobalSessionStorage(),
): boolean {
  try {
    storage?.setItem(LOCALE_HANDOFF_KEY, locale);
    return storage !== null;
  } catch {
    return false;
  }
}

export function consumeLocaleHandoff(
  storage: LocaleStorage | null = readGlobalSessionStorage(),
): Locale | null {
  try {
    const value = storage?.getItem(LOCALE_HANDOFF_KEY) ?? null;
    storage?.removeItem?.(LOCALE_HANDOFF_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function isLocale(value: unknown): value is Locale {
  return value === 'ko' || value === 'en';
}

export class LocaleStore {
  private readonly storage: LocaleStorage | null;
  private locale: Locale = DEFAULT_LOCALE;

  constructor(storage?: LocaleStorage | null) {
    this.storage = storage === undefined ? readGlobalStorage() : storage;
    const stored = this.read();
    if (stored !== null) this.locale = stored;
  }

  get(): Locale {
    return this.locale;
  }

  set(locale: Locale): void {
    this.locale = locale;
    try {
      this.storage?.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Persistence is best-effort; the current session keeps the player's selection.
    }
  }

  /** Updates only this runtime instance; used by a one-shot tab handoff across a route reload. */
  adopt(locale: Locale): void {
    this.locale = locale;
  }

  reload(): Locale {
    const stored = this.read();
    if (stored !== null) this.locale = stored;
    return this.locale;
  }

  private read(): Locale | null {
    try {
      const value = this.storage?.getItem(LOCALE_STORAGE_KEY);
      return isLocale(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function readGlobalStorage(): LocaleStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readGlobalSessionStorage(): LocaleStorage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}
