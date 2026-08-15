/**
 * The aggregate gate's required-check manifest and per-suite failure predicate.
 *
 * A separate module for one reason: so the predicate can be exercised against synthetic suite
 * results without running a fifteen-minute gate. The aggregate's previous defect — a verdict
 * computed from report.status alone, so a suite that exited 2 could never fail it — survived
 * five rounds precisely because nothing could test the predicate in isolation.
 */

/**
 * Checks that must EXIST in each suite's report for the gate to pass.
 *
 * Without this manifest, deleting a check was invisible: the aggregate verified status, exit
 * code, signal and report readability, so a suite that quietly lost its strongest assertion
 * still reported PASS with a smaller check count. Every round of this project has asked "does
 * the check fail when its subject is deleted?" — this is the same question one level up, "does
 * the gate fail when the CHECK is deleted?", and until now the answer was no for all of them.
 *
 * Entries are the mutation-proven assertions (each was shown to fail with its subject deleted
 * and stamped with the commit that proved it) plus the per-blocker regression checks. Renaming
 * one of these without updating this list is a gate failure BY DESIGN — a rename is
 * indistinguishable from a deletion to every consumer of the report.
 */
const REQUIRED_CHECKS = {
  playtest: [
    'M2.automation-input',
    'INPUT.keys-drive-the-command',
    'INPUT.invertY-reaches-flight',
    'M3.sequential-gates',
    'M4.destination-finish',
    'M5.runtime-errors',
    'GAME.renderscale-intent-persists',
  ],
  'audio-probe': [
    'ENGINE.exists-and-scales-with-thrust',
    'ENGINE.boost-layer-adds-energy',
    'MUSIC.exists',
    'MUSIC.graph-can-silence-score',
    'MUSIC.graph-volume-travel',
  ],
  'audio-live': [
    'LIVE.silent-until-first-gesture',
    'LIVE.first-gesture-starts-audio',
    'LIVE.suspend-then-resume',
    'LIVE.music-volume-zero-reaches-both-paths',
    'LIVE.music-volume-tracks-both-paths',
    'LIVE.production-reclaims-nodes',
    'LIVE.ui-duck-fires-and-releases',
    'LIVE.event-duck-fires-and-releases',
    'GAME.score-slider-reaches-the-mix',
    'GAME.visibility-roundtrip-while-paused',
    // The regression check for 6d4162f. Listed with its anti-vacuity partner deliberately: on its
    // own, `silent-on-title` is satisfied by a game that makes no sound at all, so deleting the
    // partner would leave a check that cannot fail for the reason it exists.
    'GAME.silent-on-title-until-gesture',
    'GAME.title-gesture-starts-audio',
  ],
};

const suiteFailures = (result) => {
  const reasons = [];
  if (result.status !== 'PASS') reasons.push(`reported ${result.status}`);
  if (result.exitCode !== 0) reasons.push(`exited ${result.exitCode}`);
  if (result.signal !== null) reasons.push(`killed by ${result.signal}`);
  if (result.reportError !== null) reasons.push(`report unreadable: ${result.reportError}`);
  const missing = (REQUIRED_CHECKS[result.suite] ?? []).filter((id) => !result.checkIds.includes(id));
  if (missing.length > 0) reasons.push(`required checks missing from the report: ${missing.join(', ')}`);
  return reasons;
};

export { REQUIRED_CHECKS, suiteFailures };
