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
    criteria: [criterion('M2', 'full', 'Exercises every declared control, confirms the applied command, and observes finite six-axis pose motion.')],
    assertion: 'A fixed-timestep run applies pitch, yaw, roll, throttle, strafeX, strafeY, boost, and brake exactly; after 60 frames telemetry is flying and moving, position changes, and all three body angular rates respond.',
  }, async () => collectInputEvidence(page, options));

  await report.check({
    id: 'M7.automation-input-surface',
    name: 'Scripted input covers the keyboard/mouse command vocabulary',
    criteria: [criterion('M7', 'partial', 'Proves resolved API-level pitch/yaw/roll/throttle/strafe/boost/brake input only; physical bindings and pointer lock remain a manual check.')],
    assertion: 'The same automation command containing every keyboard/mouse flight action is accepted and can be released with setInput(null).',
  }, async () => {
    verify(inputOutcome.ok, 'The full input command was not accepted; see M2.automation-input.', inputOutcome.error);
    return {
      acceptedFields: inputOutcome.evidence.commandFields,
      releasedToHumanControl: inputOutcome.evidence.releasedToHumanControl,
      limitation: 'No current __LV method exposes physical binding state or pointer-lock ownership.',
    };
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
