import type { MissionRewardEvent } from '../../core/contracts.ts';
import { LAST_ASCENT_CHECKPOINT_REWARD_SOURCE } from './LastAscentObjective.ts';

/**
 * Keeps LAST ASCENT presentation downstream of the shared reward transport. Source indices are
 * zero-based in simulation; the caller maps them to the one-based authored radio checkpoints.
 */
export function presentEscapeRewardEvents(
  events: readonly MissionRewardEvent[],
  onCheckpoint: (sourceIndex: number) => void,
): number {
  let presented = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    switch (event.kind) {
      case 'boost-recharge': {
        if (
          event.sourceId !== LAST_ASCENT_CHECKPOINT_REWARD_SOURCE
          || !Number.isInteger(event.sourceIndex)
          || event.sourceIndex! < 0
          || event.sourceIndex! >= 3
        ) break;
        onCheckpoint(event.sourceIndex!);
        presented += 1;
        break;
      }
    }
  }
  return presented;
}
