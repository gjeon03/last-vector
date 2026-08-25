import {
  DEFAULT_MISSION_ID,
  isMissionId,
  type MissionId,
} from './Missions.ts';
import type { ProgressV2 } from './Progress.ts';
import { isMissionUnlocked } from './Progress.ts';

export type MissionResolutionSource =
  | 'mission-url'
  | 'legacy-course-url'
  | 'persisted'
  | 'default'
  | 'invalid-mission-url'
  | 'invalid-course-url';

export interface MissionResolution {
  missionId: MissionId;
  source: MissionResolutionSource;
  diagnostic: string | null;
}

export interface MissionSelectionParams {
  mission: string | null;
  legacyCourse: string | null;
}

/** Mission wins over the legacy alias. Every unknown, dormant or unimplemented ID fails closed. */
export function resolveMissionSelection(
  params: MissionSelectionParams,
  progress: ProgressV2,
): MissionResolution {
  if (params.mission !== null) {
    if (!isMissionId(params.mission) || !isMissionUnlocked(progress, params.mission)) {
      return {
        missionId: DEFAULT_MISSION_ID,
        source: 'invalid-mission-url',
        diagnostic: `unknown or locked mission parameter: ${params.mission}`,
      };
    }
    return { missionId: params.mission, source: 'mission-url', diagnostic: null };
  }

  if (params.legacyCourse !== null) {
    if (params.legacyCourse !== DEFAULT_MISSION_ID) {
      return {
        missionId: DEFAULT_MISSION_ID,
        source: 'invalid-course-url',
        diagnostic: `retired or unknown course parameter: ${params.legacyCourse}`,
      };
    }
    return { missionId: DEFAULT_MISSION_ID, source: 'legacy-course-url', diagnostic: null };
  }

  if (isMissionUnlocked(progress, progress.selectedMission)) {
    return { missionId: progress.selectedMission, source: 'persisted', diagnostic: null };
  }
  return { missionId: DEFAULT_MISSION_ID, source: 'default', diagnostic: null };
}

export interface BuildMissionUrlOptions {
  preserveSeed?: boolean;
}

/** Canonical navigation writes only `mission`; the legacy `course` parameter is consumed. */
export function buildMissionUrl(
  current: string | URL,
  missionId: MissionId,
  options: BuildMissionUrlOptions = {},
): string {
  const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
  const url = current instanceof URL ? new URL(current.href) : new URL(current, base);
  url.searchParams.set('mission', isMissionId(missionId) ? missionId : DEFAULT_MISSION_ID);
  url.searchParams.delete('course');
  // Layout identity belongs only to a specific BLACKOUT RELAY launch descriptor. Chapter
  // navigation always starts a fresh layout instead of leaking the previous run across missions.
  url.searchParams.delete('layout');
  if (options.preserveSeed !== true) url.searchParams.delete('seed');
  return url.href;
}
