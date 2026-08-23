import type { Locale } from '../core/contracts.ts';

export type { Locale } from '../core/contracts.ts';

export const LOCALE_STORAGE_KEY = 'last-vector.locale.v1';
export const DEFAULT_LOCALE: Locale = 'ko';

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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
