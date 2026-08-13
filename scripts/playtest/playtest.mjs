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
  'setAutopilot',
  'step',
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
    criteria: [criterion('M2', 'partial', 'Exercises all declared axes and observes throttle, speed, pitch, and roll; yaw/strafe effects are not exposed by telemetry.')],
    assertion: 'A fixed-timestep run accepts pitch, yaw, roll, throttle, strafeX, strafeY, boost, and brake together; after 60 frames telemetry is flying, finite, moving, and reflects commanded throttle plus pitch/roll response.',
  }, async () => collectInputEvidence(page, options));

  await report.check({
    id: 'M7.automation-input-surface',
    name: 'Scripted input covers the keyboard/mouse command vocabulary',
    criteria: [criterion('M7', 'partial', 'Proves API-level pitch/yaw/roll/throttle/strafe/boost/brake injection only; physical bindings and pointer lock remain a manual check.')],
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
    assertion: 'At fixed 1/60 s timestep, skill-1 autopilot reaches a result with gatesTotal > 0, gatesCleared === gatesTotal, one split per gate, and no decreasing gate index.',
  }, async () => {
    const evidence = unwrap(playthroughOutcome);
    const result = evidence.result;
    verify(result && Number.isInteger(result.gatesTotal) && result.gatesTotal > 0, 'Finished result has no positive gate total.', evidence);
    verify(result.gatesCleared === result.gatesTotal, 'Not every gate was cleared.', evidence);
    verify(Array.isArray(result.splits) && result.splits.length === result.gatesTotal, 'Split count does not match gate total.', evidence);
    verify(evidence.gateIndices.every((value, index, values) => index === 0 || value >= values[index - 1]), 'Gate indices moved backwards.', evidence);
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
}

async function collectInputEvidence(page, options) {
  verify(page, 'Browser page is unavailable.');
  await callHarness(page, 'ready', [], options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ seed: options.seed, skipIntro: true }]);
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
    await callHarness(page, 'setInput', [command]);
    await callHarness(page, 'step', [60]);
    const after = await callHarness(page, 'telemetry');
    await callHarness(page, 'setInput', [null]);

    const evidence = {
      fixedTimestep: 1 / 60,
      simulatedFrames: 60,
      command,
      commandFields: Object.keys(command),
      before: compactTelemetry(before),
      after: compactTelemetry(after),
      releasedToHumanControl: true,
    };
    verify(after?.phase === 'flying', 'Input probe left the flying phase.', evidence);
    verify(finiteNumber(after?.throttle) && Math.abs(after.throttle - command.throttle) <= 0.05, 'Telemetry throttle does not reflect the command.', evidence);
    verify(finiteNumber(after?.speed) && after.speed > 0, 'Input probe did not produce positive speed.', evidence);
    verify(finiteNumber(after?.pitch) && finiteNumber(after?.roll), 'Pitch or roll telemetry is not finite.', evidence);
    verify(Math.abs(after.pitch) > 0.001 || Math.abs(after.roll) > 0.001, 'Neither pitch nor roll responded to rotational input.', evidence);
    return evidence;
  } finally {
    await bestEffort(page, 'setInput', [null]);
    await bestEffort(page, 'setFixedTimestep', [null]);
  }
}

async function collectPlaythrough(page, options) {
  verify(page, 'Browser page is unavailable.');
  await reloadHarness(page, options.timeoutMs);
  await callHarness(page, 'setFixedTimestep', [1 / 60]);
  await callHarness(page, 'startRun', [{ seed: options.seed, skipIntro: true }]);
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
      result,
    };
    verify(finalPhase === 'finished', `Playthrough exceeded ${options.maxSimSeconds} simulated seconds before finishing.`, evidence);
    return evidence;
  } finally {
    await bestEffort(page, 'setAutopilot', [false]);
    await bestEffort(page, 'setFixedTimestep', [null]);
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
