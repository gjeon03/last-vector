import * as THREE from 'three';
import { getCourseDefinition } from '../../src/core/Courses.ts';
import { Course } from '../../src/game/Course.ts';
import { createLightingUniforms } from '../../src/render/lighting.ts';
import {
  STAGE_LANDMARK_ANCHORS,
  StageLandmarks,
  validateStageLandmarkColliders,
} from '../../src/render/StageLandmarks.ts';
import { Report, parseOptions, verify } from './runtime.mjs';

function anchorFrames(kind, course) {
  return STAGE_LANDMARK_ANCHORS[kind].map((spec) => {
    const index = Math.min(
      course.spine.length - 2,
      Math.floor(course.spine.length * spec.routeFraction),
    );
    const anchor = course.spine[index];
    const ahead = course.spine[Math.min(course.spine.length - 1, index + 6)];
    const forward = new THREE.Vector3().subVectors(ahead, anchor).normalize();
    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const position = anchor
      .clone()
      .addScaledVector(right, spec.rightOffset)
      .addScaledVector(forward, spec.forwardOffset)
      .add(new THREE.Vector3(0, spec.verticalOffset, 0));
    return { position, forward, right, up };
  });
}

function construct(id) {
  const definition = getCourseDefinition(id);
  const seed = definition.defaultSeed;
  const lighting = createLightingUniforms(new THREE.Vector3(...definition.world.sunDirection));
  const course = new Course(definition, seed, lighting);
  const landmarks = new StageLandmarks({
    kind: definition.world.landmarkKind,
    lighting,
    seed: seed ^ 0x5bd1,
    anchors: anchorFrames(definition.world.landmarkKind, course),
    protectedChannel: course.clearChannel,
  });
  return { course, landmarks };
}

function visibleCoverage(landmarks) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const point = new THREE.Vector3();
  const instanceMatrix = new THREE.Matrix4();
  const instanceWorld = new THREE.Matrix4();
  let sampledPoints = 0;
  let uncoveredPoints = 0;
  let maximumExcursion = 0;
  let subject = null;

  const sample = (objectName, x, y, z) => {
    point.set(x, y, z);
    let bestContainment = -Infinity;
    for (const collider of landmarks.colliders) {
      const dx = point.x - collider.center[0];
      const dy = point.y - collider.center[1];
      const dz = point.z - collider.center[2];
      bestContainment = Math.max(
        bestContainment,
        collider.radius - Math.sqrt(dx * dx + dy * dy + dz * dz),
      );
    }
    sampledPoints++;
    if (bestContainment < -0.05) {
      uncoveredPoints++;
      if (-bestContainment > maximumExcursion) {
        maximumExcursion = -bestContainment;
        subject = objectName;
      }
    }
  };

  const sampleGeometry = (object, worldMatrix, objectName) => {
    const position = object.geometry.getAttribute('position');
    const index = object.geometry.getIndex();
    const triangles = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    for (let triangle = 0; triangle < triangles; triangle++) {
      const ia = index ? index.getX(triangle * 3) : triangle * 3;
      const ib = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const ic = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
      a.fromBufferAttribute(position, ia).applyMatrix4(worldMatrix);
      b.fromBufferAttribute(position, ib).applyMatrix4(worldMatrix);
      c.fromBufferAttribute(position, ic).applyMatrix4(worldMatrix);
      sample(objectName, a.x, a.y, a.z);
      sample(objectName, b.x, b.y, b.z);
      sample(objectName, c.x, c.y, c.z);
      sample(objectName, (a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
      sample(objectName, (b.x + c.x) * 0.5, (b.y + c.y) * 0.5, (b.z + c.z) * 0.5);
      sample(objectName, (c.x + a.x) * 0.5, (c.y + a.y) * 0.5, (c.z + a.z) * 0.5);
      sample(objectName, (a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
    }
  };

  landmarks.object.updateMatrixWorld(true);
  landmarks.object.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object instanceof THREE.InstancedMesh) {
      for (let instance = 0; instance < object.count; instance++) {
        object.getMatrixAt(instance, instanceMatrix);
        instanceWorld.multiplyMatrices(object.matrixWorld, instanceMatrix);
        sampleGeometry(object, instanceWorld, `${object.name} / ${instance + 1}`);
      }
      return;
    }
    sampleGeometry(object, object.matrixWorld, object.name);
  });
  return {
    sampledPoints,
    uncoveredPoints,
    maximumExcursion: +maximumExcursion.toFixed(3),
    subject,
  };
}

const options = parseOptions('stage-landmarks-contract', process.argv.slice(2));
const report = new Report('stage-landmarks-contract', options);

await report.check({
  id: 'LANDMARKS.fixed-stage-contract',
  name: 'Chapter 01 landmarks are deterministic, bounded, and outside the clean channel',
  assertion: 'Each fixed seed creates the authored landmark set with shared resources, immutable sphere colliders, and no protected-channel overlap.',
}, () => {
  const expected = {
    'cairn-drift': {
      landmarks: ['broken-span'],
      draws: 3,
      triangles: 17912,
      geometries: 3,
      materials: 1,
      colliders: 0,
    },
    wreckline: {
      landmarks: ['twin-keels', 'the-fracture', 'engine-spine'],
      draws: 5,
      triangles: 5160,
      geometries: 3,
      materials: 1,
      colliders: 23,
    },
    ringfall: {
      landmarks: ['ring-wall', 'twin-spires', 'orison-arch'],
      draws: 7,
      triangles: 5732,
      geometries: 4,
      materials: 1,
      colliders: 21,
    },
  };
  const evidence = {};

  for (const id of Object.keys(expected)) {
    const first = construct(id);
    const second = construct(id);
    try {
      const debug = first.landmarks.getDebugState();
      const repeated = second.landmarks.getDebugState();
      const contract = expected[id];
      verify(JSON.stringify(debug.landmarks) === JSON.stringify(contract.landmarks),
        `${id} landmark identity drifted.`, { debug, contract });
      for (const field of ['draws', 'triangles', 'geometries', 'materials', 'colliders']) {
        verify(debug[field] === contract[field], `${id} ${field} changed.`, { debug, contract });
      }
      verify(debug.signature === repeated.signature
        && JSON.stringify(first.landmarks.colliders) === JSON.stringify(second.landmarks.colliders),
      `${id} fixed-seed construction is not deterministic.`, { debug, repeated });
      verify(debug.draws <= 160 && debug.triangles <= 620_000 && debug.geometries <= 155
        && debug.materials <= 55 && debug.colliders <= 24,
      `${id} exceeds a predeclared Chapter 01 resource ceiling.`, debug);
      verify(Object.isFrozen(first.landmarks.colliders)
        && first.landmarks.colliders.every((collider) =>
          Object.isFrozen(collider) && Object.isFrozen(collider.center)),
      `${id} exposes mutable collision authoring.`, { colliders: first.landmarks.colliders });
      verify(JSON.parse(JSON.stringify(debug)).signature === debug.signature,
        `${id} debug state is not JSON-safe.`, debug);

      const coverage = debug.kind === 'cairn'
        ? { sampledPoints: 0, uncoveredPoints: 0, maximumExcursion: 0, subject: null }
        : visibleCoverage(first.landmarks);
      verify(coverage.uncoveredPoints === 0,
        `${id} exposes visible solid geometry outside its collider union.`, coverage);

      first.landmarks.setPixelScale(2);
      first.landmarks.update(1.25, new THREE.Vector3(100, 20, -300));
      evidence[id] = { ...debug, coverage };
    } finally {
      first.landmarks.dispose();
      first.landmarks.dispose();
      first.course.dispose();
      second.landmarks.dispose();
      second.course.dispose();
    }
  }

  return evidence;
});

await report.check({
  id: 'LANDMARKS.clean-channel-rejection',
  name: 'Unsafe authored colliders fail closed',
  assertion: 'A sphere touching the protected course capsule is rejected before gameplay integration.',
}, () => {
  const collider = Object.freeze({
    id: 'unsafe-test',
    center: Object.freeze([0, 0, 0]),
    radius: 20,
  });
  const channel = [{
    a: new THREE.Vector3(-100, 0, 0),
    b: new THREE.Vector3(100, 0, 0),
    radius: 40,
  }];
  let message = null;
  try {
    validateStageLandmarkColliders([collider], channel);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  verify(message?.includes('intersects protected clean-channel'),
    'Unsafe collider was not rejected with a clean-channel diagnostic.', { message });
  return { message };
});

await report.write();
process.stdout.write(`${report.status}: ${report.reportPath}\n`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
