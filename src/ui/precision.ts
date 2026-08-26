import { PRECISION_MAX_OFFSET } from '../core/Courses.ts';

/**
 * Present a one-decimal percentage without letting rounding contradict the strict mastery rule.
 * Passing values round down; failing values round up. Therefore the two sides of the <40% boundary
 * can never share the same displayed measurement.
 */
export function formatPrecisionOffsetPercent(offset: number): string {
  const percentTenths = offset < PRECISION_MAX_OFFSET
    ? Math.floor(offset * 1_000)
    : Math.ceil(offset * 1_000);
  return `${(percentTenths / 10).toFixed(1)}%`;
}
