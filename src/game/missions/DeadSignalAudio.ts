import type { AudioBus } from '../../core/contracts.ts';
import type { MissionWeaponEvent } from '../MissionRuntime.ts';

/** Chapter-owned mapping from neutral weapon feedback transport into the shared audio bus. */
export function playDeadSignalWeaponFeedback(
  events: readonly MissionWeaponEvent[],
  audio: AudioBus,
): void {
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    audio.play(
      event.type === 'fire'
        ? 'weaponFire'
        : event.type === 'hit'
          ? 'weaponHit'
          : 'targetDestroy',
      event.intensity,
    );
  }
}
