/** @deprecated Import MissionSelection. This module preserves the old import path during v2. */
export {
  buildMissionUrl as buildCourseUrl,
  resolveMissionSelection,
  resolveMissionSelection as resolveCourseSelection,
  type BuildMissionUrlOptions as BuildCourseUrlOptions,
  type MissionResolution as CourseResolution,
  type MissionResolutionSource as CourseResolutionSource,
} from './MissionSelection.ts';
