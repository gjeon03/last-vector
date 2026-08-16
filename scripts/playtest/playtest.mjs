import {
  callHarness,
  criterion,
  finiteNumber,
  reloadHarness,
  runManagedSuite,
  verify,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'telemetry',
  'phase',
  'result',
  'setInput',
  'activeInput',
  'pose',
  'setAutopilot',
  'gateHistory',
  'step',
  'setDriven',
  'setFixedTimestep',
  'setSettings',
  'settings',
  'errors',
];

await runManagedSuite({
  suite: 'playtest',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runPlaytest,
});

async function runPlaytest({ report, session, options }) {
  const page = session.page;

  await report.check({
    id: 'API.ready',
    name: 'First rendered frame is ready',
    criteria: [],
    assertion: 'window.__LV.ready() resolves within the configured timeout.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    return { timeoutMs: options.timeoutMs };
  });

  const inputOutcome = await report.check({
    id: 'M2.automation-input',
    name: 'Automation drives the declared flight input surface',
    /* `partial`, not `full`, and the correction is measured rather than argued. This declared
       "Exercises every declared control" while `Input.update()` returns inside the override branch
       before any of the real input pipeline runs. Proven by mutation ab-mutations M10a at b572962:
       stubbing `held()` kills every key-derived input in the game, `INPUT.keys-drive-the-command`
       goes red, and THIS CHECK STAYS GREEN. What it actually proves is that a resolved command
       supplied through `setInput` is applied verbatim and moves the ship on six axes. */
    criteria: [criterion('M2', 'partial', 'Proves the harness override path applies a resolved six-axis command verbatim and produces pose motion; the shipped input pipeline is covered by the INPUT.* checks instead.')],
    assertion: 'A fixed-timestep run applies pitch, yaw, roll, throttle, strafeX, strafeY, boost, and brake exactly; after 60 frames telemetry is flying and moving, position changes, and all three body angular rates respond.',
  }, async () => collectInputEvidence(page, options));

  await report.check({
    id: 'M7.automation-input-surface',
    name: 'Scripted input covers the keyboard/mouse command vocabulary',
    /* The gap this discloses was under-described, in a way that mattered: it named "physical
       bindings and pointer lock", which reads as an environmental limit covering the whole
       subsystem. Two things were wrong with that. The keyboard half was never gated on pointer
       lock at all — `handleKeyDown` is a window listener whose only `locked` reference is the Tab
       guard — so it was testable all along and simply was not tested. And what went untested was
       not "bindings" but the input TRANSFORMATION layer: the stick integrator, the expo curves,
       the throttle rate, invertY. The keyboard half is now covered by the INPUT.* checks; what
       remains genuinely blocked is the mouse path, behind `handleMouseMove`'s lock gate. */
    criteria: [criterion('M7', 'partial', 'Proves the resolved API-level command surface here, and the key-derived axes, throttle integrator and invertY in the INPUT.* checks; the mouse-derived stick, mouseSensitivity, stick expo, the gamepad branch and pointer lock itself remain unexercised.')],
    assertion: 'The same automation command containing every keyboard/mouse flight action is accepted and can be released with setInput(null).',
  }, async () => {
    verify(inputOutcome.ok, 'The full input command was not accepted; see M2.automation-input.', inputOutcome.error);
    return {
      acceptedFields: inputOutcome.evidence.commandFields,
      releasedToHumanControl: inputOutcome.evidence.releasedToHumanControl,
      limitation: 'No current __LV method exposes physical binding state or pointer-lock ownership.',
    };
  });

  const keyboardOutcome = await capture(async () => collectKeyboardEvidence(page, options));

  await report.check({
    id: 'INPUT.keys-drive-the-command',
    name: 'Real key events drive the shipped input pipeline',
    criteria: [criterion('M7', 'partial', 'Exercises the key-derived axes and the throttle integrator through Input.update()\'s real path, with no harness override in place.')],
    assertion: 'With setInput(null) so no override is active, dispatched keydowns produce roll +1 on D and -1 on A, strafeX +1 on E, pitch +0.85 on ArrowUp and -0.85 on ArrowDown, and holding S drops throttle by 1.35/s measured as two equal successive deltas.',
  }, async () => {
    const e = unwrap(keyboardOutcome);
    const near = (a, b, tol = 0.01) => finiteNumber(a) && Math.abs(a - b) <= tol;
    verify(near(e.rollRight, 1) && near(e.rollLeft, -1), `Roll did not respond to D/A with both signs: ${e.rollRight} / ${e.rollLeft}.`, e);
    verify(near(e.strafeRight, 1), `StrafeX did not respond to E: ${e.strafeRight}.`, e);
    verify(near(e.pitchUp, 0.85) && near(e.pitchDown, -0.85), `Pitch did not respond to the arrow keys with both signs: ${e.pitchUp} / ${e.pitchDown}.`, e);
    /* Two EQUAL deltas is what separates an integrator from an assignment. */
    verify(near(e.throttle.delta1, e.throttle.expectedDelta, 0.02), `First throttle delta ${e.throttle.delta1} is not the 1.35/s rate.`, e);
    verify(near(e.throttle.delta2, e.throttle.expectedDelta, 0.02), `Second throttle delta ${e.throttle.delta2} is not the 1.35/s rate — a one-shot assignment would show a first delta and then zero.`, e);
    verify(near(e.throttle.delta1, e.throttle.delta2, 0.02), `Throttle deltas are not equal (${e.throttle.delta1} vs ${e.throttle.delta2}), so throttle is not being integrated.`, e);
    return {
      ...e,
      notCovered: [
        'the mouse-derived virtual stick, mouseDx/mouseDy and the 0.24 s recentre — behind handleMouseMove\'s `if (!this.locked) return`',
        'mouseSensitivity, which scales mouse deltas only and is unreachable with the above',
        'expo() on stick input; the key terms are added outside it, so this check exercises expo on nothing',
        'the gamepad branch entirely',
        'pointer lock itself',
      ],
    };
  });

  await report.check({
    id: 'INPUT.invertY-reaches-flight',
    name: 'The invert-pitch setting reaches the flight command',
    criteria: [criterion('M7', 'partial', 'Proves the settings->Input->command path for invertY end to end, in both positions.')],
    assertion: 'ArrowUp yields pitch +0.85 with invertY off and -0.85 with invertY on, so the setting is read by the code that builds the command rather than merely stored.',
  }, async () => {
    const e = unwrap(keyboardOutcome);
    const near = (a, b, tol = 0.01) => finiteNumber(a) && Math.abs(a - b) <= tol;
    verify(near(e.invertY.off, 0.85), `invertY off did not give +0.85 pitch: ${e.invertY.off}.`, e);
    /* Both positions, or a build that ignores the flag and happens to have the expected sign passes. */
    verify(near(e.invertY.on, -0.85), `invertY on did not invert the pitch: ${e.invertY.on}. The setting is stored but not reaching the command.`, e);
    return e.invertY;
  });

  const playthroughOutcome = await capture(async () => collectPlaythrough(page, options));

  await report.check({
    id: 'M3.sequential-gates',
    name: 'Autopilot clears every gate in order',
    criteria: [criterion('M3', 'full', 'Uses a fixed-timestep scripted playthrough and validates monotonic gate progression plus the final result counts.')],
    assertion: 'At fixed 1/60 s timestep, skill-1 autopilot reaches a result with gatesTotal > 0, clears every gate exactly once in index order, records finite pass evidence, and emits one split per gate.',
  }, async () => {
    const evidence = unwrap(playthroughOutcome);
    const result = evidence.result;
    verify(result && Number.isInteger(result.gatesTotal) && result.gatesTotal > 0, 'Finished result has no positive gate total.', evidence);
    verify(result.gatesCleared === result.gatesTotal, 'Not every gate was cleared.', evidence);
    verify(Array.isArray(result.splits) && result.splits.length === result.gatesTotal, 'Split count does not match gate total.', evidence);
    verify(evidence.gateIndices.every((value, index, values) => index === 0 || value >= values[index - 1]), 'Gate indices moved backwards.', evidence);
    verify(Array.isArray(evidence.gateHistory) && evidence.gateHistory.length === result.gatesTotal, 'Gate history count does not match gate total.', evidence);
    verify(evidence.gateHistory.every((pass, index) => pass?.index === index && pass.cleared === true), 'Gate history is not an exact cleared sequence.', evidence);
    verify(evidence.gateHistory.every((pass, index, passes) =>
      finiteNumber(pass?.time)
      && pass.time > 0
      && (index === 0 || pass.time >= passes[index - 1].time)
      && finiteNumber(pass.radialDistance)
      && pass.radialDistance >= 0
      && finiteNumber(pass.speed)
      && pass.speed > 0), 'Gate history contains invalid or non-monotonic pass evidence.', evidence);
    return evidence;
  });

  await report.check({
    id: 'M4.destination-finish',
    name: 'Final destination terminates the run',
    criteria: [criterion('M4', 'full', 'Validates the terminal phase and non-null resolution result after the final gate.')],
    assertion: 'The deterministic playthrough reaches phase "finished" with a positive total time and a non-empty destination name.',
  }, async () => {
    const evidence = unwrap(playthroughOutcome);
    verify(evidence.finalPhase === 'finished', 'Playthrough did not reach the finished phase.', evidence);
    verify(evidence.result !== null, 'Finished phase did not expose a run result.', evidence);
    verify(finiteNumber(evidence.result.totalTime) && evidence.result.totalTime > 0, 'Run result totalTime is not positive and finite.', evidence);
    verify(typeof evidence.result.destinationName === 'string' && evidence.result.destinationName.trim().length > 0, 'Run result has no destination name.', evidence);
    return evidence;
  });

  // Regression guard. The overdrive latch has failed twice in two different ways: it re-lit
  // for a fraction of a second every two seconds at a 20% re-arm level, and before that it
  // re-lit for a single frame whenever regeneration crossed a hair above empty. Both read as a
  // fault rather than a resource, and neither is visible in a screenshot or a completion time.
  // Every other check in this file starts a run through `window.__LV.startRun`, which is why the
  // briefing screen could be built, rendered, mapped, and completely unreachable for the entire
  // project without a single test noticing — and why, when it was finally routed, its own ENGAGE
  // button was still wired to the handler that opened it, making the screen a dead end. Nothing
  // that bypasses the interface can catch a defect in the interface's wiring.
  await report.check({
    id: 'UX.screen-flow',
    name: 'A player can reach a run by clicking the real buttons',
    criteria: [criterion('M6', 'full', 'Drives the title -> briefing -> countdown -> flying path through the DOM, which no harness-driven check exercises.')],
    assertion:
      'From a cold load the phase is title; clicking BEGIN RUN reaches the briefing; the briefing '
      + 'names the mouse, SHIFT and SPACE; clicking ENGAGE reaches the countdown and then flying.',
  }, async () => {
    await reloadHarness(page, options);
    const atLoad = await callHarness(page, 'phase');
    verify(atLoad === 'title', `Cold load should present the title, got "${atLoad}".`, { atLoad });

    // A measured mouse click, not locator.click(). Playwright's locator.click() calls
    // DOM.scrollIntoViewIfNeeded, which displaces the overlay stack 4 times in 6 mid-animation —
    // so this check's own captures could photograph a broken layout and mislead the next
    // reviewer, which is the same class of defect as photographing a transition.
    const click = async (label) => {
      const button = page.locator(`button:has-text("${label}"), [role=button]:has-text("${label}")`).first();
      await button.waitFor({ state: 'visible', timeout: options.timeoutMs });
      const box = await button.boundingBox();
      verify(box, `Could not measure the "${label}" button.`, { label });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const scrolled = await page.evaluate(() => document.documentElement.scrollTop
        + document.body.scrollTop + (document.querySelector('.lv-root')?.scrollTop ?? 0));
      verify(scrolled === 0, `Clicking "${label}" scrolled the overlay stack by ${scrolled}px.`, { label, scrolled });
    };

    await click('BEGIN RUN');
    await page.waitForFunction(() => window.__LV?.phase() === 'briefing', null, { timeout: options.timeoutMs });

    // The one screen whose entire job is to teach the verbs has to name them.
    const briefingText = await page.evaluate(() => document.body.innerText.toUpperCase());
    const missingVerbs = ['MOUSE', 'SHIFT', 'SPACE'].filter((verb) => !briefingText.includes(verb));
    verify(missingVerbs.length === 0, `Briefing does not name: ${missingVerbs.join(', ')}.`, { missingVerbs });

    await click('ENGAGE');
    await page.waitForFunction(() => ['countdown', 'flying'].includes(window.__LV?.phase()), null, { timeout: options.timeoutMs });
    await page.waitForFunction(() => window.__LV?.phase() === 'flying', null, { timeout: options.timeoutMs });

    return { atLoad, reachedBriefing: true, verbsNamed: ['MOUSE', 'SHIFT', 'SPACE'], reachedFlying: true };
  });

  // hazard() and channelExcursion() were added to the harness with docstrings naming the exact
  // defects they catch, and then no suite called either one — the quality-invariance property
  // was instrumented and unasserted, which is the original failure mode verbatim.
  await report.check({
    id: 'M3.hazard-invariance',
    name: 'The course is identical at every quality level',
    /* The previous wording of this `full` was disproved by mutation: it claimed the
       collision/draw parity property was asserted directly, while both call sites read the same
       list — so rewiring the collider to the full field changed no check in the gate, recreating
       the exact historical defect hazard() was built to catch. The collider now records which
       list it iterated and hazard() reports the reference identity, so the coupling below is
       asserted rather than assumed and `full` is earned rather than declared. */
    criteria: [criterion('M3', 'full', 'Asserts clearance-profile invariance across quality AND that the list the collider actually iterated is, by identity, the drawn gameplay list hazard() sampled.')],
    assertion:
      'hazard() reports the same clearance profile at low, medium, high and ultra while the drawn '
      + 'population changes, and at every quality the collider\'s own recorded list is identical '
      + 'to the sampled one.',
  }, async () => {
    /* One simulated frame guarantees resolveCollisions has recorded a list — it runs
       unconditionally in simulate(), attract mode included. */
    await callHarness(page, 'step', [2]);
    const byQuality = {};
    for (const quality of ['low', 'medium', 'high', 'ultra']) {
      await callHarness(page, 'setSettings', [{ quality }]);
      await callHarness(page, 'step', [2]);
      // Sample count is pinned: hazard() is sample-count sensitive, and three reviewers quoting
      // its digits without stating theirs produced three different answers for one property.
      byQuality[quality] = await callHarness(page, 'hazard', [900]);
      verify(byQuality[quality].colliderSharesDrawnList === true,
        `At quality "${quality}" the collider is not iterating the drawn gameplay list — the `
        + 'historical full-field/drawn-subset split is back, or nothing has simulated a frame.',
        byQuality[quality]);
    }
    const profile = (h) => `${h.minClearance}/${h.p05Clearance}/${h.medianClearance}/${h.tightFraction}`;
    const first = profile(byQuality.low);
    for (const [quality, h] of Object.entries(byQuality)) {
      verify(profile(h) === first, `Clearance profile changes at quality "${quality}".`, { byQuality });
    }
    const gameplay = new Set(Object.values(byQuality).map((h) => h.gameplayRocks));
    verify(gameplay.size === 1, 'Gameplay rock count changes with quality.', { byQuality });
    const drawn = Object.values(byQuality).map((h) => h.activeRocks);
    verify(drawn[0] < drawn[drawn.length - 1], 'Quality no longer changes the drawn population at all.', { byQuality });
    return { samples: 900, byQuality };
  });

  await report.check({
    id: 'GAME.renderscale-intent-persists',
    name: 'A deliberate render-scale choice survives a quality round-trip and a reload',
    criteria: [criterion('M6', 'partial', 'Exercises the settings store through the player-facing setSettings route; the slider widget itself is DOM-covered by UX.screen-flow only.')],
    assertion:
      'Setting renderScale to a value that HAPPENS to equal a quality profile default, then '
      + 'changing quality, keeps the chosen value — intent is read from the stored '
      + 'renderScaleTouched flag, not inferred from value equality — and both survive a reload.',
  }, async () => {
    /* The revert this exists to catch: renderScaleForQuality once inferred "player never touched
       the slider" from current.renderScale === the profile default. That inference was sound
       ONLY while 0.72/0.86 were unreachable slider stops, and putting them on the grid destroyed
       it: a deliberate 0.72 read as untouched and every later quality change overwrote it —
       silently, permanently, persisted. Restore that inference and this check goes red; nothing
       else in the gate would. The killing sequence is exactly the one below. */
    const before = await callHarness(page, 'settings');
    await callHarness(page, 'setSettings', [{ quality: 'low' }]);
    await callHarness(page, 'setSettings', [{ renderScale: 0.72 }]); // == the low profile default, deliberately
    await callHarness(page, 'setSettings', [{ quality: 'ultra' }]);
    const after = await callHarness(page, 'settings');
    verify(after.renderScaleTouched === true, 'Moving the slider did not mark renderScale as touched.', after);
    verify(Math.abs(after.renderScale - 0.72) < 1e-9, `Quality change overwrote a deliberate 0.72 with ${after.renderScale} — intent is being inferred from value equality again.`, after);
    await reloadHarness(page, options.timeoutMs);
    const reloaded = await callHarness(page, 'settings');
    verify(reloaded.renderScaleTouched === true, 'renderScaleTouched did not survive a reload.', reloaded);
    verify(Math.abs(reloaded.renderScale - 0.72) < 1e-9, 'The chosen renderScale did not survive a reload.', reloaded);
    /* Leave the page as this suite found it: later checks assume the boot-time quality. */
    await callHarness(page, 'setSettings', [{ quality: before.quality, renderScale: before.renderScale }]);
    return { chose: 0.72, afterQualityChange: after.renderScale, afterReload: reloaded.renderScale };
  });

  const boostOutcome = await report.check({
    id: 'FEEL.boost-latch',
    name: 'Overdrive latches cleanly instead of stuttering',
    criteria: [criterion('M2', 'partial', 'Covers the boost resource state machine, which no other check exercises.')],
    assertion:
      'With boost held continuously for 24 simulated seconds, the drive produces a small number of '
      + 'sustained bursts (each at least 0.6 s) rather than many short re-ignitions, and the reserve '
      + 'never sits pinned just above empty while the key is down.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'step', [240, 1 / 60]);
    await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);

    const samples = [];
    for (let i = 0; i < 120; i += 1) {
      await callHarness(page, 'step', [12, 1 / 60]);
      const telemetry = await callHarness(page, 'telemetry');
      samples.push({ energy: telemetry.energy, boosting: telemetry.boosting });
    }
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setDriven', [false]);

    const bursts = [];
    let run = 0;
    for (const sample of samples) {
      if (sample.boosting) run += 1;
      else if (run > 0) { bursts.push(run * 0.2); run = 0; }
    }
    if (run > 0) bursts.push(run * 0.2);

    const evidence = { samples: samples.length, bursts, shortest: bursts.length ? Math.min(...bursts) : null };
    verify(bursts.length > 0, 'Boost never engaged while the key was held.', evidence);
    verify(bursts.length <= 8, `Boost re-ignited ${bursts.length} times in 24 s; the latch is stuttering.`, evidence);
    verify(bursts.every((d) => d >= 0.6), `Shortest boost burst was ${evidence.shortest} s; bursts under 0.6 s read as a fault.`, evidence);
    return evidence;
  });
  void boostOutcome;
}

async function collectInputEvidence(page, options) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [false]);

  const command = {
    pitch: 0.65,
    yaw: -0.45,
    roll: 0.55,
    throttle: 0.7,
    strafeX: 0.35,
    strafeY: -0.25,
    boost: true,
    brake: false,
  };

  try {
    await stepUntilFlying(page, options.timeoutMs);
    const before = await callHarness(page, 'telemetry');
    const beforePose = await callHarness(page, 'pose');
    await callHarness(page, 'setInput', [command]);
    await callHarness(page, 'step', [60]);
    const after = await callHarness(page, 'telemetry');
    const activeInput = await callHarness(page, 'activeInput');
    const afterPose = await callHarness(page, 'pose');
    await callHarness(page, 'setInput', [null]);

    const evidence = {
      fixedTimestep: 1 / 60,
      simulatedFrames: 60,
      command,
      commandFields: Object.keys(command),
      before: compactTelemetry(before),
      after: compactTelemetry(after),
      activeInput,
      beforePose,
      afterPose,
      releasedToHumanControl: true,
    };
    const numericFields = ['pitch', 'yaw', 'roll', 'throttle', 'strafeX', 'strafeY'];
    verify(numericFields.every((field) => finiteNumber(activeInput?.[field]) && Math.abs(activeInput[field] - command[field]) <= 1e-6), 'Applied numeric input does not match the command.', evidence);
    verify(activeInput?.boost === command.boost && activeInput?.brake === command.brake, 'Applied button input does not match the command.', evidence);
    verify(validPose(beforePose) && validPose(afterPose), 'Harness pose contains a non-finite or malformed vector.', evidence);
    verify(vectorDistance(beforePose.position, afterPose.position) > 0.01, 'Ship position did not change under commanded input.', evidence);
    verify(afterPose.angularVelocity.every((value) => Math.abs(value) > 0.001), 'Pitch, yaw, and roll did not all produce body angular velocity.', evidence);
    verify(after?.phase === 'flying', 'Input probe left the flying phase.', evidence);
    verify(finiteNumber(after?.throttle) && Math.abs(after.throttle - command.throttle) <= 0.05, 'Telemetry throttle does not reflect the command.', evidence);
    verify(finiteNumber(after?.speed) && after.speed > 0, 'Input probe did not produce positive speed.', evidence);
    verify(finiteNumber(after?.pitch) && finiteNumber(after?.roll), 'Pitch or roll telemetry is not finite.', evidence);
    verify(Math.abs(after.pitch) > 0.001 || Math.abs(after.roll) > 0.001, 'Neither pitch nor roll responded to rotational input.', evidence);
    return evidence;
  } finally {
    await bestEffort(page, 'setInput', [null]);
    await bestEffort(page, 'setDriven', [false]);
  }
}

async function collectPlaythrough(page, options) {
  verify(page, 'Browser page is unavailable.');
  await reloadHarness(page, options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);

  const maxFrames = Math.ceil(options.maxSimSeconds * 60);
  const chunkFrames = 120;
  const gateIndices = [];
  const phaseTrace = [];
  let simulatedFrames = 0;
  let telemetry = null;
  let finalPhase = null;

  try {
    while (simulatedFrames <= maxFrames) {
      finalPhase = await callHarness(page, 'phase');
      telemetry = await callHarness(page, 'telemetry');
      if (phaseTrace.at(-1) !== finalPhase) phaseTrace.push(finalPhase);
      if (Number.isInteger(telemetry?.gate?.index) && gateIndices.at(-1) !== telemetry.gate.index) {
        gateIndices.push(telemetry.gate.index);
      }
      if (finalPhase === 'finished') break;
      const frames = Math.min(chunkFrames, maxFrames - simulatedFrames);
      if (frames <= 0) break;
      await callHarness(page, 'step', [frames], options.timeoutMs);
      simulatedFrames += frames;
    }

    const result = await callHarness(page, 'result');
    const gateHistory = await callHarness(page, 'gateHistory');
    const evidence = {
      seed: options.seed,
      fixedTimestep: 1 / 60,
      autopilotSkill: 1,
      simulatedFrames,
      simulatedSeconds: simulatedFrames / 60,
      maximumSimulatedSeconds: options.maxSimSeconds,
      phaseTrace,
      gateIndices,
      finalPhase,
      finalTelemetry: compactTelemetry(telemetry),
      gateHistory,
      result,
    };
    verify(finalPhase === 'finished', `Playthrough exceeded ${options.maxSimSeconds} simulated seconds before finishing.`, evidence);
    return evidence;
  } finally {
    await bestEffort(page, 'setAutopilot', [false]);
    await bestEffort(page, 'setDriven', [false]);
  }
}

/**
 * Drives the REAL input path — no harness override — with dispatched key events.
 *
 * `Input.update()` returns inside the override branch, so every check that supplies input through
 * `setInput` executes none of the virtual stick, the expo response curves, the key mapping, the
 * throttle integrator, `sensitivity`, `invertY` or the gamepad block. Setting `setInput(null)` and
 * pressing real keys is the only way any of that runs under test.
 */
async function collectKeyboardEvidence(page, options) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'startRun', [{ skipIntro: true }]);
  await callHarness(page, 'setAutopilot', [false]);
  /* The point of the whole check: no override, so `update()` falls through to the real path. */
  await callHarness(page, 'setInput', [null]);
  await stepUntilFlying(page, options.timeoutMs);

  const hold = async (key, frames = 10) => {
    await page.keyboard.down(key);
    await callHarness(page, 'step', [frames], options.timeoutMs);
    const input = await callHarness(page, 'activeInput');
    await page.keyboard.up(key);
    await callHarness(page, 'step', [4], options.timeoutMs);
    return input;
  };

  const rollRight = await hold('d');
  const rollLeft = await hold('a');
  const strafeRight = await hold('e');
  const pitchUp = await hold('ArrowUp');
  const pitchDown = await hold('ArrowDown');

  /* The throttle integrator, sampled as a RATE rather than an endpoint. `throttle` moves by
     1.35 * dt per frame, so one sample proves nothing: "it went down" passes against a plain
     assignment. Two equal deltas do not — an assignment produces a first delta and then zero.
     KeyS rather than KeyW because throttle starts at 0.85 and KeyW saturates at 1.0 in 0.111 s,
     which would leave the rate unobservable and let a stub that pins throttle high pass. */
  const t0 = (await callHarness(page, 'activeInput')).throttle;
  await page.keyboard.down('s');
  await callHarness(page, 'step', [15], options.timeoutMs);
  const t1 = (await callHarness(page, 'activeInput')).throttle;
  await callHarness(page, 'step', [15], options.timeoutMs);
  const t2 = (await callHarness(page, 'activeInput')).throttle;
  await page.keyboard.up('s');
  await callHarness(page, 'step', [4], options.timeoutMs);

  /* Both positions. One is satisfiable by a build that ignores the flag and happens to carry the
     sign the test expects. */
  await callHarness(page, 'setSettings', [{ invertY: false }]);
  const normalPitch = await hold('ArrowUp');
  await callHarness(page, 'setSettings', [{ invertY: true }]);
  const invertedPitch = await hold('ArrowUp');
  await callHarness(page, 'setSettings', [{ invertY: false }]);

  return {
    rollRight: rollRight.roll,
    rollLeft: rollLeft.roll,
    strafeRight: strafeRight.strafeX,
    pitchUp: pitchUp.pitch,
    pitchDown: pitchDown.pitch,
    throttle: { t0, t1, t2, delta1: t0 - t1, delta2: t1 - t2, expectedDelta: 1.35 * 0.25 },
    invertY: { off: normalPitch.pitch, on: invertedPitch.pitch },
  };
}

async function stepUntilFlying(page, timeoutMs) {
  let simulatedFrames = 0;
  while (simulatedFrames <= 600) {
    const phase = await callHarness(page, 'phase');
    if (phase === 'flying') return;
    if (phase === 'finished') throw new Error('Run finished before the input probe reached flying.');
    await callHarness(page, 'step', [30], timeoutMs);
    simulatedFrames += 30;
  }
  throw new Error('Run did not reach flying within 10 simulated seconds.');
}

function compactTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return telemetry;
  return {
    phase: telemetry.phase,
    speed: telemetry.speed,
    maxSpeed: telemetry.maxSpeed,
    throttle: telemetry.throttle,
    boosting: telemetry.boosting,
    roll: telemetry.roll,
    pitch: telemetry.pitch,
    gate: telemetry.gate,
    courseRemaining: telemetry.courseRemaining,
    elapsed: telemetry.elapsed,
    splits: telemetry.splits,
  };
}

function validPose(pose) {
  if (!pose || typeof pose !== 'object') return false;
  return [
    [pose.position, 3],
    [pose.quaternion, 4],
    [pose.velocity, 3],
    [pose.angularVelocity, 3],
    [pose.forward, 3],
  ].every(([vector, length]) => Array.isArray(vector) && vector.length === length && vector.every(finiteNumber));
}

function vectorDistance(a, b) {
  return Math.hypot(...a.map((value, index) => value - b[index]));
}

async function bestEffort(page, method, args) {
  try {
    await callHarness(page, method, args);
  } catch {
    // The originating check records the actionable failure.
  }
}

async function capture(operation) {
  try {
    return { ok: true, value: await operation(), error: null };
  } catch (error) {
    return { ok: false, value: null, error };
  }
}

function unwrap(outcome) {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}
