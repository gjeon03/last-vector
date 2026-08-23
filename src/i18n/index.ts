import type { Locale } from '../core/contracts.ts';
import { renderDomainMessage } from './domain.ts';
import type { DomainMessage } from './domain.ts';
import { en } from './en.ts';
import { ko } from './ko.ts';
import type { Messages } from './messages.ts';

export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, LocaleStore, isLocale } from './Locale.ts';
export type { Locale, LocaleStorage } from './Locale.ts';
export type { DomainMessage } from './domain.ts';
export { en } from './en.ts';
export { prepareLocaleFonts } from './fonts.ts';
export type { LocaleFontPreparation, LocaleFontResult } from './fonts.ts';
export { ko } from './ko.ts';
export type { Messages } from './messages.ts';

export interface Translator {
  readonly locale: Locale;
  readonly messages: Messages;
  domain(message: DomainMessage): string;
}

export function createTranslator(locale: Locale): Translator {
  const messages: Messages = locale === 'en' ? en : ko;
  return {
    locale,
    messages,
    domain(message: DomainMessage): string {
      return renderDomainMessage(messages, message);
    },
  };
}
