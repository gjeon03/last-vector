import { createCairnMissionRuntime } from '../CairnRuntime.ts';
import type { GameMissionRuntimeFactory } from '../MissionRuntime.ts';
import { createDeadSignalMissionRuntime } from './DeadSignalRuntime.ts';

/** Objective/capability dispatch; UI and Game never branch on a mission ID. */
export const createActiveMissionRuntime: GameMissionRuntimeFactory = (context) =>
  context.definition.objective.kind === 'strike'
    && context.definition.capabilities.includes('fire')
    ? createDeadSignalMissionRuntime(context)
    : createCairnMissionRuntime(context);
