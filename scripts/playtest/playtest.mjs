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
  'hazard',
  'step',
  'setDriven',
  'setFixedTimestep',
  'setSettings',
  'settings',
  'cameraMode',
  'clearVantage',
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

  await report.check({
    id: 'INPUT.mouse-pipeline',
    name: 'Pointer-locked mouse flight works, and lock loss releases mouse buttons',
    criteria: [criterion('M7', 'partial', 'Drives the shipped mouse pipeline — lock gate, virtual stick, sensitivity/expo, button mapping — via a pointerLockElement override; trusted lock acquisition and raw OS deltas remain human-only.')],
    assertion:
      'With document.pointerLockElement faked to the canvas, synthetic mousemove deflects pitch/yaw '
      + 'through the virtual stick, LMB sets boost; on lock loss WITHOUT a mouseup the mouse boost '
      + 'clears (the Esc-latch regression), while a physically held keyboard boost survives it.',
  }, async () => {
    /* GOAL.md carried "the mouse half needs a human... Nothing else will do it" for six rounds.
       Disproved by construction in round 9: everything except trusted lock ACQUISITION and raw OS
       delta delivery is drivable — and the first contact with the never-exercised surface found
       that round's only surviving blocker, the boost latch this check now pins. */
    await callHarness(page, 'ready', [], options.timeoutMs);
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [null]);
    await stepUntilFlying(page, options.timeoutMs);

    const setLock = async (on) => {
      await page.evaluate((locked) => {
        const canvas = document.querySelector('canvas');
        window.__mockLock = locked;
        Object.defineProperty(document, 'pointerLockElement', {
          get: () => (window.__mockLock ? canvas : null),
          configurable: true,
        });
        document.dispatchEvent(new Event('pointerlockchange'));
      }, on);
    };
    const mouse = async (type, init) => {
      await page.evaluate(({ t, i }) => { document.dispatchEvent(new MouseEvent(t, i)); }, { t: type, i: init });
    };
    /* Lock loss pauses the game through the overlay (by design), which stops input.update() and
       would leave activeInput stale — so every post-lock-loss read resumes first. */
    const resumeAndRead = async () => {
      await page.evaluate(() => window.__LV.pauseMenu(false));
      await callHarness(page, 'step', [4]);
      return callHarness(page, 'activeInput');
    };

    await setLock(true);
    await mouse('mousemove', { movementX: 160, movementY: -110 });
    await callHarness(page, 'step', [2]);
    const steered = await callHarness(page, 'activeInput');
    verify(Math.abs(steered.yaw) > 0.05 && Math.abs(steered.pitch) > 0.05,
      `Synthetic mouse movement did not reach pitch/yaw through the virtual stick: yaw ${steered.yaw}, pitch ${steered.pitch}.`, steered);

    await mouse('mousedown', { button: 0 });
    await callHarness(page, 'step', [2]);
    const boosting = await callHarness(page, 'activeInput');
    verify(boosting.boost === true, 'LMB did not engage boost through the mouse pipeline.', boosting);

    /* The latch: drop the lock with the button still down — the mouseup after Esc is exactly the
       event the guard drops. Boost must clear anyway, from the lock transition itself. */
    await setLock(false);
    const released = await resumeAndRead();
    verify(released.boost === false,
      'Mouse boost survived pointer-lock loss with no mouseup — the Esc latch is back: hold boost, Esc, resume, and the ship boosts indefinitely.', released);

    /* The rejected alternative's failure mode, asserted so nobody ships it later: a PHYSICAL
       keyboard boost held across the same transition must NOT be released. */
    await page.keyboard.down('Shift');
    await setLock(true);
    await mouse('mousedown', { button: 0 });
    await callHarness(page, 'step', [2]);
    await setLock(false);
    const keyboardHeld = await resumeAndRead();
    await page.keyboard.up('Shift');
    await mouse('mouseup', { button: 0 });
    await page.evaluate(() => { delete document.pointerLockElement; delete window.__mockLock; });
    await callHarness(page, 'step', [2]);
    verify(keyboardHeld.boost === true,
      'Lock loss released a physically held keyboard boost — clearing must touch mouse state only.', keyboardHeld);

    return {
      steered: { yaw: steered.yaw, pitch: steered.pitch },
      mouseBoostEngaged: boosting.boost,
      clearedOnLockLoss: released.boost === false,
      keyboardSurvivedLockLoss: keyboardHeld.boost === true,
      notCovered: ['trusted pointer-lock acquisition', 'raw OS mouse delta delivery', 'real Esc keystroke ordering'],
    };
  });

  await report.check({
    id: 'CAMERA.cockpit-toggle-persistence',
    name: 'The real view key applies and persists the cockpit camera',
    criteria: [criterion('M7', 'partial', 'Drives the real KeyV action during active flight, then verifies the applied camera geometry and the SettingsStore reload path.')],
    assertion:
      'During active flight a real KeyV changes chase to cockpit without changing any ship state; '
      + 'cockpit places the camera within six metres of the ship and uses a near plane below 0.25 m; '
      + 'the selection survives reload; a second real KeyV restores the chase boom and original '
      + 'near plane, again without directly changing ship state.',
  }, async () => {
    const e = await collectCameraEvidence(page, options);
    verify(e.phaseAtFirstToggle === 'flying' && e.phaseAtSecondToggle === 'flying',
      'KeyV was not exercised during active flight.', e);
    verify(e.initial.mode === 'chase' && e.initial.settingsMode === 'chase',
      'The probe did not begin with both applied and stored modes set to chase.', e);
    verify(e.afterFirstKey.mode === 'cockpit' && e.afterFirstKey.settingsMode === 'cockpit',
      'A real KeyV did not change both the applied camera and stored setting to cockpit.', e);
    verify(e.afterFirstKey.shipUnchanged,
      'Changing to cockpit directly mutated ship position, orientation, velocity, or angular velocity.', e);
    verify(e.cockpit.distanceFromShip < 6,
      `Cockpit camera is ${e.cockpit.distanceFromShip} m from the ship; this is still a chase pose.`, e);
    verify(e.cockpit.shipForwardAlignment > 0.995,
      'Cockpit camera is close to the ship but is not aimed with the ship nose.', e);
    verify(e.cockpit.near > 0 && e.cockpit.near < 0.25,
      `Cockpit near plane is ${e.cockpit.near} m; close cockpit geometry will clip.`, e);
    verify(e.initial.distanceFromShip > e.cockpit.distanceFromShip * 2.5,
      'Cockpit did not materially move the camera in from the chase boom.', e);
    verify(e.initial.near > e.cockpit.near * 4,
      'Cockpit did not materially tighten the camera near plane.', e);
    verify(e.persisted.settingsMode === 'cockpit' && e.persisted.mode === 'cockpit',
      'The cockpit selection did not survive the SettingsStore reload path.', e);
    verify(e.persisted.shipMatchesChaseTrace,
      'An identical 45-frame flight trace produced different ship state in cockpit and chase modes.', e);
    verify(e.afterSecondKey.mode === 'chase' && e.afterSecondKey.settingsMode === 'chase',
      'A second real KeyV did not restore both applied and stored chase mode.', e);
    verify(e.afterSecondKey.shipUnchanged,
      'Returning to chase directly mutated ship position, orientation, velocity, or angular velocity.', e);
    verify(Math.abs(e.restored.near - e.initial.near) <= 1e-9,
      `Returning to chase restored near ${e.restored.near}, not the original ${e.initial.near}.`, e);
    verify(e.restored.distanceFromShip > e.persisted.distanceFromShip * 2.5,
      'Returning to chase did not restore the external boom pose.', e);
    verify(Math.abs(e.restored.distanceFromShip - e.initial.distanceFromShip) < 4,
      'The restored chase boom is materially different from the initial chase pose.', e);
    verify(vectorDistance(e.restored.forward, e.initial.forward) < 0.02,
      'The restored chase camera did not recover the initial forward aim.', e);
    return e;
  });

  await report.check({
    id: 'FEEL.speed-ceilings',
    name: 'Cruise and overdrive deliver the faster flight envelope',
    criteria: [criterion('M2', 'partial', 'Measures the shipped flight model under sustained throttle at a fixed timestep.')],
    assertion:
      'After settling at full cruise the ship exceeds 450 m/s; a two-second overdrive then exceeds '
      + '1050 m/s, while telemetry advertises a cap of at least 1180 m/s.',
  }, async () => {
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [{ throttle: 1, boost: false }]);
    await callHarness(page, 'step', [480, 1 / 60]);
    const cruise = await callHarness(page, 'telemetry');
    await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
    await callHarness(page, 'step', [120, 1 / 60]);
    const boosted = await callHarness(page, 'telemetry');
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setDriven', [false]);
    const evidence = {
      cruiseSpeed: cruise.speed,
      boostedSpeed: boosted.speed,
      advertisedMaxSpeed: boosted.maxSpeed,
      simulatedSeconds: { cruise: 8, boost: 2 },
    };
    verify(finiteNumber(cruise.speed) && cruise.speed > 450,
      `Settled cruise was ${cruise.speed} m/s; the faster cruise envelope is absent.`, evidence);
    verify(finiteNumber(boosted.speed) && boosted.speed > 1050,
      `Two-second overdrive reached only ${boosted.speed} m/s.`, evidence);
    verify(finiteNumber(boosted.maxSpeed) && boosted.maxSpeed >= 1180,
      `Advertised maximum is still ${boosted.maxSpeed} m/s.`, evidence);
    return evidence;
  });

  const playthroughOutcome = await capture(async () => collectPlaythrough(page, options));

  await report.check({
    id: 'M3.sequential-gates',
    name: 'Autopilot clears every gate in order',
    criteria: [criterion('M3', 'full', 'Uses a fixed-timestep scripted playthrough and validates monotonic gate progression plus the final result counts.')],
    assertion: 'At fixed 1/60 s timestep, skill-1 autopilot reaches a clean S-rank result with gatesTotal > 0, clears every gate exactly once in index order, records finite pass evidence, and emits one split per gate.',
  }, async () => {
    const evidence = unwrap(playthroughOutcome);
    const result = evidence.result;
    verify(result && Number.isInteger(result.gatesTotal) && result.gatesTotal > 0, 'Finished result has no positive gate total.', evidence);
    verify(result.gatesCleared === result.gatesTotal, 'Not every gate was cleared.', evidence);
    verify(result.cleanRun === true, 'Skill-1 autopilot hit a hazard at the faster flight envelope.', evidence);
    verify(result.rank === 'S', `Skill-1 autopilot finished at rank ${result.rank} instead of S.`, evidence);
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

  await report.check({
    id: 'FEEL.gate-boost-recharge',
    name: 'Every cleared gate immediately restores overdrive reserve',
    criteria: [criterion('M3', 'full', 'Uses before/after reserve evidence captured synchronously inside the real gate-pass callback.')],
    assertion:
      'Every deterministic autopilot pass records normalised reserve immediately before and after '
      + 'the crossing; after equals min(1, before + 0.25), and at least one pass receives 20% or more.',
  }, async () => {
    const evidence = unwrap(playthroughOutcome);
    const passes = evidence.gateHistory;
    verify(Array.isArray(passes) && passes.length > 0, 'No gate-pass recharge evidence was recorded.', evidence);
    verify(passes.every((pass) => finiteNumber(pass.boostEnergyBefore)
      && finiteNumber(pass.boostEnergyAfter)
      && Math.abs(pass.boostEnergyAfter - Math.min(1, pass.boostEnergyBefore + 0.25)) <= 1e-6),
    'A gate did not apply the 25%-capacity recharge synchronously.', { passes });
    const deltas = passes.map((pass) => pass.boostEnergyAfter - pass.boostEnergyBefore);
    verify(deltas.some((delta) => delta >= 0.2),
      'Every gate reward was clipped near full, so the playthrough did not prove a material recharge.', { passes, deltas });
    return { passes, deltas };
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
    const byQuality = {};
    for (const quality of ['low', 'medium', 'high', 'ultra']) {
      await callHarness(page, 'setSettings', [{ quality }]);
      // Reset to one simulation origin: a moving course cannot be compared at four different
      // timestamps and called a quality difference.
      await callHarness(page, 'startRun', [{ skipIntro: true }]);
      await callHarness(page, 'setAutopilot', [false]);
      await callHarness(page, 'setInput', [{ throttle: 0, brake: true }]);
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
    const moving = new Set(Object.values(byQuality).map((h) => `${h.motion.count}/${h.motion.signature}`));
    verify(moving.size === 1, 'The moving gameplay subset changes with quality.', { byQuality });
    const drawn = Object.values(byQuality).map((h) => h.activeRocks);
    verify(drawn[0] < drawn[drawn.length - 1], 'Quality no longer changes the drawn population at all.', { byQuality });
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setDriven', [false]);
    return { samples: 900, byQuality };
  });

  await report.check({
    id: 'M3.moving-hazard-bounds',
    name: 'Moving hazards are deterministic, bounded, and resettable',
    criteria: [criterion('M3', 'full', 'Compares real simulated hazard positions across reset and quality, and asserts measured displacement/reaction bounds.')],
    assertion:
      'Only the fixed gameplay subset moves; after identical three-second traces low and ultra '
      + 'produce the same signature, a new run reproduces it, sway is non-zero but below the '
      + 'declared small bound, and player response never exceeds two metres.',
  }, async () => {
    const trace = async (quality) => {
      await callHarness(page, 'setSettings', [{ quality }]);
      await callHarness(page, 'startRun', [{ skipIntro: true }]);
      await callHarness(page, 'setAutopilot', [false]);
      await callHarness(page, 'setInput', [{ throttle: 0, brake: true }]);
      const reset = await callHarness(page, 'hazard', [60]);
      await callHarness(page, 'step', [180, 1 / 60]);
      const moved = await callHarness(page, 'hazard', [60]);
      return { reset: reset.motion, moved: moved.motion };
    };
    await callHarness(page, 'setDriven', [true]);
    const low = await trace('low');
    const lowReplay = await trace('low');
    const ultra = await trace('ultra');
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setDriven', [false]);

    const playerRunMotion = unwrap(playthroughOutcome).finalHazard.motion;
    const evidence = { low, lowReplay, ultra, playerRunMotion };
    verify(low.reset.maxDisplacement === 0 && low.reset.elapsed === 0,
      'A new run did not restore the authored moving-hazard state.', evidence);
    verify(low.moved.count === low.moved.cap && low.moved.count > 0 && low.moved.cap <= 16,
      'Moving hazards are not the expected small fixed-cap set.', evidence);
    verify(low.moved.signature === lowReplay.moved.signature && low.moved.signature === ultra.moved.signature,
      'Identical traces changed across reset or quality.', evidence);
    verify(low.moved.maxDisplacement > 0
      && low.moved.maxDisplacement <= low.moved.displacementLimit + 1e-6,
    'Moving-hazard displacement is absent or exceeds its hard bound.', evidence);
    verify(playerRunMotion.maxPlayerResponse > 0
      && playerRunMotion.maxPlayerResponse <= playerRunMotion.playerResponseLimit + 1e-6,
    'The real playthrough did not observe a bounded player-proximity response.', evidence);
    verify(playerRunMotion.minPlayerDistanceDelta >= -1e-6,
      'A proximity response moved a hazard closer to the player.', evidence);
    return evidence;
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
    // A burst still active when the 24 s observation window closes is right-censored: its
    // measured prefix is not its duration and must not fail the minimum-duration assertion.
    const trailingBurst = run > 0 ? run * 0.2 : null;

    const gaps = [];
    let gap = 0;
    let seenBurst = false;
    for (const sample of samples) {
      if (sample.boosting) {
        if (seenBurst && gap > 0) gaps.push(gap * 0.2);
        seenBurst = true;
        gap = 0;
      } else if (seenBurst) gap += 1;
    }
    const evidence = {
      samples: samples.length,
      bursts,
      recoveryGaps: gaps,
      trailingBurst,
      firstBurst: bursts[0] ?? null,
      shortest: bursts.length ? Math.min(...bursts) : null,
    };
    verify(bursts.length > 0, 'Boost never engaged while the key was held.', evidence);
    verify(bursts.length <= 8, `Boost re-ignited ${bursts.length} times in 24 s; the latch is stuttering.`, evidence);
    verify(bursts.every((d) => d >= 0.6), `Shortest boost burst was ${evidence.shortest} s; bursts under 0.6 s read as a fault.`, evidence);
    verify(evidence.firstBurst >= 3, `A full reserve lasted only ${evidence.firstBurst} s; the longer burst is absent.`, evidence);
    verify(gaps.length > 0 && Math.min(...gaps) <= 2.6,
      `Fast recovery was not observed; gaps were ${gaps.join(', ')} s.`, evidence);
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
    const finalHazard = await callHarness(page, 'hazard', [60]);
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
      finalHazard,
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

async function collectCameraEvidence(page, options) {
  verify(page, 'Browser page is unavailable.');
  const prepareFlight = async () => {
    // Force a fresh driven-mode transition so both sides of the reload comparison get the same
    // world-clock origin as well as the same fixed step.
    await callHarness(page, 'setDriven', [false]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [{ throttle: 0, brake: true }]);
    await callHarness(page, 'clearVantage');
    await stepUntilFlying(page, options.timeoutMs);
    // Let either camera settle at the run's deterministic start before measuring its boom.
    await callHarness(page, 'step', [45, 1 / 60], options.timeoutMs);
  };

  try {
    await callHarness(page, 'ready', [], options.timeoutMs);
    await callHarness(page, 'setSettings', [{ cameraMode: 'chase' }]);
    await prepareFlight();

    const initialPose = await callHarness(page, 'pose');
    const initialShip = shipSnapshot(initialPose);
    const initial = {
      ...cameraSample(initialPose),
      mode: await callHarness(page, 'cameraMode'),
      settingsMode: (await callHarness(page, 'settings')).cameraMode,
    };
    const phaseAtFirstToggle = await callHarness(page, 'phase');
    const beforeFirstKey = shipSnapshot(initialPose);
    await page.keyboard.press('v');
    const immediatelyAfterFirstKey = await callHarness(page, 'pose');
    const afterFirstKey = {
      mode: await callHarness(page, 'cameraMode'),
      settingsMode: (await callHarness(page, 'settings')).cameraMode,
      shipUnchanged: sameShipSnapshot(beforeFirstKey, shipSnapshot(immediatelyAfterFirstKey)),
    };
    await callHarness(page, 'step', [45, 1 / 60], options.timeoutMs);
    const cockpit = cameraSample(await callHarness(page, 'pose'));

    // KeyV must route through SettingsStore, so a cold Game instance must recover cockpit mode.
    await reloadHarness(page, options.timeoutMs);
    const persistedSettings = await callHarness(page, 'settings');
    await prepareFlight();
    const persistedPose = await callHarness(page, 'pose');
    const persisted = {
      ...cameraSample(persistedPose),
      mode: await callHarness(page, 'cameraMode'),
      settingsMode: persistedSettings.cameraMode,
      shipMatchesChaseTrace: sameShipSnapshot(initialShip, shipSnapshot(persistedPose)),
    };

    const phaseAtSecondToggle = await callHarness(page, 'phase');
    const beforeSecondKey = shipSnapshot(persistedPose);
    await page.keyboard.press('v');
    const immediatelyAfterSecondKey = await callHarness(page, 'pose');
    const afterSecondKey = {
      mode: await callHarness(page, 'cameraMode'),
      settingsMode: (await callHarness(page, 'settings')).cameraMode,
      shipUnchanged: sameShipSnapshot(beforeSecondKey, shipSnapshot(immediatelyAfterSecondKey)),
    };
    await callHarness(page, 'step', [45, 1 / 60], options.timeoutMs);
    const restored = cameraSample(await callHarness(page, 'pose'));

    return {
      phaseAtFirstToggle,
      phaseAtSecondToggle,
      initial,
      afterFirstKey,
      cockpit,
      persisted,
      afterSecondKey,
      restored,
    };
  } finally {
    await bestEffort(page, 'setSettings', [{ cameraMode: 'chase' }]);
    await bestEffort(page, 'setInput', [null]);
    await bestEffort(page, 'setDriven', [false]);
  }
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
    energy: telemetry.energy,
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
    [pose.camera?.position, 3],
    [pose.camera?.forward, 3],
  ].every(([vector, length]) => Array.isArray(vector) && vector.length === length && vector.every(finiteNumber))
    && finiteNumber(pose.camera?.near) && pose.camera.near > 0;
}

function shipSnapshot(pose) {
  return {
    position: pose.position,
    quaternion: pose.quaternion,
    velocity: pose.velocity,
    angularVelocity: pose.angularVelocity,
    forward: pose.forward,
  };
}

function sameShipSnapshot(a, b) {
  return Object.keys(a).every((key) =>
    Array.isArray(a[key])
    && Array.isArray(b[key])
    && a[key].length === b[key].length
    && a[key].every((value, index) => Object.is(value, b[key][index])));
}

function cameraSample(pose) {
  verify(validPose(pose), 'Camera probe received a malformed pose.', pose);
  return {
    position: pose.camera.position,
    forward: pose.camera.forward,
    near: pose.camera.near,
    distanceFromShip: vectorDistance(pose.position, pose.camera.position),
    shipForwardAlignment: pose.camera.forward.reduce(
      (sum, value, index) => sum + value * pose.forward[index], 0,
    ),
  };
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
