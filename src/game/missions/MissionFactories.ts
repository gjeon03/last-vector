import type { MissionId } from '../../core/Missions.ts';
import { createCairnMissionRuntime } from '../CairnRuntime.ts';
import type { GameMissionRuntimeFactory } from '../MissionRuntime.ts';
import { createDeadSignalMissionRuntime } from './DeadSignalRuntime.ts';
import { createLastAscentMissionRuntime } from './LastAscentRuntime.ts';

const MISSION_RUNTIME_FACTORIES: Readonly<Record<MissionId, GameMissionRuntimeFactory>> = {
  'cairn-drift': createCairnMissionRuntime,
  'last-ascent': createLastAscentMissionRuntime,
  'dead-signal': createDeadSignalMissionRuntime,
};

export function getMissionRuntimeFactory(missionId: MissionId): GameMissionRuntimeFactory {
  return MISSION_RUNTIME_FACTORIES[missionId];
}
