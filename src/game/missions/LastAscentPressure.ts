import type { EscapeObjectiveTelemetry } from '../../core/contracts.ts';

export type EscapePressureStage = 'nominal' | 'warning' | 'critical';

export const LAST_ASCENT_PRESSURE_THRESHOLDS = Object.freeze({
  warningEnter: 0.065,
  warningExit: 0.085,
  criticalEnter: 0.025,
  criticalExit: 0.045,
});

/**
 * Normalized, hysteretic shockfront pressure. Only the authored front/player path separation is
 * observed; instantaneous speed never feeds the warning, and returning strings allocates no
 * steady-state objects for the 60/120 Hz telemetry path.
 */
export function lastAscentPressureStage(
  telemetry: EscapeObjectiveTelemetry,
  previous: EscapePressureStage,
): EscapePressureStage {
  if (telemetry.shockwaveProgress <= 0) return 'nominal';
  const separation = telemetry.pathProgress - telemetry.shockwaveProgress;
  if (previous === 'critical' && separation <= LAST_ASCENT_PRESSURE_THRESHOLDS.criticalExit) {
    return 'critical';
  }
  if (separation <= LAST_ASCENT_PRESSURE_THRESHOLDS.criticalEnter) return 'critical';
  if (previous === 'warning' && separation <= LAST_ASCENT_PRESSURE_THRESHOLDS.warningExit) {
    return 'warning';
  }
  if (separation <= LAST_ASCENT_PRESSURE_THRESHOLDS.warningEnter) return 'warning';
  return 'nominal';
}

export function escapePressureRank(stage: EscapePressureStage): number {
  if (stage === 'critical') return 2;
  if (stage === 'warning') return 1;
  return 0;
}
