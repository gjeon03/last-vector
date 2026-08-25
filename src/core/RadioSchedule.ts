/**
 * Radio timing is authored against canonical English copy, so switching locale cannot move a
 * subtitle into a steering or braking commitment.
 */
export const RADIO_BASE_SECONDS = 3.2;
export const RADIO_SECONDS_PER_CHARACTER = 0.035;
export const RADIO_DURATION_CHARACTER_CAP = 120;
export const RADIO_COMMITMENT_MARGIN_SECONDS = 2;

export function radioDurationSeconds(englishLength: number): number {
  const boundedLength = Number.isFinite(englishLength)
    ? Math.min(RADIO_DURATION_CHARACTER_CAP, Math.max(0, Math.trunc(englishLength)))
    : 0;
  return RADIO_BASE_SECONDS + boundedLength * RADIO_SECONDS_PER_CHARACTER;
}

export function hasRadioSafeWindow(
  englishLength: number,
  secondsUntilCommitment: number,
): boolean {
  return Number.isFinite(secondsUntilCommitment) &&
    secondsUntilCommitment >= radioDurationSeconds(englishLength) + RADIO_COMMITMENT_MARGIN_SECONDS;
}
