import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createLightingUniforms } from '../../src/render/lighting.ts';
import {
  RELAY_HARVEST_SOURCE_DRAW_CAP,
  RELAY_HARVEST_SOURCE_TRIANGLE_CAP,
  RelayHarvestField,
} from '../../src/render/RelayHarvestField.ts';
import {
  getRelayHarvestLayout,
  VALIDATED_RELAY_HARVEST_LAYOUTS,
} from '../../src/game/missions/RelayHarvestLayout.ts';
import { RelayHarvestState } from '../../src/game/missions/RelayHarvestState.ts';

const lighting = createLightingUniforms(new THREE.Vector3(-0.32, 0.42, -0.85));
const state = new RelayHarvestState(getRelayHarvestLayout(0));
const field = new RelayHarvestField({
  sources: state.sources,
  protectedPositions: state.authoredPositions,
  lighting,
});
const debug = field.getDebugState();

assert.equal(debug.activeSources, 10);
assert.equal(debug.sourceDrawCalls, 2);
assert.equal(debug.sourceGeometries, 2);
assert.equal(debug.sourceMaterials, 2);
assert.ok(debug.sourceDrawCalls <= RELAY_HARVEST_SOURCE_DRAW_CAP);
assert.ok(debug.sourceTriangles <= RELAY_HARVEST_SOURCE_TRIANGLE_CAP);
assert.ok(debug.colliders > 0 && debug.colliders <= 90);

for (const collider of field.colliders) {
  for (const sourcePosition of state.authoredPositions) {
    const surfaceClearance = collider.position.distanceTo(sourcePosition) - collider.radius;
    assert.ok(
      surfaceClearance >= 500 - 1e-6,
      `${collider.id} violates an authored relocation socket: ${surfaceClearance}`,
    );
  }
}

const sourceMeshes = field.object.children.filter((child) =>
  child.name.includes('ENERGY CORES')
  || child.name.includes('ENERGY HALOS'));
assert.equal(sourceMeshes.length, 2);
for (const mesh of sourceMeshes) assert.ok(mesh instanceof THREE.InstancedMesh);

const geometries = sourceMeshes.map((mesh) => mesh.geometry);
const materials = sourceMeshes.map((mesh) => mesh.material);
const initialInstanceMatrices = sourceMeshes.map((mesh) => Array.from(mesh.instanceMatrix.array));
const collectedAttributes = sourceMeshes.map((mesh) => mesh.geometry.getAttribute('aCollectedAt'));
const expiryAttributes = sourceMeshes.map((mesh) => mesh.geometry.getAttribute('aExpiresAt'));
for (const attribute of expiryAttributes) {
  assert.ok(Math.abs(attribute.getX(0) - state.sources[0].expiresAt) <= 1e-4);
}
const childCount = field.object.children.length;

field.update(0.5, new THREE.Vector3(0, 0, 1_000));
assert.ok(state.collect(0, 0.5));
field.update(0.5, new THREE.Vector3(0, 0, 1_000));
for (const attribute of collectedAttributes) assert.equal(attribute.getX(0), 0.5);
const versionsAfterCollection = collectedAttributes.map((attribute) => attribute.version);

const relocationSource = state.sources[1];
const relocationBefore = relocationSource.position.clone();
relocationSource.expiresAt = 0.6;
assert.equal(state.relocateExpired(0.61), 1);
field.update(0.61, new THREE.Vector3(10, 0, 900));
assert.equal(relocationSource.generation, 1);
assert.ok(relocationSource.position.distanceTo(relocationBefore) > 1_000);
for (const attribute of expiryAttributes) {
  assert.ok(Math.abs(attribute.getX(1) - relocationSource.expiresAt) <= 1e-4);
}
const matricesAfterRelocation = sourceMeshes.map((mesh) => Array.from(mesh.instanceMatrix.array));
for (let index = 0; index < sourceMeshes.length; index++) {
  assert.notDeepEqual(matricesAfterRelocation[index], initialInstanceMatrices[index]);
}

field.update(0.75, new THREE.Vector3(10, 0, 900));
assert.deepEqual(
  collectedAttributes.map((attribute) => attribute.version),
  versionsAfterCollection,
  'steady presentation updated source GPU attributes without a collection change',
);
assert.equal(field.object.children.length, childCount);
assert.deepEqual(sourceMeshes.map((mesh) => mesh.geometry), geometries);
assert.deepEqual(sourceMeshes.map((mesh) => mesh.material), materials);
for (let index = 0; index < sourceMeshes.length; index++) {
  assert.deepEqual(Array.from(sourceMeshes[index].instanceMatrix.array), matricesAfterRelocation[index]);
}

state.reset();
field.reset();
field.update(0, new THREE.Vector3());
for (const attribute of collectedAttributes) assert.equal(attribute.getX(0), -1);

field.dispose();

for (let index = 1; index < VALIDATED_RELAY_HARVEST_LAYOUTS.length; index++) {
  const layoutState = new RelayHarvestState(getRelayHarvestLayout(index));
  const layoutField = new RelayHarvestField({
    sources: layoutState.sources,
    protectedPositions: layoutState.authoredPositions,
    lighting,
  });
  for (const collider of layoutField.colliders) {
    for (const sourcePosition of layoutState.authoredPositions) {
      assert.ok(
        collider.position.distanceTo(sourcePosition) - collider.radius >= 500 - 1e-6,
        `${layoutState.layoutSignature}: ${collider.id} violates authored socket clearance`,
      );
    }
  }
  layoutField.dispose();
}

console.log(JSON.stringify({
  ok: true,
  validatedLayouts: VALIDATED_RELAY_HARVEST_LAYOUTS.length,
  debug,
}, null, 2));
