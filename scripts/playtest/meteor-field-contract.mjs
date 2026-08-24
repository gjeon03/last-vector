import * as THREE from 'three';

import {
  METEOR_POOL_CAPACITY,
  METEOR_VARIANT_COUNT,
  MeteorField,
} from '../../src/render/MeteorField.ts';
import { createLightingUniforms } from '../../src/render/lighting.ts';
import { Report, parseOptions, verify } from './runtime.mjs';

const options = parseOptions('meteor-field-contract', process.argv.slice(2));
const report = new Report('meteor-field-contract', options);

function makeField(seed = 123) {
  return new MeteorField({
    lighting: createLightingUniforms(new THREE.Vector3(1, 1, 0)),
    seed,
  });
}

function spawn(field, index, variant = index % METEOR_VARIANT_COUNT) {
  return field.spawn({
    position: { x: index * 3, y: 0, z: 10 },
    velocity: { x: 0, y: 0, z: -100 },
    radius: 2,
    geometryVariant: variant,
    spawnId: index,
  });
}

await report.check({
  id: 'METEOR.fixed-cap',
  name: 'The render and contact pool has a hard 128-object ceiling',
  assertion: 'All slots are preallocated, eight or fewer batches draw them, and a 129th spawn fails closed.',
}, () => {
  const field = makeField();
  for (let index = 0; index < METEOR_POOL_CAPACITY; index++) {
    const contact = spawn(field, index);
    verify(contact?.slot === index, 'Slots did not activate in deterministic order.', { index, contact });
  }
  verify(spawn(field, METEOR_POOL_CAPACITY) === null, 'The pool expanded beyond its hard cap.');
  const stats = field.getDebugStats();
  verify(stats.activeCount === METEOR_POOL_CAPACITY && stats.freeCount === 0,
    'The full-pool counts disagree.', stats);
  verify(stats.batchCount === METEOR_VARIANT_COUNT
    && stats.activeBatchCount <= METEOR_VARIANT_COUNT,
  'The renderer exceeded its eight-batch budget.', stats);
  verify(stats.materialCount === 1 && stats.estimatedTriangles <= 60_000,
    'The full pool exceeded its material or triangle budget.', stats);
  field.dispose();
  return stats;
});

await report.check({
  id: 'METEOR.recycle-reset',
  name: 'Dense prefixes recycle without changing capacity',
  assertion: 'Swap removal, refill and reset preserve stable contact objects and deterministic slot order.',
}, () => {
  const field = makeField(456);
  for (let index = 0; index < METEOR_POOL_CAPACITY; index++) spawn(field, index);
  const stable = field.getContactBySlot(20);
  const generation = stable?.generation;
  verify(stable !== null && field.despawn(stable), 'A live stable contact did not despawn.');
  const recycled = spawn(field, 999, 7);
  verify(recycled === stable && recycled?.generation === (generation ?? 0) + 1,
    'The freed slot allocated a new contact object or failed to advance generation.', {
      stableSlot: stable?.slot,
      recycledSlot: recycled?.slot,
      generation,
      recycledGeneration: recycled?.generation,
    });
  const full = field.getDebugStats();
  verify(full.capacity === METEOR_POOL_CAPACITY && full.activeCount === METEOR_POOL_CAPACITY,
    'Recycling changed pool capacity or population.', full);

  field.reset();
  const reset = field.getDebugStats();
  const first = spawn(field, 0);
  verify(reset.activeCount === 0 && reset.freeCount === METEOR_POOL_CAPACITY
    && reset.totalSpawned === 0 && reset.totalDespawned === 0 && first?.slot === 0,
  'Reset did not restore the deterministic empty state.', { reset, firstSlot: first?.slot });

  field.reset();
  for (let index = 0; index < METEOR_POOL_CAPACITY; index++) spawn(field, index, 7);
  const concentrated = field.getDebugStats();
  verify(concentrated.activeCount === METEOR_POOL_CAPACITY && concentrated.activeBatchCount === 1,
    'One silhouette could not consume the full logical pool.', concentrated);
  field.dispose();
  return { full, reset, concentrated, firstSlot: first?.slot };
});

await report.check({
  id: 'METEOR.swept-contact',
  name: 'High-speed relative motion cannot tunnel through a contact sphere',
  assertion: 'Collision tests use both meteor and ship frame endpoints, including hit and near-miss cases.',
}, () => {
  const field = makeField(789);
  const contact = field.spawn({
    position: { x: 0, y: 0, z: 20 },
    velocity: { x: 0, y: 0, z: -2_000 },
    radius: 2,
    geometryVariant: 0,
  });
  verify(contact !== null, 'The swept-contact fixture did not spawn.');
  field.update(1 / 60, { x: 0, y: 0, z: 0 });
  const hit = contact
    ? field.intersectsSweptSphere(contact, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1)
    : false;
  const hitTime = contact
    ? field.sweptSphereHitTime(contact, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1)
    : -1;
  const impactMeteorZ = contact
    ? contact.previousPosition.z
      + (contact.position.z - contact.previousPosition.z) * hitTime
    : Number.NaN;
  const impactNormalZ = -Math.sign(impactMeteorZ);
  const miss = contact
    ? field.intersectsSweptSphere(contact, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 1)
    : true;
  verify(hit && !miss && hitTime > 0 && hitTime < 1 && impactNormalZ === -1,
    'Swept collision did not preserve the first-contact side of a high-speed crossing.', {
    hit,
    miss,
    hitTime,
    impactMeteorZ,
    impactNormalZ,
    previousZ: contact?.previousPosition.z,
    currentZ: contact?.position.z,
  });
  field.dispose();
  return { hit, miss, hitTime, impactMeteorZ, impactNormalZ };
});

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
