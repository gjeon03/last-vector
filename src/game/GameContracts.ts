import { FLIGHT } from '../core/art.ts';
import { clamp } from '../core/mathx.ts';
import {
  ACTIVE_MISSION_ORDER,
  getMissionDefinition,
  getNextMission,
  type MissionId,
} from '../core/Missions.ts';
import { isMissionUnlocked, type ProgressV2 } from '../core/Progress.ts';
import type { CampaignViewModel } from '../ui/Screens.ts';
import type { Ship } from './Ship.ts';
import type {
  MissionRewardEvent,
  MissionRuntime,
  MissionSimulationOutcome,
} from './MissionRuntime.ts';

/** Legacy automation wins; generic input survives only when the caller declares active flight. */
export function resolveAutopilotButton(
  controlled: boolean | undefined,
  incoming: boolean,
  preserveGeneric: boolean,
): boolean {
  return controlled ?? (preserveGeneric ? incoming : false);
}

/** Catalog projection kept pure so one- and multi-mission campaign state share one contract. */
export function buildCampaignViewModel(
  progress: ProgressV2,
  activeMissionId: MissionId,
  newlyUnlockedMissionId: MissionId | null = null,
  navigationError: CampaignViewModel['navigationError'] = null,
): CampaignViewModel {
  const active = progress.missions[activeMissionId];
  return {
    activeMissionId,
    nextMissionId: active?.cleared === true ? getNextMission(activeMissionId) : null,
    newlyUnlockedMissionId,
    navigationError,
    missions: ACTIVE_MISSION_ORDER.map((id) => {
      const definition = getMissionDefinition(id);
      const mission = progress.missions[id];
      const mastery = definition.mastery.map((masteryId) => ({
        id: masteryId,
        complete: mission?.mastery[masteryId] === true,
      }));
      return {
        id,
        chapter: definition.chapter,
        capabilities: definition.capabilities,
        mastery,
        state: mission?.cleared === true
          ? 'cleared'
          : isMissionUnlocked(progress, id) ? 'available' : 'locked',
        highestRank: mission?.highestRank ?? null,
        objectives: {
          firstClear: mission?.cleared === true,
          cleanClear: mission?.cleanClear === true,
          precision: mission?.mastery.precision === true,
        },
      };
    }),
  };
}

/** Consumes discrete objective rewards after every surviving active frame. */
export function consumeMissionFrameEvents(
  mission: Pick<MissionRuntime, 'drainRewardEvents'>,
  outcome: MissionSimulationOutcome,
  ship: Pick<Ship, 'rechargeBoost'>,
  rewardEvents: MissionRewardEvent[],
): void {
  rewardEvents.length = 0;
  if (outcome.hullFailed) return;
  const rewardCount = mission.drainRewardEvents(rewardEvents);
  for (let index = 0; index < rewardCount; index++) {
    const event = rewardEvents[index]!;
    if (event.kind !== 'boost-recharge' || !Number.isFinite(event.amount)) continue;
    const amount = clamp(event.amount, 0, FLIGHT.boostCapacity);
    if (amount > 0) ship.rechargeBoost(amount);
  }

}
