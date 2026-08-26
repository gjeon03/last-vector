import type { MissionId } from '../../core/Missions.ts';
import { createCairnMissionRuntime } from '../CairnRuntime.ts';
import type { GameMissionRuntimeFactory } from '../MissionRuntime.ts';
import { createRelayHarvestMissionRuntime } from './RelayHarvestRuntime.ts';

const MISSION_RUNTIME_FACTORIES: Readonly<Record<MissionId, GameMissionRuntimeFactory>> = {
  'cairn-drift': createCairnMissionRuntime,
  'relay-harvest': createRelayHarvestMissionRuntime,
};

export function getMissionRuntimeFactory(missionId: MissionId): GameMissionRuntimeFactory {
  return MISSION_RUNTIME_FACTORIES[missionId];
}
