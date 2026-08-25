import {
  callHarness,
  runManagedSuite,
  verify,
  waitForHarness,
} from './runtime.mjs';

const REQUIRED_METHODS = [
  'ready',
  'startRun',
  'setDriven',
  'setFixedTimestep',
  'setAutopilot',
  'setInput',
  'activeInput',
  'step',
  'phase',
  'pauseMenu',
  'installProgress',
  'routeUrl',
  'errors',
];

await runManagedSuite({
  suite: 'dead-signal-input',
  argv: process.argv.slice(2),
  requiredMethods: REQUIRED_METHODS,
  execute: runInputProof,
});

async function runInputProof({ report, session, options }) {
  const page = session.page;
  const step = async (frames = 2) => callHarness(page, 'step', [frames, 1 / 60]);
  const setLock = async (on) => {
    await page.evaluate((locked) => {
      const canvas = document.querySelector('canvas');
      window.__deadSignalMockLock = locked;
      Object.defineProperty(document, 'pointerLockElement', {
        get: () => (window.__deadSignalMockLock ? canvas : null),
        configurable: true,
      });
      document.dispatchEvent(new Event('pointerlockchange'));
    }, on);
  };
  const mouse = async (type, button) => {
    await page.evaluate(({ eventType, eventButton }) => {
      document.dispatchEvent(new MouseEvent(eventType, { button: eventButton, bubbles: true }));
    }, { eventType: type, eventButton: button });
  };
  const key = async (type, code, init = {}) => {
    await page.evaluate(({ eventType, eventCode, eventInit }) => {
      window.dispatchEvent(new KeyboardEvent(eventType, {
        code: eventCode,
        key: eventCode,
        bubbles: true,
        ...eventInit,
      }));
    }, { eventType: type, eventCode: code, eventInit: init });
  };

  await report.check({
    id: 'INPUT.cairn-lmb-noop',
    name: 'LMB has no flight action without the fire capability',
    assertion: 'On CAIRN, a pointer-locked LMB neither fires nor boosts; Shift remains sole boost.',
  }, async () => {
    await callHarness(page, 'ready', [], options.timeoutMs);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [null]);
    await setLock(true);
    await mouse('mousedown', 0);
    await step();
    const lmb = await callHarness(page, 'activeInput');
    await key('keydown', 'ShiftLeft', { shiftKey: true });
    await step();
    const shift = await callHarness(page, 'activeInput');
    await key('keyup', 'ShiftLeft', { shiftKey: false });
    await mouse('mouseup', 0);
    verify(lmb.fire === false && lmb.boost === false,
      'CAIRN accepted an inactive LMB action.', { lmb, shift });
    verify(shift.fire === false && shift.boost === true,
      'Shift did not remain the sole CAIRN boost binding.', { lmb, shift });
    return { lmb, shift };
  });

  await report.check({
    id: 'INPUT.dead-signal-independent-chord',
    name: 'DEAD SIGNAL LMB fire and Shift boost form an independent chord',
    assertion:
      'LMB fires without boost; Shift+LMB does both; releasing either leaves the other command held.',
  }, async () => {
    await callHarness(page, 'installProgress', [{
      version: 2,
      selectedMission: 'dead-signal',
      missions: {
        'cairn-drift': {
          cleared: true,
          clearedAt: 1,
          highestRank: 'A',
          cleanClear: true,
          mastery: {},
        },
      },
      dormantCourses: {},
    }]);
    const route = new URL(await callHarness(page, 'routeUrl', ['dead-signal']));
    route.searchParams.set('seed', String(options.seed));
    const response = await page.goto(route.href, { waitUntil: 'load', timeout: options.timeoutMs });
    verify(response?.ok(), 'DEAD SIGNAL canonical route did not reload successfully.', {
      status: response?.status(),
      route: route.href,
    });
    await waitForHarness(page, options.timeoutMs);
    await callHarness(page, 'ready', [], options.timeoutMs);
    await callHarness(page, 'setDriven', [true]);
    await callHarness(page, 'setFixedTimestep', [1 / 60]);
    await callHarness(page, 'startRun', [{ skipIntro: true }]);
    await callHarness(page, 'setAutopilot', [false]);
    await callHarness(page, 'setInput', [null]);
    await setLock(true);

    await mouse('mousedown', 0);
    await step();
    const fireOnly = await callHarness(page, 'activeInput');
    await key('keydown', 'ShiftLeft', { shiftKey: true });
    await step();
    const chord = await callHarness(page, 'activeInput');
    await mouse('mouseup', 0);
    await step();
    const boostAfterFireRelease = await callHarness(page, 'activeInput');
    await mouse('mousedown', 0);
    await key('keyup', 'ShiftLeft', { shiftKey: false });
    await step();
    const fireAfterBoostRelease = await callHarness(page, 'activeInput');

    verify(fireOnly.fire === true && fireOnly.boost === false,
      'LMB did not produce fire-only input.', { fireOnly, chord });
    verify(chord.fire === true && chord.boost === true,
      'Shift+LMB did not produce an independent two-button chord.', { fireOnly, chord });
    verify(boostAfterFireRelease.fire === false && boostAfterFireRelease.boost === true,
      'Releasing LMB cleared held Shift boost.', { boostAfterFireRelease });
    verify(fireAfterBoostRelease.fire === true && fireAfterBoostRelease.boost === false,
      'Releasing Shift cleared held LMB fire.', { fireAfterBoostRelease });
    return { route: route.href, fireOnly, chord, boostAfterFireRelease, fireAfterBoostRelease };
  });

  await report.check({
    id: 'INPUT.dead-signal-reset-boundaries',
    name: 'Lock, blur, pause and countdown boundaries clear mouse fire safely',
    assertion:
      'Mouse fire never latches across lock loss, pause/resume, blur or a new countdown; '
      + 'a physically held/reconstructed Shift remains independent.',
  }, async () => {
    // Pointer-lock loss while Shift and LMB are both physically held.
    await key('keydown', 'ShiftLeft', { shiftKey: true });
    await setLock(false);
    await callHarness(page, 'pauseMenu', [false]);
    await step();
    const lockLoss = await callHarness(page, 'activeInput');

    // Re-lock, hold fire again, then blur. The next modifier-bearing key event reconstructs Shift
    // without reconstructing mouse fire.
    await setLock(true);
    await mouse('mousedown', 0);
    await step();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await step();
    const blurred = await callHarness(page, 'activeInput');
    await key('keydown', 'KeyW', { shiftKey: true });
    await step();
    const reconstructed = await callHarness(page, 'activeInput');
    await key('keyup', 'KeyW', { shiftKey: true });
    await key('keyup', 'ShiftLeft', { shiftKey: false });

    // Pause follows a real lock-loss transition; resume must not restore the old mouse button.
    await setLock(true);
    await mouse('mousedown', 0);
    await step();
    await setLock(false);
    await callHarness(page, 'pauseMenu', [true]);
    await callHarness(page, 'pauseMenu', [false]);
    await step();
    const resumed = await callHarness(page, 'activeInput');

    // Starting a countdown calls Input.reset even if LMB was down on the prior flight frame.
    await setLock(true);
    await mouse('mousedown', 0);
    await step();
    await callHarness(page, 'startRun', [{ skipIntro: false }]);
    await step();
    const countdownPhase = await callHarness(page, 'phase');
    const countdown = await callHarness(page, 'activeInput');

    verify(lockLoss.fire === false && lockLoss.boost === true,
      'Lock loss failed to clear mouse fire or corrupted held Shift.', { lockLoss });
    verify(blurred.fire === false && blurred.boost === false,
      'Blur left a mouse/keyboard latch behind.', { blurred });
    verify(reconstructed.fire === false && reconstructed.boost === true,
      'Modifier reconstruction corrupted the independent mouse-fire state.', { reconstructed });
    verify(resumed.fire === false,
      'Pause/resume restored a stale mouse-fire latch.', { resumed });
    verify(countdownPhase === 'countdown' && countdown.fire === false,
      'A new countdown inherited mouse fire.', { countdownPhase, countdown });
    return { lockLoss, blurred, reconstructed, resumed, countdownPhase, countdown };
  });
}
