import type { Locale, LocaleFontStatus } from '../core/contracts.ts';

const HANGUL_FAMILY = 'NanumSquare Neo Hangul';
const HANGUL_PROBE = '가힣';
const HANGUL_WEIGHTS = [300, 400, 700] as const;
const DEFAULT_TIMEOUT_MS = 1200;

export interface LocaleFontResult {
  locale: Locale;
  status: LocaleFontStatus;
  error?: string;
}

export interface LocaleFontPreparation {
  initial: Promise<LocaleFontResult>;
  settled: Promise<LocaleFontResult>;
  cancel(): void;
}

export function prepareLocaleFonts(
  locale: Locale,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): LocaleFontPreparation {
  if (locale === 'en') {
    const result: LocaleFontResult = { locale, status: 'not-required' };
    const resolved = Promise.resolve(result);
    return { initial: resolved, settled: resolved, cancel() {} };
  }

  const settled: Promise<LocaleFontResult> = Promise.resolve()
    .then(async () => {
      const results = await Promise.all(HANGUL_WEIGHTS.map((weight) =>
        document.fonts.load(`${weight} 1em "${HANGUL_FAMILY}"`, HANGUL_PROBE)));
      const emptyWeight = results.findIndex((faces) => faces.length === 0);
      if (emptyWeight !== -1) {
        throw new Error(
          `${HANGUL_FAMILY} weight ${HANGUL_WEIGHTS[emptyWeight]} returned no font faces`,
        );
      }
      return { locale, status: 'ready' } satisfies LocaleFontResult;
    })
    .then(
      (result) => result,
      (error): LocaleFontResult => ({
        locale,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  const finiteTimeout = Number.isFinite(timeoutMs)
    ? Math.max(0, timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let initialFinished = false;
  let resolveInitial!: (result: LocaleFontResult) => void;
  const initial = new Promise<LocaleFontResult>((resolve) => {
    resolveInitial = resolve;
  });
  const finishInitial = (result: LocaleFontResult): void => {
    if (initialFinished) return;
    initialFinished = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    resolveInitial(result);
  };

  timer = setTimeout(() => {
    finishInitial({ locale, status: 'fallback' });
  }, finiteTimeout);
  void settled.then(finishInitial);

  return {
    initial,
    settled,
    cancel(): void {
      finishInitial({ locale, status: 'fallback' });
    },
  };
}
