import { createTranslator } from './index.ts';

const translator = createTranslator('en');

export const typeFixtures = [
  translator.messages.campaign.routes['needle-grave'].briefingLine2,
  translator.messages.campaign.routes.wreckline.radio2,
  translator.messages.campaign.routes.ringfall.objectives.cleanClear,
  translator.messages.campaign.routes['cairn-drift'].objectives.precision,
  translator.messages.hud.boostUsable(3.5),
  translator.messages.events.gateClearedLog(7, 12.34),
  translator.messages.campaign.routes['needle-grave'].gateShearBlockedLog(3),
  translator.messages.results.bestComparison('+1.23', '01:02.34'),
  () => {
    // @ts-expect-error gateShearBlockedLog requires a gate number.
    return translator.messages.campaign.routes['needle-grave'].gateShearBlockedLog();
  },
  () => {
    // @ts-expect-error campaign copy is keyed only by recognised authored course IDs.
    return translator.messages.campaign.routes['helios-run'];
  },
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
  () => {
    // @ts-expect-error bestComparison requires delta and best strings.
    return translator.messages.results.bestComparison();
  },
  () => {
    // @ts-expect-error bestComparison cannot omit the best-time argument.
    return translator.messages.results.bestComparison('+1.23');
  },
  () => {
    // @ts-expect-error bestComparison rejects numeric display values.
    return translator.messages.results.bestComparison(1.23, 62.34);
  },
] as const;
