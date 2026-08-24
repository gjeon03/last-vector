import type { CourseId } from './Courses.ts';
import { isCourseId } from './Courses.ts';
import type { ProgressV1 } from './Progress.ts';
import { isCourseUnlocked } from './Progress.ts';

export type CourseResolutionSource =
  | 'url'
  | 'persisted'
  | 'default'
  | 'invalid-url'
  | 'locked-url';

export interface CourseResolution {
  courseId: CourseId;
  source: CourseResolutionSource;
  diagnostic: string | null;
}

export function resolveCourseSelection(
  rawCourseParam: string | null,
  progress: ProgressV1,
): CourseResolution {
  if (rawCourseParam !== null) {
    if (!isCourseId(rawCourseParam)) {
      return {
        courseId: 'cairn-drift',
        source: 'invalid-url',
        diagnostic: `unknown course parameter: ${rawCourseParam}`,
      };
    }
    if (!isCourseUnlocked(progress, rawCourseParam)) {
      return {
        courseId: 'cairn-drift',
        source: 'locked-url',
        diagnostic: `locked course parameter: ${rawCourseParam}`,
      };
    }
    return { courseId: rawCourseParam, source: 'url', diagnostic: null };
  }

  if (isCourseUnlocked(progress, progress.selectedCourse)) {
    return { courseId: progress.selectedCourse, source: 'persisted', diagnostic: null };
  }
  return { courseId: 'cairn-drift', source: 'default', diagnostic: null };
}

export interface BuildCourseUrlOptions {
  preserveSeed?: boolean;
}

/** Returns navigation data only; callers retain ownership of reload and error handling. */
export function buildCourseUrl(
  current: string | URL,
  courseId: CourseId,
  options: BuildCourseUrlOptions = {},
): string {
  const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
  const url = current instanceof URL ? new URL(current.href) : new URL(current, base);
  url.searchParams.set('course', courseId);
  if (options.preserveSeed !== true) url.searchParams.delete('seed');
  return url.href;
}
