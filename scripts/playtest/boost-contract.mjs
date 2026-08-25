import * as THREE from 'three';
import { FLIGHT } from '../../src/core/art.ts';
import { Ship } from '../../src/game/Ship.ts';
import { Report, parseOptions, verify } from './runtime.mjs';

const command = (boost) => ({
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttle: 1,
  strafeX: 0,
  strafeY: 0,
  boost,
  brake: false,
  stickX: 0,
  stickY: 0,
});

function freshShip() {
  const ship = new Ship();
  ship.reset(new THREE.Vector3(), new THREE.Quaternion(), FLIGHT.cruiseSpeed);
  return ship;
}

function runUntil(ship, fps, predicate, maxSeconds, boost = true) {
  const dt = 1 / fps;
  let frames = 0;
  while (!predicate(ship) && frames * dt <= maxSeconds) {
    ship.update(dt, command(boost));
    frames += 1;
  }
  verify(predicate(ship), `Condition was not reached within ${maxSeconds}s at ${fps} Hz.`, {
    frames,
    energy: ship.energy,
    boostLocked: ship.boostLocked,
    boosting: ship.boosting,
  });
  return { frames, seconds: frames * dt };
}

function fixedStepEvidence(fps) {
  const dt = 1 / fps;
  const ship = freshShip();
  const fullBurn = runUntil(ship, fps, (value) => value.boostLocked, 6);
  verify(Math.abs(fullBurn.seconds - 4.6) <= dt + 1e-9,
    `Full usable burn missed 4.60s by more than one ${fps} Hz physics step.`, fullBurn);

  const rearmGap = runUntil(ship, fps, (value) => value.boosting, 4);
  verify(Math.abs(rearmGap.seconds - (FLIGHT.boostRegenDelay + 37 / FLIGHT.boostRegen)) <= dt * 2 + 1e-9,
    `Natural rearm gap missed the derived 2.33s target at ${fps} Hz.`, rearmGap);
  const naturalBurn = runUntil(ship, fps, (value) => value.boostLocked, 3);
  verify(Math.abs(naturalBurn.seconds - 1.85) <= dt * 2 + 1e-9,
    `Natural rearm burn missed the derived 1.85s target at ${fps} Hz.`, naturalBurn);

  const rewarded = freshShip();
  runUntil(rewarded, fps, (value) => value.boostLocked, 6);
  const reward = rewarded.rechargeBoost(25);
  verify(rewarded.boostLocked === false && reward.after > FLIGHT.boostEngageFraction,
    'The authored 25% reward did not bypass the natural rearm latch.', reward);
  const rewardBurn = runUntil(rewarded, fps, (value) => value.boostLocked, 2);
  verify(Math.abs(rewardBurn.seconds - 1.25) <= dt * 2 + 1e-9,
    `The authored reward did not unlock about 1.25s of boost at ${fps} Hz.`, rewardBurn);

  return { fps, fullBurn, rearmGap, naturalBurn, reward, rewardBurn };
}

const options = parseOptions('boost-contract', process.argv.slice(2));
const report = new Report('boost-contract', options);

await report.check({
  id: 'BOOST.baseline',
  name: 'Campaign boost baseline changes drain only',
  assertion: 'Capacity, latch floors, regen, delay and speed remain pinned while drain is 20/s.',
}, () => {
  const actual = {
    capacity: FLIGHT.boostCapacity,
    engageFraction: FLIGHT.boostEngageFraction,
    rearmFraction: FLIGHT.boostRearmFraction,
    drain: FLIGHT.boostDrain,
    regen: FLIGHT.boostRegen,
    regenDelay: FLIGHT.boostRegenDelay,
    cruiseSpeed: FLIGHT.cruiseSpeed,
    boostSpeed: FLIGHT.boostSpeed,
    maxSpeed: FLIGHT.maxSpeed,
  };
  const expected = {
    capacity: 100,
    engageFraction: 0.08,
    rearmFraction: 0.45,
    drain: 20,
    regen: 22,
    regenDelay: 0.65,
    cruiseSpeed: 462,
    boostSpeed: 1078,
    maxSpeed: 1188,
  };
  verify(JSON.stringify(actual) === JSON.stringify(expected), 'Boost baseline drifted.', { actual, expected });
  const usableSeconds = FLIGHT.boostCapacity * (1 - FLIGHT.boostEngageFraction) / FLIGHT.boostDrain;
  const ticks = Array.from(
    { length: Math.floor(usableSeconds) },
    (_, index) => Math.round((FLIGHT.boostCapacity * FLIGHT.boostEngageFraction
      + FLIGHT.boostDrain * (index + 1)) / FLIGHT.boostCapacity * 100),
  );
  verify(usableSeconds === 4.6 && JSON.stringify(ticks) === JSON.stringify([28, 48, 68, 88]),
    'Derived HUD scale differs from the campaign baseline.', { usableSeconds, ticks });
  return { ...actual, usableSeconds, ticks };
});

await report.check({
  id: 'BOOST.fixed-step-60-120',
  name: 'Latch and authored reward remain deterministic at 60 and 120 Hz',
  assertion: 'Full, natural-rearm and rewarded burns land within the declared physics-step bounds.',
}, () => [fixedStepEvidence(60), fixedStepEvidence(120)]);

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
