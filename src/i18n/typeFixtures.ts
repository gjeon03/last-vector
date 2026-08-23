import { createTranslator } from './index.ts';

const translator = createTranslator('en');

export const typeFixtures = [
  translator.messages.hud.boostUsable(3.5),
  translator.messages.events.gateClearedLog(7, 12.34),
  () => {
    // @ts-expect-error boostUsable requires a numeric duration.
    return translator.messages.hud.boostUsable();
  },
  () => {
    // @ts-expect-error boostUsable rejects string durations.
    return translator.messages.hud.boostUsable('3.5');
  },
  () => {
    // @ts-expect-error gateClearedLog requires both the gate and seconds.
    return translator.messages.events.gateClearedLog();
  },
  () => {
    // @ts-expect-error gateClearedLog cannot omit the seconds argument.
    return translator.messages.events.gateClearedLog(7);
  },
] as const;
