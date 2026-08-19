/**
 * The aggregate gate's expected-check manifest and per-suite failure predicate.
 *
 * A separate module for one reason: so the predicate can be exercised against synthetic suite
 * results without running a fifteen-minute gate. The aggregate's previous defect — a verdict
 * computed from report.status alone, so a suite that exited 2 could never fail it — survived
 * five rounds precisely because nothing could test the predicate in isolation.
 *
 * SET EQUALITY, not subset membership. The first manifest protected 24 hand-picked ids and two
 * independent reviewers filed the same finding within one round: the gate defended 21% of the
 * surface it was quoted as covering, and M3.hazard-invariance — the enforcement check added that
 * very round — could itself be deleted with the aggregate green. A complete committed set closes
 * both directions at once: a check DELETED or RENAMED reds the gate, and a check ADDED without a
 * manifest update in the same commit reds it too — which is what makes every new regression check
 * born protected instead of protected whenever somebody remembers.
 */
const EXPECTED_CHECKS = {
  'perf-probe': [
    'M1.static-host',
    'SETUP.playwright',
    'SETUP.page-load',
    'API.contract',
    'API.ready',
    'PERF.settings',
    'PERF.sample-shape',
    'M5.performance-1080p',
    'M5.runtime-errors',
    'M6.localhost-only',
  ],
  'perf-probe-hidpi': [
    'M1.static-host',
    'SETUP.playwright',
    'SETUP.page-load',
    'API.contract',
    'API.ready',
    'PERF.settings',
    'PERF.sample-shape',
    'M5.performance-1080p',
    'M5.runtime-errors',
    'M6.localhost-only',
  ],
  'playtest': [
    'M1.static-host',
    'SETUP.playwright',
    'SETUP.page-load',
    'API.contract',
    'API.ready',
    'M2.automation-input',
    'M7.automation-input-surface',
    'INPUT.keys-drive-the-command',
    'INPUT.invertY-reaches-flight',
    'INPUT.mouse-pipeline',
    'M3.sequential-gates',
    'M4.destination-finish',
    'UX.screen-flow',
    'M3.hazard-invariance',
    'M3.drift-respects-protected-volumes',
    'GAME.renderscale-intent-persists',
    'FEEL.boost-latch',
    'M5.runtime-errors',
    'M6.localhost-only',
  ],
  'screenshot-matrix': [
    'M1.static-host',
    'SETUP.playwright',
    'SETUP.page-load',
    'API.contract',
    'SCREENSHOT.setup',
    'SCREENSHOT.cell-001',
    'SCREENSHOT.cell-002',
    'SCREENSHOT.cell-003',
    'SCREENSHOT.cell-004',
    'SCREENSHOT.cell-005',
    'SCREENSHOT.cell-006',
    'SCREENSHOT.cell-007',
    'SCREENSHOT.cell-008',
    'SCREENSHOT.cell-009',
    'SCREENSHOT.cell-010',
    'SCREENSHOT.matrix-complete',
    'M5.runtime-errors',
    'M6.localhost-only',
  ],
  'audio-probe': [
    'AUDIBLE.gatePass@0.4',
    'AUDIBLE.gatePass@1',
    'AUDIBLE.gateNear@0.2',
    'AUDIBLE.gateNear@1',
    'AUDIBLE.gateMiss@0.7',
    'AUDIBLE.boostStart@0.9',
    'AUDIBLE.boostEnd@0.7',
    'AUDIBLE.boostEmpty@0.5',
    'AUDIBLE.countdownTick@0.3',
    'AUDIBLE.countdownGo@1',
    'AUDIBLE.impact@0.9',
    'AUDIBLE.scrape@0.7',
    'AUDIBLE.warnProximity@0.3',
    'AUDIBLE.warnProximity@1',
    'AUDIBLE.uiClick@0.5',
    'AUDIBLE.uiBack@0.5',
    'ESCALATES.gateNear',
    'ESCALATES.warnProximity',
    'ENGINE.exists-and-scales-with-thrust',
    'ENGINE.boost-layer-adds-energy',
    'MUSIC.exists',
    'NODES.stable',
    'STRESS.nodeceiling',
    'STRESS.headroom',
    'AUDIBLE.scrape.sustained',
    'MUSIC.graph-can-silence-score',
    'MUSIC.graph-volume-travel',
    'HEADROOM.truepeak',
  ],
  'audio-live': [
    'LIVE.silent-until-first-gesture',
    'LIVE.first-gesture-starts-audio',
    'LIVE.context-created',
    'LIVE.context-running',
    'LIVE.suspend-then-resume',
    'LIVE.redundant-resume',
    'LIVE.music-volume-zero-reaches-both-paths',
    'LIVE.music-volume-tracks-both-paths',
    'LIVE.menu-duck-applied',
    'LIVE.music-send-trim-tracks-duck',
    'LIVE.menu-floor-survives-a-ui-click',
    'LIVE.menu-floor-survives-a-ducking-cue',
    'LIVE.menu-release',
    'LIVE.menu-release-same-tick-as-click',
    'LIVE.menu-apply-same-tick-as-click',
    'LIVE.ui-duck-fires-and-releases',
    'LIVE.event-duck-fires-and-releases',
    'LIVE.production-reclaims-nodes',
    'LIVE.duck-releases-in-flight',
    'LIVE.menu-before-unlock',
    'LIVE.dispose-clean',
    'GAME.harness-present',
    'GAME.audio-running',
    'GAME.score-slider-reaches-the-mix',
    'GAME.paused-duck',
    'GAME.pauseMenu-matches-real-pause',
    'GAME.visibility-roundtrip-while-paused',
    'GAME.unpause-restores',
    'GAME.no-page-errors',
    'GAME.silent-on-title-until-gesture',
    'GAME.title-gesture-starts-audio',
    // The master fader, by both routes. It had no coverage of any kind until round 9 — the same
    // hole the Score slider fell through when it shipped with 0.55 dB of travel and both suites
    // stayed green. LIVE tests the setter, GAME tests the settings hop into it.
    'LIVE.master-volume',
    'GAME.master-slider-reaches-the-mix',
  ],
};

const suiteFailures = (result) => {
  const reasons = [];
  if (result.status !== 'PASS') reasons.push(`reported ${result.status}`);
  if (result.exitCode !== 0) reasons.push(`exited ${result.exitCode}`);
  if (result.signal !== null) reasons.push(`killed by ${result.signal}`);
  if (result.reportError !== null) reasons.push(`report unreadable: ${result.reportError}`);
  const expected = EXPECTED_CHECKS[result.suite];
  if (expected) {
    const got = new Set(result.checkIds);
    const missing = expected.filter((id) => !got.has(id));
    const extra = result.checkIds.filter((id) => !expected.includes(id));
    if (missing.length > 0) reasons.push(`expected checks missing from the report: ${missing.join(', ')}`);
    if (extra.length > 0) {
      reasons.push(
        `checks not in the committed manifest: ${extra.join(', ')} — a new check must update `
        + 'scripts/playtest/manifest.mjs in the same commit, or it is born deletable',
      );
    }
  }
  return reasons;
};

export { EXPECTED_CHECKS, suiteFailures };
