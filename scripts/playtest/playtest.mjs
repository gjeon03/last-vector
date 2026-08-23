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
  'damageHull',
  'stageCollision',
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
  'cockpitDebug',
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
  const chordOutcome = await capture(async () => collectChordOrderEvidence(page, options));

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
    id: 'INPUT.chord-order-recovery',
    name: 'Throttle and boost survive either chord order at input boundaries',
    criteria: [criterion('M7', 'partial', 'Exercises real W and Shift key events on both sides of run reset and window blur, including modifier resynchronization, held-key repeat quarantine and camera-key modifier guards.')],
    assertion:
      'W then Shift and Shift then W both produce full throttle plus boost; run reset and blur '
      + 'quarantine a W already held across the boundary, including its repeats, until keyup and '
      + 'a fresh keydown, while a held Shift is recovered from the next modifier-bearing W; the '
      + 'same quarantine covers W used to navigate BEGIN RUN, left/right and dual Shift transitions '
      + 'are equivalent, repeated KeyC/legacy KeyV one-shot camera events do not toggle the view, '
      + 'Meta/Ctrl/Alt+C leave platform shortcuts untouched, and Shift+C toggles while boost remains held.',
  }, async () => {
    const e = unwrap(chordOutcome);
    const chordOn = (input) => input?.boost === true && input?.throttle >= 0.99;
    verify(chordOn(e.uninterrupted.wThenShift.together)
      && chordOn(e.uninterrupted.shiftThenW.together),
    'W/Shift order changed the uninterrupted flight command.', e);
    verify(e.acrossReset.wThenShift.afterSecond.boost === true
      && Math.abs(e.acrossReset.wThenShift.afterSecond.throttle - 0.85) <= 1e-9
      && e.acrossReset.wThenShift.afterRepeat1.boost === true
      && Math.abs(e.acrossReset.wThenShift.afterRepeat1.throttle
        - e.acrossReset.wThenShift.afterSecond.throttle) <= 1e-9
      && Math.abs(e.acrossReset.wThenShift.afterRepeat2.throttle
        - e.acrossReset.wThenShift.afterRepeat1.throttle) <= 1e-9
      && Math.abs(e.acrossReset.wThenShift.afterRelease.throttle
        - e.acrossReset.wThenShift.afterRepeat2.throttle) <= 1e-9,
    'A W held across beginRun/reset escaped quarantine before keyup and a fresh keydown.', e);
    verify(chordOn(e.acrossReset.shiftThenW.recovered)
      && chordOn(e.acrossReset.wThenShift.recovered),
    'The post-reset modifier-bearing W or post-keyup fresh W did not recover the chord.', e);
    verify(chordOn(e.rightShift), 'ShiftRight did not produce the same boosted throttle command as ShiftLeft.', e);
    verify(chordOn(e.dualShift.afterLeftRelease),
      'Releasing ShiftLeft cancelled boost while ShiftRight remained held.', e);
    verify(e.acrossBlur.shiftThenW.cleared.boost === false
      && chordOn(e.acrossBlur.shiftThenW.recovered),
    'Blur either latched Shift or failed to recover it from the next W keydown modifier state.', e);
    verify(e.acrossBlur.wThenShift.cleared1.boost === false
      && Math.abs(e.acrossBlur.wThenShift.cleared2.throttle
        - e.acrossBlur.wThenShift.cleared1.throttle) <= 1e-9
      && e.acrossBlur.wThenShift.afterShift.boost === true
      && Math.abs(e.acrossBlur.wThenShift.afterRepeat1.throttle
        - e.acrossBlur.wThenShift.afterShift.throttle) <= 1e-9
      && Math.abs(e.acrossBlur.wThenShift.afterRepeat2.throttle
        - e.acrossBlur.wThenShift.afterRepeat1.throttle) <= 1e-9
      && Math.abs(e.acrossBlur.wThenShift.afterRelease.throttle
        - e.acrossBlur.wThenShift.afterRepeat2.throttle) <= 1e-9
      && chordOn(e.acrossBlur.wThenShift.recovered),
    'Blur either latched W, accepted its suppressed repeat, or failed to re-arm it after keyup.', e);
    verify(e.repeatedView.keyC.before === e.repeatedView.keyC.after,
      'A repeated KeyC keydown retriggered the one-shot camera action.', e);
    verify(e.repeatedView.keyV.before === e.repeatedView.keyV.after,
      'A repeated legacy KeyV keydown retriggered the one-shot camera action.', e);
    for (const modifier of ['meta', 'ctrl', 'alt']) {
      const probe = e.repeatedView.platformModifiedC[modifier];
      verify(probe.before === probe.after,
        `${modifier}+KeyC replaced a platform shortcut with the camera action.`, e);
    }
    verify(e.repeatedView.shiftC.before !== e.repeatedView.shiftC.after,
      'Shift+KeyC did not toggle the camera.', e);
    verify(e.repeatedView.shiftC.input.boost === true,
      'Shift+KeyC toggled the camera but dropped the held boost modifier.', e);
    verify(e.menuHeldW.initialPhase === 'title'
      && e.menuHeldW.afterSFocus === 'settings'
      && e.menuHeldW.afterWFocus === 'begin'
      && e.menuHeldW.afterFirstEnter === 'briefing'
      && e.menuHeldW.afterSecondEnter === 'countdown',
    'The menu-held W probe did not traverse title -> briefing -> countdown through the real keyboard UI path.', e);
    verify(e.menuHeldW.repeatEvent?.code === 'KeyW'
      && e.menuHeldW.repeatEvent?.repeat === true,
    'The menu-held W probe did not observe a real repeated KeyW event.', e);
    verify(Math.abs(e.menuHeldW.afterRepeat.throttle - 0.85) <= 1e-9,
      'A W held for menu navigation escaped quarantine on repeat before its keyup.', e);
    verify(Math.abs(e.menuHeldW.afterRelease.throttle - 0.85) <= 1e-9
      && e.menuHeldW.afterFreshDown.throttle > e.menuHeldW.afterRelease.throttle,
    'W did not remain neutral through keyup and resume throttle on the next fresh keydown.', e);
    return e;
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
    name: 'The primary view key applies and persists the cockpit camera',
    criteria: [criterion('M7', 'partial', 'Drives the primary KeyC action during active flight, then verifies the applied camera geometry and the SettingsStore reload path; checks legacy KeyV once as a compatibility alias.')],
    assertion:
      'During active flight a real KeyC changes chase to cockpit without changing any ship state; '
      + 'cockpit places the camera within six metres of the ship, uses a near plane below 0.25 m, '
      + 'and settles about 8 degrees wider than chase for identical ordinary and full-boost ship '
      + 'traces without exceeding 124 degrees; '
      + 'the selection survives reload; a second real KeyC restores the chase boom and original '
      + 'near plane, again without directly changing ship state; cockpit debug evidence proves '
      + 'unit physical scale at both FOV endpoints, a <=24 draw-call / <=6000-triangle interior, '
      + 'and finite motion, controls, and MFD cadence that respond to deterministic pilot input; '
      + 'one real legacy KeyV still toggles the mode without changing ship state.',
  }, async () => {
    const e = await collectCameraEvidence(page, options);
    verify(e.phaseAtFirstToggle === 'flying' && e.phaseAtSecondToggle === 'flying',
      'KeyC was not exercised during active flight.', e);
    verify(e.initial.mode === 'chase' && e.initial.settingsMode === 'chase',
      'The probe did not begin with both applied and stored modes set to chase.', e);
    verify(e.afterFirstKey.mode === 'cockpit' && e.afterFirstKey.settingsMode === 'cockpit',
      'A real KeyC did not change both the applied camera and stored setting to cockpit.', e);
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
      'An identical settled flight trace produced different ship state in cockpit and chase modes.', e);
    verify(Math.abs(e.persisted.fov - e.initial.fov - 8) <= 0.05,
      `For the identical ship trace cockpit settled at ${e.persisted.fov} degrees versus chase ${e.initial.fov}; the cockpit view is not about 8 degrees wider.`, e);
    verify(e.persisted.fov <= 124 + 0.01,
      `Cockpit FOV exceeded its 124 degree ceiling: ${e.persisted.fov}.`, e);
    verify(e.afterSecondKey.mode === 'chase' && e.afterSecondKey.settingsMode === 'chase',
      'A second real KeyC did not restore both applied and stored chase mode.', e);
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
    verify(e.legacyKeyV.phase === 'flying'
      && e.legacyKeyV.mode === 'cockpit'
      && e.legacyKeyV.settingsMode === 'cockpit',
    'The legacy KeyV compatibility alias did not toggle chase to cockpit during active flight.', e);
    verify(e.legacyKeyV.shipUnchanged,
      'The legacy KeyV compatibility alias directly changed ship state.', e);
    verify(e.boostedChase.mode === 'chase' && e.boostedCockpit.mode === 'cockpit',
      'The full-boost comparison did not measure chase and then enter cockpit through a real KeyC toggle.', e);
    verify(e.boostedCockpit.shipMatchesChaseTrace,
      'The full-boost chase and cockpit probes did not produce identical ship state.', e);
    verify(e.boostedCockpit.fov > e.boostedChase.fov,
      `Full-boost cockpit FOV ${e.boostedCockpit.fov} was not wider than chase ${e.boostedChase.fov}.`, e);
    verify(Math.abs(e.boostedCockpit.fov - e.boostedChase.fov - 8) <= 0.05,
      `For the identical base-100 full-boost trace cockpit settled at ${e.boostedCockpit.fov} degrees versus chase ${e.boostedChase.fov}; the cockpit view is not about 8 degrees wider.`, e);
    verify(e.boostedCockpit.fov <= 124 + 0.01,
      `Full-boost cockpit FOV exceeded its 124 degree ceiling: ${e.boostedCockpit.fov}.`, e);

    const debugSamples = [
      ['first cockpit', e.cockpitDebug],
      ['persisted cockpit', e.persistedCockpitDebug],
      ['boosted cockpit', e.boostedCockpitDebug],
      ['commanded cockpit', e.commandedCockpitDebug],
      ['minimum-FOV cockpit', e.minimumFovCockpitDebug],
    ];
    const numericDebugFields = [
      'fov', 'near', 'drawCalls', 'triangles', 'minCameraDistance',
      'motionX', 'motionY', 'motionZ', 'motionPitch', 'motionYaw', 'motionRoll',
      'stickPitch', 'stickYaw', 'stickRoll', 'throttleAngle', 'mfdUpdates',
    ];
    for (const [label, debug] of debugSamples) {
      verify(debug?.visible === true, `${label} debug state says the cockpit is hidden.`, e);
      verify(
        Array.isArray(debug?.perspectiveScale)
          && debug.perspectiveScale.length === 3
          && debug.perspectiveScale.every(finiteNumber),
        `${label} returned a malformed physical scale.`, e,
      );
      verify(
        numericDebugFields.every((field) => finiteNumber(debug?.[field])),
        `${label} returned non-finite motion, control, instrument, or geometry evidence.`, e,
      );
      verify(debug.drawCalls > 0 && debug.drawCalls <= 24,
        `${label} uses ${debug.drawCalls} cockpit draw calls; the accepted ceiling is 24.`, e);
      verify(debug.triangles > 0 && debug.triangles <= 6_000,
        `${label} uses ${debug.triangles} cockpit triangles; the accepted ceiling is 6000.`, e);
      verify(debug.near > 0 && debug.minCameraDistance > debug.near + 0.005,
        `${label} has cockpit geometry ${debug.minCameraDistance} m ahead of the eye, which does not clear its ${debug.near} m near plane by 5 mm.`, e);
    }
    for (const [label, debug] of [
      ['minimum setting FOV', e.minimumFovCockpitDebug],
      ['maximum setting / full-boost FOV', e.boostedCockpitDebug],
    ]) {
      verify(debug.perspectiveScale.every((value) => Math.abs(value - 1) <= 1e-9),
        `${label} compensated its physical cockpit scale to ${debug.perspectiveScale.join('/')}.`, e);
    }
    verify(Math.abs(e.persistedCockpitDebug.fov - e.persisted.fov) <= 0.05
      && Math.abs(e.boostedCockpitDebug.fov - e.boostedCockpit.fov) <= 0.05
      && Math.abs(e.minimumFovCockpitDebug.fov - e.minimumFovCockpit.fov) <= 0.05,
    'Cockpit debug FOV does not match the applied flight camera at one of the tested endpoints.', e);

    const beforeControls = e.boostedCockpitDebug;
    const afterControls = e.commandedCockpitDebug;
    const stickDelta = Math.hypot(
      afterControls.stickPitch - beforeControls.stickPitch,
      afterControls.stickYaw - beforeControls.stickYaw,
      afterControls.stickRoll - beforeControls.stickRoll,
    );
    const motionDelta = Math.hypot(
      afterControls.motionX - beforeControls.motionX,
      afterControls.motionY - beforeControls.motionY,
      afterControls.motionZ - beforeControls.motionZ,
      afterControls.motionPitch - beforeControls.motionPitch,
      afterControls.motionYaw - beforeControls.motionYaw,
      afterControls.motionRoll - beforeControls.motionRoll,
    );
    verify(stickDelta > 0.01,
      'Deterministic pitch/yaw/roll input did not move the cockpit controls.', e);
    verify(Math.abs(afterControls.throttleAngle - beforeControls.throttleAngle) > 0.01,
      'Changing throttle from full to 0.18 did not move the cockpit throttle.', e);
    verify(motionDelta > 0.0001,
      'Deterministic manoeuvre input did not produce any cockpit head-rig motion.', e);
    verify(afterControls.mfdUpdates > beforeControls.mfdUpdates,
      'The cockpit MFD cadence did not advance across 45 simulated frames.', e);
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

  await report.check({
    id: 'GAME.hull-failure-retry',
    name: 'Hull breach is a terminal, retryable, record-safe run state',
    criteria: [criterion('M4', 'full', 'Exercises both terminal outcomes at the exact simulation boundary, blocks harness/autopilot and real-keyboard authority after failure, and covers the real restart key, failure UI, and persisted-record invariants.')],
    assertion:
      'Repeated staged drawn-asteroid contacts strictly lower finite hull through the production '
      + 'collision path until the run fails at exactly zero. Positive hull remains flying; same-frame damage that reaches exactly zero transitions once '
      + 'to failed on the next step. Failure freezes elapsed/hull/result, rejects damage, harness '
      + 'override/autopilot authority (including brake false versus true), and the real '
      + 'ArrowUp/ArrowLeft/W/D/E/R/Shift plus Space-code brake Input path; it presents only '
      + 'HULL BREACH / TIME / RETRY and never writes a PB. A real N starts '
      + 'one fresh countdown (hull 1, elapsed 0, null result) that repeated N presses cannot reset. '
      + 'Lethal damage on the known finish frame wins over arrival, and an old GO-dismiss timeout '
      + 'cannot hide a newly restarted countdown.',
  }, async () => {
    const exactFinishFrame = unwrap(playthroughOutcome).simulatedFrames;
    const evidence = await collectHullFailureEvidence(page, options, exactFinishFrame);

    verify(evidence.realCollision.impacts.length > 1
      && evidence.realCollision.impacts.length <= evidence.realCollision.maxImpacts
      && evidence.realCollision.impacts.every((impact) => impact.staged !== null
        && Number.isInteger(impact.staged.rockId)
        && impact.staged.overlap > 0
        && finiteNumber(impact.staged.closingSpeed)
        && impact.staged.closingSpeed > 0)
      && evidence.realCollision.impacts.every((impact) =>
        impact.staged.closingSpeed === evidence.realCollision.impacts[0].staged.closingSpeed),
    'The production-collision loop did not stage bounded drawn-asteroid contacts.', evidence);
    verify(evidence.realCollision.impacts.every((impact) =>
      finiteNumber(impact.beforeHull)
      && finiteNumber(impact.after.hull)
      && impact.after.hull >= 0
      && impact.after.hull < impact.beforeHull),
    'A staged production collision failed to reduce hull strictly, finitely, and without crossing below zero.', evidence);
    verify(evidence.realCollision.impacts.slice(0, -1).every((impact) => impact.after.phase === 'flying')
      && evidence.realCollision.final.phase === 'failed'
      && evidence.realCollision.final.hull === 0
      && evidence.realCollision.finalResult === null,
    'Repeated production collisions did not remain flying until a terminal failed / hull 0 / null-result breach.', evidence);

    verify(evidence.smallPositive.injectedHull > 0,
      'The positive-boundary setup did not leave a positive hull value.', evidence);
    verify(evidence.smallPositive.afterStep.phase === 'flying'
      && evidence.smallPositive.afterStep.hull > 0,
    'A small positive hull value incorrectly ended the run.', evidence);

    verify(evidence.lethal.phaseBeforeResolution === 'flying'
      && evidence.lethal.damageReturns.at(-1) === 0,
    'Same-frame damage did not clamp hull to exactly zero while leaving phase resolution to step().', evidence);
    verify(evidence.lethal.afterResolution.phase === 'failed'
      && evidence.lethal.afterResolution.hull === 0,
    'The step after exact-zero hull did not expose failed / hull 0.', evidence);
    verify(evidence.lethal.phaseMutations.length === 1
      && evidence.lethal.phaseMutations[0] === 'failed'
      && evidence.lethal.ui.rootPhase === 'failed',
    'The failure boundary did not produce exactly one DOM data-phase transition to failed.', evidence);
    verify(evidence.lethal.afterResolutionResult === null,
      'A failed run exposed a successful RunResult.', evidence);

    verify(evidence.lethal.damageAfterFailure === 0,
      'damageHull changed (or misreported) already-zero hull after failure.', evidence);
    verify(evidence.lethal.preFailureInput.pitch === 1
      && evidence.lethal.preFailureInput.yaw === -1
      && evidence.lethal.preFailureInput.roll === 1
      && evidence.lethal.preFailureInput.throttle === 1
      && evidence.lethal.preFailureInput.boost === true,
    'The cockpit regression did not seed a strongly deflected pre-failure Input.command.', evidence);
    verify(evidence.lethal.afterStrong.phase === 'failed'
      && evidence.lethal.afterStrong.hull === evidence.lethal.afterResolution.hull
      && evidence.lethal.afterStrong.elapsed === evidence.lethal.afterResolution.elapsed
      && evidence.lethal.afterStrongResult === evidence.lethal.afterResolutionResult,
    'Elapsed, hull, result, or phase changed while the failure state was being observed.', evidence);
    verify(['pitch', 'yaw', 'roll', 'throttle', 'strafeX', 'strafeY']
      .every((field) => evidence.lethal.afterStrongInput[field] === 0)
      && evidence.lethal.afterStrongInput.boost === false
      && evidence.lethal.afterStrongInput.brake === false,
    'activeInput exposed stale pilot authority instead of the neutral command applied after failure.', evidence);
    verify(['stickPitch', 'stickYaw', 'stickRoll']
      .every((field) => Math.abs(evidence.lethal.afterStrongCockpit[field]) <= 1e-6),
    'The cockpit controls remained visibly deflected by stale pre-failure input.', evidence);
    verify(sameShipSnapshot(
      shipSnapshot(evidence.lethal.afterStrongPose),
      shipSnapshot(evidence.lethal.neutralAfterPose),
    ),
      'Strong harness stick/throttle/strafe/boost with brake false, versus neutral brake true, plus autopilot changed the failed ship trace.', evidence);
    verify(evidence.keyboardInput.keys.join(',') === 'w,d,e,r,Shift,ArrowUp,ArrowLeft'
      && evidence.keyboardInput.brakeCode === 'Space'
      && evidence.keyboardInput.heldFrames === 120
      && evidence.keyboardInput.keyed.phase === 'failed'
      && evidence.keyboardInput.neutral.phase === 'failed'
      && evidence.keyboardInput.keyed.hull === 0
      && evidence.keyboardInput.neutral.hull === 0
      && evidence.keyboardInput.keyedResult === null
      && evidence.keyboardInput.neutralResult === null,
    'The real-keyboard comparison did not hold the declared flight keys and Space brake code across matching failed traces.', evidence);
    verify(sameShipSnapshot(
      shipSnapshot(evidence.keyboardInput.keyedPose),
      shipSnapshot(evidence.keyboardInput.neutralPose),
    ),
    'Real ArrowUp/ArrowLeft/W/D/E/R/Shift plus Space-code brake input changed ship physics after failure.', evidence);

    verify(evidence.lethal.ui.screenOpen === '1'
      && evidence.lethal.ui.bodyState === 'failure',
    'The failure result view is not open with its failure state.', evidence);
    verify(evidence.lethal.ui.buttonActions.length === 1
      && evidence.lethal.ui.buttonActions[0] === 'retry'
      && evidence.lethal.ui.buttonShortcuts[0] === 'n',
    'Failure UI does not expose exactly one retry action with the N shortcut.', evidence);

    verify(evidence.restart.immediate.phase === 'countdown'
      && evidence.restart.immediate.hull === 1
      && evidence.restart.immediate.elapsed === 0
      && evidence.restart.immediateResult === null,
    'A real N did not reset into countdown / hull 1 / elapsed 0 / null result.', evidence);
    verify(evidence.restart.midpointPhase === 'countdown'
      && evidence.restart.afterSpam.phase === 'flying',
    'Repeated real N presses restarted the countdown instead of letting the original one finish.', evidence);

    verify(Number.isInteger(evidence.finishPriority.exactFinishFrame)
      && evidence.finishPriority.exactFinishFrame > 1
      && evidence.finishPriority.before.phase === 'flying'
      && evidence.finishPriority.beforeResult === null,
    'The deterministic finish frame could not be replayed to the immediately preceding flying frame.', evidence);
    verify(evidence.finishPriority.after.phase === 'failed'
      && evidence.finishPriority.after.hull === 0
      && evidence.finishPriority.afterResult === null,
    'A lethal hit on the exact ordinary finish frame lost to successful arrival.', evidence);

    verify(evidence.staleGo.go.phase === 'flying'
      && evidence.staleGo.goUi.screenOpen === '1'
      && evidence.staleGo.goUi.value === 'go',
    'The timer regression setup did not reach the visible GO card.', evidence);
    verify(evidence.staleGo.restartDelayMs >= 0 && evidence.staleGo.restartDelayMs < 700,
      'Failure/retry did not occur while the old 700 ms GO-dismiss timer was still pending.', evidence);
    verify(evidence.staleGo.afterWait.phase === 'countdown'
      && evidence.staleGo.afterWaitUi.screenOpen === '1'
      && evidence.staleGo.afterWaitUi.value === '3',
    'An old run\'s GO-dismiss timer hid the newly restarted countdown.', evidence);

    verify(evidence.bestAfter === evidence.bestBefore,
      'A failed run changed the persisted personal-best payload.', evidence);
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
      'From a cold load the phase is title; semantic view/action/control/setting contracts identify '
      + 'the title, briefing, countdown, and HUD controls; clicking begin reaches the briefing and '
      + 'clicking engage reaches the countdown and then flying.',
  }, async () => {
    await reloadHarness(page, options.timeoutMs);
    const atLoad = await callHarness(page, 'phase');
    verify(atLoad === 'title', `Cold load should present the title, got "${atLoad}".`, { atLoad });

    const expectedViews = ['title', 'briefing', 'countdown', 'pause', 'settings', 'controls', 'results'];
    const viewContracts = await page.evaluate(() => Array.from(
      document.querySelectorAll('.lv-screen'),
      (view) => view.getAttribute('data-view'),
    ));
    verify(JSON.stringify(viewContracts) === JSON.stringify(expectedViews),
      'Screens do not expose the stable data-view contract.', { viewContracts, expectedViews });

    // A measured mouse click, not locator.click(). Playwright's locator.click() calls
    // DOM.scrollIntoViewIfNeeded, which displaces the overlay stack 4 times in 6 mid-animation —
    // so this check's own captures could photograph a broken layout and mislead the next
    // reviewer, which is the same class of defect as photographing a transition.
    const click = async (view, action) => {
      const selector = `[data-view="${view}"][data-open="1"] [data-action="${action}"]`;
      const button = page.locator(selector).first();
      await button.waitFor({ state: 'visible', timeout: options.timeoutMs });
      const box = await button.boundingBox();
      verify(box, `Could not measure the ${view}/${action} action.`, { view, action, selector });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const scrolled = await page.evaluate(() => document.documentElement.scrollTop
        + document.body.scrollTop + (document.querySelector('.lv-root')?.scrollTop ?? 0));
      verify(scrolled === 0, `Clicking ${view}/${action} scrolled the overlay stack by ${scrolled}px.`, { view, action, scrolled });
    };

    await click('title', 'settings');
    const settingContracts = await page.evaluate(() => Array.from(
      document.querySelectorAll('[data-view="settings"][data-open="1"] [data-setting]'),
      (control) => ({
        setting: control.getAttribute('data-setting'),
        value: control.getAttribute('data-value'),
      }),
    ));
    const expectedSettings = [
      'assistLevel', 'cameraMode', 'mouseSensitivity', 'invertY', 'fov', 'cameraShake',
      'quality', 'renderScale', 'showFps', 'motionBlur', 'filmGrain', 'chromaticAberration',
      'masterVolume', 'musicVolume',
    ];
    verify(JSON.stringify(settingContracts.map((control) => control.setting))
      === JSON.stringify(expectedSettings)
      && settingContracts.every((control) => control.value !== null && control.value !== ''),
    'Settings controls do not expose their stable data-setting and raw data-value contracts.',
    { settingContracts, expectedSettings });
    await click('settings', 'return');

    await click('title', 'controls');
    const controlContracts = await page.evaluate(() => Array.from(
      document.querySelectorAll('[data-view="controls"][data-open="1"] [data-control]'),
      (row) => row.getAttribute('data-control'),
    ));
    const expectedControls = [
      'mouse-steer', 'throttle', 'roll', 'boost', 'brake', 'strafe-horizontal',
      'strafe-vertical', 'keyboard-steer', 'camera-toggle', 'pause', 'restart',
    ];
    verify(JSON.stringify(controlContracts) === JSON.stringify(expectedControls),
      'Controls rows do not expose stable data-control identifiers.', { controlContracts, expectedControls });
    await click('controls', 'return');

    await click('title', 'begin');
    await page.waitForFunction(() => window.__LV?.phase() === 'briefing', null, { timeout: options.timeoutMs });

    // Read only the open primer and preserve each binding/control pair. Searching document.body
    // could pass from the hidden full CONTROLS screen even when the first-run panel omitted a row.
    const primerRows = await page.evaluate(() => Array.from(
      document.querySelectorAll('[data-view="briefing"][data-open="1"] .lv-primer-list [data-control]'),
      (row) => ({
        control: row.getAttribute('data-control'),
        keys: Array.from(row.querySelectorAll('kbd'), (key) => key.textContent?.trim() ?? ''),
      }),
    ));
    const requiredPrimerRows = [
      { control: 'mouse-steer', keys: ['MOUSE'] },
      { control: 'boost', keys: ['SHIFT', 'LMB'] },
      { control: 'brake', keys: ['SPACE', 'RMB'] },
      { control: 'keyboard-steer', keys: ['↑', '↓', '←', '→'] },
      { control: 'camera-toggle', keys: ['C'] },
    ];
    const missingPrimerRows = requiredPrimerRows.filter((required) => !primerRows.some((actual) =>
      actual.control === required.control && required.keys.every((key) => actual.keys.includes(key))));
    verify(missingPrimerRows.length === 0,
      `Briefing omits required semantic control rows: ${missingPrimerRows.map((row) => row.control).join(', ')}.`,
      { primerRows, missingPrimerRows });

    const briefingControls = await page.evaluate(() => Array.from(
      document.querySelectorAll('[data-view="briefing"][data-open="1"] [data-control]'),
      (row) => row.getAttribute('data-control'),
    ));
    const expectedBriefingControls = [
      'mouse-steer', 'throttle', 'roll', 'boost', 'brake', 'keyboard-steer', 'camera-toggle',
    ];
    verify(JSON.stringify(briefingControls) === JSON.stringify(expectedBriefingControls),
      'Briefing control rows are missing data-control identifiers.', { briefingControls });

    // Portrait turns the desktop columns into a scroll stack. The primer is the lesson the
    // player needs before ENGAGE, so it must begin in the initial viewport rather than below the
    // fiction, and the launch action must remain available outside the inner scroller.
    await page.setViewportSize({ width: 375, height: 667 });
    const portraitLayout = await page.evaluate(() => {
      const view = document.querySelector('[data-view="briefing"][data-open="1"]');
      const panel = view?.querySelector('.lv-brief');
      const cols = view?.querySelector('.lv-brief-cols');
      const primer = view?.querySelector('.lv-primer');
      const engage = view?.querySelector('[data-action="engage"]');
      if (!panel || !cols || !primer || !engage) return null;
      const panelBox = panel.getBoundingClientRect();
      const colsBox = cols.getBoundingClientRect();
      const primerBox = primer.getBoundingClientRect();
      const engageBox = engage.getBoundingClientRect();
      return {
        panelInside: panelBox.left >= 0 && panelBox.top >= 0
          && panelBox.right <= innerWidth && panelBox.bottom <= innerHeight,
        primerInitiallyVisible: primerBox.top >= colsBox.top - 1 && primerBox.top < colsBox.bottom,
        engageInside: engageBox.left >= 0 && engageBox.top >= 0
          && engageBox.right <= innerWidth && engageBox.bottom <= innerHeight,
        documentOverflow: document.documentElement.scrollWidth > innerWidth
          || document.documentElement.scrollHeight > innerHeight,
        cols: { clientHeight: cols.clientHeight, scrollHeight: cols.scrollHeight },
      };
    });
    verify(portraitLayout?.panelInside && portraitLayout.primerInitiallyVisible
      && portraitLayout.engageInside && !portraitLayout.documentOverflow,
    'Portrait briefing hides the control primer or ENGAGE action outside the initial viewport.',
    { portraitLayout });
    await page.setViewportSize(options.viewport);

    await click('briefing', 'engage');
    await page.waitForFunction(() => ['countdown', 'flying'].includes(window.__LV?.phase()), null, { timeout: options.timeoutMs });
    await page.waitForFunction(() => window.__LV?.phase() === 'flying', null, { timeout: options.timeoutMs });
    await page.waitForTimeout(800);
    const closedCountdown = await countdownUiSnapshot(page);
    verify(closedCountdown.screenOpen === '0' && closedCountdown.value === null,
      'Closing the countdown did not clear its data-countdown-value contract.', closedCountdown);

    return {
      atLoad,
      reachedBriefing: true,
      primerRows,
      portraitLayout,
      closedCountdown,
      reachedFlying: true,
    };
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
    /* Freeze rAF before the first quality sample. Resetting each run resets asteroid motion, but
       without driven mode real frames can still slip between startRun() and step(); low was once
       sampled at 0.082233 s while the other profiles were sampled at 0.033333 s. */
    await callHarness(page, 'setDriven', [true]);
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
      + 'declared small bound, player response never exceeds two metres, and the full real run '
      + 'keeps moving-rock surfaces outside every protected spawn/gate volume.',
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
    verify(playerRunMotion.minProtectedVolumeClearance > 0,
      'A moving hazard entered the protected spawn bubble or a gate aperture during the real run.', evidence);
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
      + 'never sits pinned just above empty while the key is down; the HUD states the full usable '
      + 'drive time, places one-second marks at the corresponding reserve levels, and visibly '
      + 'marks the depleted latch as unavailable until its re-arm threshold.',
  }, async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'step', [240, 1 / 60]);
    const hudScale = await page.evaluate(() => {
      const row = document.querySelector('.lv-bar--boost');
      const ticks = [...(row?.querySelectorAll('.lv-bar-tick') ?? [])];
      return {
        usableSeconds: row?.getAttribute('data-usable-seconds') ?? null,
        rearmPercent: row?.getAttribute('data-rearm-percent') ?? null,
        availability: row?.getAttribute('data-availability') ?? null,
        tickPositions: ticks.map((tick) => tick.style.getPropertyValue('--i')),
      };
    });
    await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);

    const samples = [];
    let lockedHud = null;
    for (let i = 0; i < 120; i += 1) {
      await callHarness(page, 'step', [12, 1 / 60]);
      const telemetry = await callHarness(page, 'telemetry');
      samples.push({
        energy: telemetry.energy,
        boosting: telemetry.boosting,
        boostLocked: telemetry.boostLocked,
      });
      if (telemetry.boostLocked && lockedHud === null) {
        lockedHud = await page.evaluate(() => {
          const row = document.querySelector('.lv-bar--boost');
          return {
            availability: row?.getAttribute('data-availability') ?? null,
            usableSeconds: row?.getAttribute('data-usable-seconds') ?? null,
            rearmPercent: row?.getAttribute('data-rearm-percent') ?? null,
          };
        });
      }
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
      hudScale,
      lockedHud,
    };
    verify(bursts.length > 0, 'Boost never engaged while the key was held.', evidence);
    verify(bursts.length <= 8, `Boost re-ignited ${bursts.length} times in 24 s; the latch is stuttering.`, evidence);
    verify(bursts.every((d) => d >= 0.6), `Shortest boost burst was ${evidence.shortest} s; bursts under 0.6 s read as a fault.`, evidence);
    verify(evidence.firstBurst >= 3, `A full reserve lasted only ${evidence.firstBurst} s; the longer burst is absent.`, evidence);
    verify(gaps.length > 0 && Math.min(...gaps) <= 2.6,
      `Fast recovery was not observed; gaps were ${gaps.join(', ')} s.`, evidence);
    const usableSeconds = Number(hudScale.usableSeconds);
    verify(Math.abs(usableSeconds - 3.1724137931034484) <= 1e-12
      && hudScale.rearmPercent === '45' && hudScale.availability === 'available',
    'The boost HUD does not expose its initial raw numeric and availability contracts.', evidence);
    verify(JSON.stringify(hudScale.tickPositions) === JSON.stringify(['0.3700', '0.6600', '0.9500']),
      'The boost HUD one-second marks do not match the latch floor plus drain rate.', evidence);
    verify(lockedHud?.availability === 'unavailable'
      && Math.abs(Number(lockedHud.usableSeconds) - usableSeconds) <= 1e-12
      && lockedHud.rearmPercent === '45',
    'The boost HUD does not expose a depleted, latched reserve through its raw state contracts.', evidence);
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
  /* Take rAF out of the equation before the run starts. Otherwise frames can slip between the
     separate startRun/setAutopilot calls, making a quoted finish frame process-speed dependent. */
  await callHarness(page, 'setDriven', [true]);
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
      if (finalPhase === 'failed') {
        throw new Error(`Autopilot suffered a hull breach after ${simulatedFrames} frames.`);
      }
      /* Once the final gate is clear, finish one frame at a time. The resulting exact frame is
         reusable by the failure-priority check without adding a seek-to-terminus test hook. */
      const allGatesCleared = Number.isInteger(telemetry?.gate?.total)
        && telemetry.gate.index >= telemetry.gate.total;
      const frames = Math.min(allGatesCleared ? 1 : chunkFrames, maxFrames - simulatedFrames);
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

async function collectHullFailureEvidence(page, options, exactFinishFrame) {
  verify(page, 'Browser page is unavailable.');
  verify(Number.isInteger(exactFinishFrame) && exactFinishFrame > 1,
    'The completed playthrough did not publish a reusable exact finish frame.', { exactFinishFrame });

  const neutral = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    strafeX: 0,
    strafeY: 0,
    boost: false,
    brake: true,
  };
  const strong = {
    pitch: 1,
    yaw: -1,
    roll: 1,
    throttle: 1,
    strafeX: 1,
    strafeY: -1,
    boost: true,
    brake: false,
  };
  const damageSequence = [0.3, 0.3, 0.4, 0.5];
  const readBest = () => page.evaluate(() => localStorage.getItem('last-vector.best.v1'));
  const prepareFlying = async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [neutral]);
    await callHarness(page, 'step', [6, 1 / 60], options.timeoutMs);
  };
  const injectLethalSequence = async () => {
    const values = [];
    for (const amount of damageSequence) {
      values.push(await callHarness(page, 'damageHull', [amount]));
    }
    return values;
  };

  await reloadHarness(page, options.timeoutMs);
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  const bestBefore = await readBest();

  try {
    /* First prove the complete playable path. stageCollision only arranges each contact; every
       single step must traverse moving hazards, collision resolution and Ship.applyImpact. A
       bounded loop forces the real damage path to reach the same failure state as the direct
       boundary injector, and kills implementations that clamp damage at a positive floor. */
    await prepareFlying();
    const maxImpacts = 12;
    const collisionImpacts = [];
    for (let index = 0; index < maxImpacts; index += 1) {
      const before = compactTelemetry(await callHarness(page, 'telemetry'));
      if (before.phase !== 'flying') break;
      const staged = await callHarness(page, 'stageCollision');
      await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
      collisionImpacts.push({
        index,
        staged,
        beforeHull: before.hull,
        after: compactTelemetry(await callHarness(page, 'telemetry')),
        result: await callHarness(page, 'result'),
      });
    }
    const realCollision = {
      maxImpacts,
      impacts: collisionImpacts,
      simulatedFrames: collisionImpacts.length,
      final: compactTelemetry(await callHarness(page, 'telemetry')),
      finalResult: await callHarness(page, 'result'),
    };

    /* Boundary below zero: damage is immediate, terminal resolution belongs to the next step. */
    await prepareFlying();
    const injectedHull = await callHarness(page, 'damageHull', [0.999]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const smallPositive = {
      injectedHull,
      afterStep: compactTelemetry(await callHarness(page, 'telemetry')),
    };

    /* Observe the public DOM phase attribute, not a private transition counter. Four injections
       happen without an intervening frame and the final two both see the clamped zero boundary. */
    await prepareFlying();
    // Seed Input.command with a visibly deflected live-flight sample before the terminal step.
    // Failed physics bypasses Input.update(), so this is the stale value the cockpit must reject.
    await callHarness(page, 'setInput', [strong]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const preFailureInput = await callHarness(page, 'activeInput');
    await page.evaluate(() => {
      const root = document.querySelector('.lv-root');
      if (!root) throw new Error('Missing .lv-root for phase transition observation.');
      const values = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') values.push(root.getAttribute('data-phase'));
        }
      });
      observer.observe(root, { attributes: true, attributeFilter: ['data-phase'] });
      window.__lvFailurePhaseTrace = { observer, values };
    });
    const damageReturns = await injectLethalSequence();
    const phaseBeforeResolution = await callHarness(page, 'phase');
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const phaseMutations = await page.evaluate(async () => {
      await Promise.resolve();
      const trace = window.__lvFailurePhaseTrace;
      trace?.observer.disconnect();
      const values = trace?.values.slice() ?? [];
      delete window.__lvFailurePhaseTrace;
      return values;
    });
    const afterResolution = compactTelemetry(await callHarness(page, 'telemetry'));
    const afterResolutionResult = await callHarness(page, 'result');
    const ui = await failureUiSnapshot(page);

    await callHarness(page, 'setSettings', [{ cameraMode: 'cockpit' }]);
    await callHarness(page, 'setInput', [strong]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    const damageAfterFailure = await callHarness(page, 'damageHull', [1]);
    await callHarness(page, 'step', [120, 1 / 60], options.timeoutMs);
    const afterStrong = compactTelemetry(await callHarness(page, 'telemetry'));
    const afterStrongResult = await callHarness(page, 'result');
    const afterStrongInput = await callHarness(page, 'activeInput');
    const afterStrongPose = await callHarness(page, 'pose');
    const afterStrongCockpit = await callHarness(page, 'cockpitDebug');
    await callHarness(page, 'setSettings', [{ cameraMode: 'chase' }]);

    /* Replay the same failure trace with neutral input. Equality of the physical ship snapshot is
       stronger than reading activeInput: it proves neither the override nor autopilot gained
       authority while preserving the intended inertial drift. This independently covers the
       brake axis too: `strong` commands brake false while `neutral` commands brake true. */
    await prepareFlying();
    await callHarness(page, 'setInput', [strong]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await injectLethalSequence();
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'setInput', [neutral]);
    await callHarness(page, 'step', [120, 1 / 60], options.timeoutMs);
    const neutralAfterPose = await callHarness(page, 'pose');

    /* Repeat the same terminal trace through Input's real keyboard route. The earlier comparison
       proves override/autopilot cannot steer a failed ship, but would stay green if an
       implementation neutralised only those automation paths and still called resolveCommand()
       for a human. Keep all keys physically down across the simulated window, then release every
       one in finally so a failed assertion cannot contaminate the later real KeyN retry. */
    const keyboardKeys = ['w', 'd', 'e', 'r', 'Shift', 'ArrowUp', 'ArrowLeft'];
    await prepareFlying();
    await injectLethalSequence();
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setAutopilot', [false]);
    const heldKeys = [];
    let brakeHeld = false;
    let keyedPose;
    let keyedTelemetry;
    let keyedResult;
    try {
      for (const key of keyboardKeys) {
        await page.keyboard.down(key);
        heldKeys.push(key);
      }
      /* A normal Space on the failure dialog activates RETRY before Input can be observed. Keep
         the UI-facing key unidentified while sending the production `code: Space` that
         Input.handleKeyDown uses for brake. */
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Unidentified',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }));
      });
      brakeHeld = true;
      await callHarness(page, 'step', [120, 1 / 60], options.timeoutMs);
      keyedPose = await callHarness(page, 'pose');
      keyedTelemetry = compactTelemetry(await callHarness(page, 'telemetry'));
      keyedResult = await callHarness(page, 'result');
    } finally {
      const releaseErrors = [];
      if (brakeHeld) {
        try {
          await page.evaluate(() => {
            window.dispatchEvent(new KeyboardEvent('keyup', {
              key: 'Unidentified',
              code: 'Space',
              bubbles: true,
              cancelable: true,
            }));
          });
        } catch (error) {
          releaseErrors.push(`Space: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const key of heldKeys.reverse()) {
        try {
          await page.keyboard.up(key);
        } catch (error) {
          releaseErrors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (releaseErrors.length > 0) {
        throw new Error(`Could not release failure-input keys: ${releaseErrors.join('; ')}`);
      }
    }

    await prepareFlying();
    await injectLethalSequence();
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'step', [120, 1 / 60], options.timeoutMs);
    const keyboardNeutralPose = await callHarness(page, 'pose');
    const keyboardNeutralTelemetry = compactTelemetry(await callHarness(page, 'telemetry'));
    const keyboardNeutralResult = await callHarness(page, 'result');
    const keyboardInput = {
      keys: keyboardKeys,
      brakeCode: 'Space',
      heldFrames: 120,
      keyedPose,
      keyed: keyedTelemetry,
      keyedResult,
      neutralPose: keyboardNeutralPose,
      neutral: keyboardNeutralTelemetry,
      neutralResult: keyboardNeutralResult,
    };

    /* Use the shipped KeyN route. Sample one frame so telemetry reflects Ship.reset(), then place
       the repeated presses halfway through the three-second countdown. If any press restarts it,
       the final 92 frames are insufficient to reach flight. */
    await page.keyboard.press('n');
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const immediate = compactTelemetry(await callHarness(page, 'telemetry'));
    const immediateResult = await callHarness(page, 'result');
    await callHarness(page, 'step', [89, 1 / 60], options.timeoutMs);
    const midpointPhase = await callHarness(page, 'phase');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('n');
    await callHarness(page, 'step', [92, 1 / 60], options.timeoutMs);
    const afterSpam = compactTelemetry(await callHarness(page, 'telemetry'));

    /* Re-run the exact deterministic trace to one frame before its known successful finish, then
       inject lethal damage into that final frame. Failure resolution runs before course arrival. */
    await callHarness(page, 'setDriven', [false]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setInput', [null]);
    await callHarness(page, 'setAutopilot', [true, { skill: 1 }]);
    await stepHarnessFrames(page, exactFinishFrame - 1, options.timeoutMs);
    const finishBefore = compactTelemetry(await callHarness(page, 'telemetry'));
    const finishBeforeResult = await callHarness(page, 'result');
    await callHarness(page, 'damageHull', [1]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const finishAfter = compactTelemetry(await callHarness(page, 'telemetry'));
    const finishAfterResult = await callHarness(page, 'result');

    /* Reproduce the cross-run timer boundary: enter GO from a real countdown, fail before its
       700 ms dismissal fires, restart through KeyN, then wait beyond the old deadline with driven
       simulation held. The new countdown must remain visibly open at 3. */
    await callHarness(page, 'setDriven', [false]);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: false }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [neutral]);
    let goFrames = 0;
    while ((await callHarness(page, 'phase')) === 'countdown' && goFrames < 240) {
      await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
      goFrames += 1;
    }
    const go = compactTelemetry(await callHarness(page, 'telemetry'));
    const goUi = await countdownUiSnapshot(page);
    const goAt = await page.evaluate(() => performance.now());
    await callHarness(page, 'damageHull', [1]);
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    await page.keyboard.press('n');
    await callHarness(page, 'step', [1, 1 / 60], options.timeoutMs);
    const restartedAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(800);
    const afterWait = compactTelemetry(await callHarness(page, 'telemetry'));
    const afterWaitUi = await countdownUiSnapshot(page);

    const bestAfter = await readBest();
    return {
      bestBefore,
      bestAfter,
      realCollision,
      smallPositive,
      lethal: {
        damageSequence,
        preFailureInput,
        damageReturns,
        phaseBeforeResolution,
        phaseMutations,
        afterResolution,
        afterResolutionResult,
        ui,
        damageAfterFailure,
        afterStrong,
        afterStrongResult,
        afterStrongInput,
        afterStrongPose,
        afterStrongCockpit,
        neutralAfterPose,
      },
      keyboardInput,
      restart: { immediate, immediateResult, midpointPhase, afterSpam, spammedN: 4 },
      finishPriority: {
        exactFinishFrame,
        before: finishBefore,
        beforeResult: finishBeforeResult,
        after: finishAfter,
        afterResult: finishAfterResult,
      },
      staleGo: {
        goFrames,
        go,
        goUi,
        restartDelayMs: restartedAt - goAt,
        waitedMs: 800,
        afterWait,
        afterWaitUi,
      },
    };
  } finally {
    await page.evaluate(() => {
      window.__lvFailurePhaseTrace?.observer.disconnect();
      delete window.__lvFailurePhaseTrace;
    }).catch(() => {});
    await bestEffort(page, 'setInput', [null]);
    await bestEffort(page, 'setAutopilot', [false]);
    await bestEffort(page, 'setDriven', [false]);
  }
}

async function stepHarnessFrames(page, totalFrames, timeoutMs) {
  let remaining = totalFrames;
  while (remaining > 0) {
    const frames = Math.min(120, remaining);
    await callHarness(page, 'step', [frames, 1 / 60], timeoutMs);
    remaining -= frames;
    const phase = await callHarness(page, 'phase');
    if (phase === 'failed' || phase === 'finished') {
      throw new Error(`Run reached terminal phase "${phase}" with ${remaining} requested frames remaining.`);
    }
  }
}

async function failureUiSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.lv-root');
    const screen = document.querySelector('.lv-screen--results');
    const body = screen?.querySelector('.lv-res-body');
    const buttons = body ? [...body.querySelectorAll('button')] : [];
    return {
      rootPhase: root?.getAttribute('data-phase') ?? null,
      screenOpen: screen?.getAttribute('data-open') ?? null,
      bodyState: body?.getAttribute('data-state') ?? null,
      buttonActions: buttons.map((button) => button.getAttribute('data-action')),
      buttonShortcuts: buttons.map((button) => button.getAttribute('aria-keyshortcuts')),
    };
  });
}

async function countdownUiSnapshot(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('.lv-screen--countdown');
    return {
      screenOpen: screen?.getAttribute('data-open') ?? null,
      value: screen?.getAttribute('data-countdown-value') ?? null,
    };
  });
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

/**
 * Real-key coverage for the boundary a chord can straddle. A Set of held key codes is only a
 * faithful physical-state model while lifecycle resets and focus loss do not clear it between
 * the two keydowns, so each arm deliberately puts one of those boundaries in the middle.
 */
async function collectChordOrderEvidence(page, options) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'setDriven', [true]);

  const prepare = async () => {
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [null]);
    await stepUntilFlying(page, options.timeoutMs);
  };
  const readAfter = async (frames = 2) => {
    await callHarness(page, 'step', [frames], options.timeoutMs);
    return callHarness(page, 'activeInput');
  };
  const release = async (...keys) => {
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      try { await page.keyboard.up(keys[i]); } catch { /* best-effort cleanup */ }
    }
    await callHarness(page, 'step', [2], options.timeoutMs);
  };
  const dispatch = (type, init) => page.evaluate(({ eventType, eventInit }) => {
    window.dispatchEvent(new KeyboardEvent(eventType, {
      bubbles: true,
      cancelable: true,
      ...eventInit,
    }));
  }, { eventType: type, eventInit: init });
  const blurAndFocus = () => page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });

  const uninterrupted = async (first, second) => {
    await prepare();
    try {
      await page.keyboard.down(first);
      const firstOnly = await readAfter();
      await page.keyboard.down(second);
      const together = await readAfter(10);
      return { first, second, firstOnly, together };
    } finally {
      await release(first, second);
    }
  };

  const acrossReset = async (first, second) => {
    await prepare();
    try {
      await page.keyboard.down(first);
      const beforeReset = await readAfter();
      await callHarness(page, 'startRun', [{ skipIntro: true }]);
      await callHarness(page, 'setAutopilot', [false]);
      await callHarness(page, 'setInput', [null]);
      await page.keyboard.down(second);
      const afterSecond = await readAfter(first === 'w' ? 2 : 10);
      let afterRepeat1 = null;
      let afterRepeat2 = null;
      let afterRelease = null;
      let recovered = afterSecond;
      if (first === 'w') {
        // A repeat proves W is still the SAME physical press that crossed reset, not a fresh
        // command. It stays quarantined through multiple frames; only keyup re-arms the next
        // non-repeat keydown. page.keyboard.down() is repeated here without an intervening up(),
        // so Chromium emits a real KeyW keydown with repeat=true.
        await page.keyboard.down('w');
        afterRepeat1 = await readAfter();
        afterRepeat2 = await readAfter(8);
        await page.keyboard.up('w');
        afterRelease = await readAfter();
        await page.keyboard.down('w');
        recovered = await readAfter(10);
      }
      return {
        first,
        second,
        beforeReset,
        afterSecond,
        afterRepeat1,
        afterRepeat2,
        afterRelease,
        recovered,
      };
    } finally {
      await release(first, second);
    }
  };

  const uninterruptedWThenShift = await uninterrupted('w', 'Shift');
  const uninterruptedShiftThenW = await uninterrupted('Shift', 'w');
  const resetShiftThenW = await acrossReset('Shift', 'w');
  const resetWThenShift = await acrossReset('w', 'Shift');

  await prepare();
  let rightShift;
  try {
    await dispatch('keydown', { key: 'Shift', code: 'ShiftRight', shiftKey: true });
    await dispatch('keydown', { key: 'W', code: 'KeyW', shiftKey: true });
    rightShift = await readAfter(10);
  } finally {
    await dispatch('keyup', { key: 'W', code: 'KeyW', shiftKey: true });
    await dispatch('keyup', { key: 'Shift', code: 'ShiftRight', shiftKey: false });
    await callHarness(page, 'step', [2], options.timeoutMs);
  }

  await prepare();
  let dualShift;
  try {
    await dispatch('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    await dispatch('keydown', { key: 'Shift', code: 'ShiftRight', shiftKey: true });
    // This exact false snapshot is emitted by headless Chromium when one of two Shift keys is
    // released; the remaining code is the only evidence that ShiftRight is still physically down.
    await dispatch('keyup', { key: 'Shift', code: 'ShiftLeft', shiftKey: false });
    await dispatch('keydown', { key: 'w', code: 'KeyW', shiftKey: false });
    const afterLeftRelease = await readAfter(10);
    dualShift = { afterLeftRelease };
  } finally {
    await dispatch('keyup', { key: 'w', code: 'KeyW', shiftKey: false });
    await dispatch('keyup', { key: 'Shift', code: 'ShiftRight', shiftKey: false });
    await callHarness(page, 'step', [2], options.timeoutMs);
  }

  await prepare();
  let blurShiftThenW;
  try {
    await page.keyboard.down('Shift');
    const beforeBlur = await readAfter();
    await blurAndFocus();
    const cleared = await readAfter();
    // Playwright retains its physical Shift modifier, so this trusted W keydown carries
    // shiftKey=true even though the page's held-code cache was safely cleared by blur.
    await page.keyboard.down('w');
    const recovered = await readAfter(10);
    blurShiftThenW = { beforeBlur, cleared, recovered };
  } finally {
    await release('Shift', 'w');
  }

  await prepare();
  let blurWThenShift;
  try {
    await page.keyboard.down('w');
    const beforeBlur = await readAfter();
    await blurAndFocus();
    const cleared1 = await readAfter();
    const cleared2 = await readAfter(8);
    await page.keyboard.down('Shift');
    const afterShift = await readAfter();
    // The next W event is a real repeat of the press that crossed blur, so it must remain
    // quarantined. A release is the only proof that the following keydown is a new command.
    await page.keyboard.down('w');
    const afterRepeat1 = await readAfter();
    const afterRepeat2 = await readAfter(8);
    await page.keyboard.up('w');
    const afterRelease = await readAfter();
    await page.keyboard.down('w');
    const recovered = await readAfter(10);
    blurWThenShift = {
      beforeBlur,
      cleared1,
      cleared2,
      afterShift,
      afterRepeat1,
      afterRepeat2,
      afterRelease,
      recovered,
    };
  } finally {
    await release('w', 'Shift');
  }

  await prepare();
  const repeatedView = {};
  for (const [name, key, code] of [
    ['keyC', 'c', 'KeyC'],
    ['keyV', 'v', 'KeyV'],
  ]) {
    const before = await callHarness(page, 'cameraMode');
    await dispatch('keydown', { key, code, repeat: true });
    await readAfter();
    const after = await callHarness(page, 'cameraMode');
    await dispatch('keyup', { key, code });
    repeatedView[name] = { before, after };
  }

  const platformModifiedC = {};
  for (const [name, flag] of [
    ['meta', 'metaKey'],
    ['ctrl', 'ctrlKey'],
    ['alt', 'altKey'],
  ]) {
    const before = await callHarness(page, 'cameraMode');
    await dispatch('keydown', { key: 'c', code: 'KeyC', [flag]: true });
    await readAfter();
    const after = await callHarness(page, 'cameraMode');
    await dispatch('keyup', { key: 'c', code: 'KeyC', [flag]: true });
    platformModifiedC[name] = { before, after };
  }
  repeatedView.platformModifiedC = platformModifiedC;

  const shiftCBefore = await callHarness(page, 'cameraMode');
  let shiftCInput;
  let shiftCAfter;
  try {
    await dispatch('keydown', {
      key: 'Shift', code: 'ShiftLeft', shiftKey: true,
    });
    await dispatch('keydown', {
      key: 'c', code: 'KeyC', shiftKey: true,
    });
    shiftCInput = await readAfter();
    shiftCAfter = await callHarness(page, 'cameraMode');
  } finally {
    await dispatch('keyup', {
      key: 'c', code: 'KeyC', shiftKey: true,
    });
    await dispatch('keyup', {
      key: 'Shift', code: 'ShiftLeft', shiftKey: false,
    });
    await callHarness(page, 'step', [2], options.timeoutMs);
  }
  repeatedView.shiftC = {
    before: shiftCBefore,
    after: shiftCAfter,
    input: shiftCInput,
  };

  /* The reset and blur arms above prove that no key press crossing a safety boundary can be
     reconstructed from repeat alone. This is the UI origin of the same contract: W itself selected
     BEGIN RUN in the title. Its repeats must remain quarantined after ENGAGE until the browser
     reports a release, or a player who holds the navigation key through the two Enter presses
     starts accelerating during the countdown. S first proves W really moved focus back to BEGIN
     RUN instead of merely being held while the already-selected default button was activated. */
  await reloadHarness(page, options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'setDriven', [true]);
  await callHarness(page, 'setInput', [null]);

  const focusedButtonAction = () => page.evaluate(() =>
    document.activeElement?.getAttribute('data-action') ?? null);
  const observeNextRealKeyDown = async (key, code) => {
    await page.evaluate((wantedCode) => {
      window.__lvChordRepeatProbe = null;
      const observe = (event) => {
        if (event.code !== wantedCode) return;
        window.removeEventListener('keydown', observe, true);
        window.__lvChordRepeatProbe = {
          key: event.key,
          code: event.code,
          repeat: event.repeat,
          shiftKey: event.shiftKey,
        };
      };
      window.addEventListener('keydown', observe, true);
    }, code);
    await page.keyboard.down(key);
    return page.evaluate(() => {
      const evidence = window.__lvChordRepeatProbe;
      delete window.__lvChordRepeatProbe;
      return evidence;
    });
  };

  let menuHeldW;
  try {
    const initialPhase = await callHarness(page, 'phase');
    await page.keyboard.press('s');
    const afterSFocus = await focusedButtonAction();
    await page.keyboard.down('w');
    const afterWFocus = await focusedButtonAction();
    await page.keyboard.press('Enter');
    const afterFirstEnter = await callHarness(page, 'phase');
    await page.keyboard.press('Enter');
    const afterSecondEnter = await callHarness(page, 'phase');

    // Playwright emits repeat=true when down() is called again before the matching up().
    const repeatEvent = await observeNextRealKeyDown('w', 'KeyW');
    const afterRepeat = await readAfter(10);
    await page.keyboard.up('w');
    const afterRelease = await readAfter();
    await page.keyboard.down('w');
    const afterFreshDown = await readAfter(4);
    menuHeldW = {
      initialPhase,
      afterSFocus,
      afterWFocus,
      afterFirstEnter,
      afterSecondEnter,
      repeatEvent,
      afterRepeat,
      afterRelease,
      afterFreshDown,
    };
  } finally {
    await release('w', 's', 'Enter');
  }

  return {
    uninterrupted: {
      wThenShift: uninterruptedWThenShift,
      shiftThenW: uninterruptedShiftThenW,
    },
    acrossReset: {
      shiftThenW: resetShiftThenW,
      wThenShift: resetWThenShift,
    },
    rightShift,
    dualShift,
    acrossBlur: {
      shiftThenW: blurShiftThenW,
      wThenShift: blurWThenShift,
    },
    repeatedView,
    menuHeldW,
  };
}

async function collectCameraEvidence(page, options) {
  verify(page, 'Browser page is unavailable.');
  const settleFrames = 240;
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
    await callHarness(page, 'step', [settleFrames, 1 / 60], options.timeoutMs);
  };

  let originalFov = null;
  try {
    await callHarness(page, 'ready', [], options.timeoutMs);
    originalFov = (await callHarness(page, 'settings')).fov;
    await callHarness(page, 'setSettings', [{ cameraMode: 'chase', fov: 76 }]);
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
    await page.keyboard.press('c');
    const immediatelyAfterFirstKey = await callHarness(page, 'pose');
    const afterFirstKey = {
      mode: await callHarness(page, 'cameraMode'),
      settingsMode: (await callHarness(page, 'settings')).cameraMode,
      shipUnchanged: sameShipSnapshot(beforeFirstKey, shipSnapshot(immediatelyAfterFirstKey)),
    };
    await callHarness(page, 'step', [settleFrames, 1 / 60], options.timeoutMs);
    const cockpit = cameraSample(await callHarness(page, 'pose'));
    const cockpitDebug = await callHarness(page, 'cockpitDebug');

    // KeyC must route through SettingsStore, so a cold Game instance must recover cockpit mode.
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
    const persistedCockpitDebug = await callHarness(page, 'cockpitDebug');

    const phaseAtSecondToggle = await callHarness(page, 'phase');
    const beforeSecondKey = shipSnapshot(persistedPose);
    await page.keyboard.press('c');
    const immediatelyAfterSecondKey = await callHarness(page, 'pose');
    const afterSecondKey = {
      mode: await callHarness(page, 'cameraMode'),
      settingsMode: (await callHarness(page, 'settings')).cameraMode,
      shipUnchanged: sameShipSnapshot(beforeSecondKey, shipSnapshot(immediatelyAfterSecondKey)),
    };
    await callHarness(page, 'step', [settleFrames, 1 / 60], options.timeoutMs);
    const restored = cameraSample(await callHarness(page, 'pose'));

    // Keep the old binding as a deliberately narrow compatibility contract. KeyC owns all camera
    // geometry, persistence and FOV assertions; this one active-flight KeyV only proves the alias
    // still reaches the same stored mode without touching ship state.
    const legacyPose = await callHarness(page, 'pose');
    await page.keyboard.press('v');
    const legacyKeyV = {
      phase: await callHarness(page, 'phase'),
      mode: await callHarness(page, 'cameraMode'),
      settingsMode: (await callHarness(page, 'settings')).cameraMode,
      shipUnchanged: sameShipSnapshot(
        shipSnapshot(legacyPose),
        shipSnapshot(await callHarness(page, 'pose')),
      ),
    };

    // Compare both modes from cold Game instances at the widest supported setting. Reloading
    // before each trace gives the FOV damper, boost blend, damage flash, and world clock identical
    // origins; KeyC remains the route into cockpit and its SettingsStore persistence is what makes
    // the second cold instance boot in that mode.
    await callHarness(page, 'setSettings', [{ cameraMode: 'chase', fov: 100 }]);
    await reloadHarness(page, options.timeoutMs);
    await prepareFlight();
    await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
    await callHarness(page, 'step', [150, 1 / 60], options.timeoutMs);
    const boostedChasePose = await callHarness(page, 'pose');
    const boostedChase = {
      ...cameraSample(boostedChasePose),
      mode: await callHarness(page, 'cameraMode'),
    };
    await page.keyboard.press('c');
    await reloadHarness(page, options.timeoutMs);
    await prepareFlight();
    await callHarness(page, 'setInput', [{ throttle: 1, boost: true }]);
    await callHarness(page, 'step', [150, 1 / 60], options.timeoutMs);
    const boostedCockpitPose = await callHarness(page, 'pose');
    const boostedCockpit = {
      ...cameraSample(boostedCockpitPose),
      mode: await callHarness(page, 'cameraMode'),
      shipMatchesChaseTrace: sameShipSnapshot(
        shipSnapshot(boostedChasePose),
        shipSnapshot(boostedCockpitPose),
      ),
    };
    const boostedCockpitDebug = await callHarness(page, 'cockpitDebug');

    // The model must consume the live command/state feed, not merely expose a static frame that
    // happens to sit at the right camera pose. Move every rotational control and the throttle far
    // enough to clear the cockpit's own smoothing, then sample the physical controls and MFD clock.
    await callHarness(page, 'setInput', [{
      throttle: 0.18,
      pitch: 0.7,
      yaw: -0.55,
      roll: 0.8,
      boost: false,
      brake: true,
    }]);
    await callHarness(page, 'step', [45, 1 / 60], options.timeoutMs);
    const commandedCockpitDebug = await callHarness(page, 'cockpitDebug');

    // Exercise the lower SettingsStore FOV endpoint as a real camera state. The upper endpoint is
    // the base-100 boosted trace above; physical cockpit scale must remain one at both lenses.
    await callHarness(page, 'setSettings', [{ fov: 60 }]);
    await callHarness(page, 'setInput', [{ throttle: 0, brake: true }]);
    await callHarness(page, 'step', [settleFrames, 1 / 60], options.timeoutMs);
    const minimumFovCockpit = cameraSample(await callHarness(page, 'pose'));
    const minimumFovCockpitDebug = await callHarness(page, 'cockpitDebug');

    return {
      phaseAtFirstToggle,
      phaseAtSecondToggle,
      initial,
      afterFirstKey,
      cockpit,
      cockpitDebug,
      persisted,
      persistedCockpitDebug,
      afterSecondKey,
      restored,
      legacyKeyV,
      boostedChase,
      boostedCockpit,
      boostedCockpitDebug,
      commandedCockpitDebug,
      minimumFovCockpit,
      minimumFovCockpitDebug,
    };
  } finally {
    await bestEffort(page, 'setSettings', [{
      cameraMode: 'chase',
      ...(finiteNumber(originalFov) ? { fov: originalFov } : {}),
    }]);
    await bestEffort(page, 'setInput', [null]);
    await bestEffort(page, 'setDriven', [false]);
  }
}

async function stepUntilFlying(page, timeoutMs) {
  let simulatedFrames = 0;
  while (simulatedFrames <= 600) {
    const phase = await callHarness(page, 'phase');
    if (phase === 'flying') return;
    if (phase === 'failed' || phase === 'finished') {
      throw new Error(`Run reached terminal phase "${phase}" before the input probe reached flying.`);
    }
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
    hull: telemetry.hull,
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
    && finiteNumber(pose.camera?.near) && pose.camera.near > 0
    && finiteNumber(pose.camera?.fov) && pose.camera.fov > 0;
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
    fov: pose.camera.fov,
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
