import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HarvestCellField } from '../../src/render/HarvestCellField.ts';

const sources = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  generation: 0,
  position: new THREE.Vector3(index * 900, index * 40, -index * 120),
  phase: index * 0.3,
  charge: 1 - index * 0.05,
  alive: true,
}));
const field = new HarvestCellField(10);
const debug = field.getDebugState();

assert.deepEqual(debug, {
  activeSources: 10,
  sourceDrawCalls: 20,
  sourceGeometries: 2,
  sourceMaterials: 20,
  sourceTriangles: 220,
  structureDrawCalls: 0,
  structureTriangles: 0,
  colliders: 0,
});
assert.equal(Object.isFrozen(debug), true);
assert.equal(field.object.children.length, 10);

field.update(sources, 0, new THREE.Vector3(0, 0, 1_000), 1080, Math.PI / 3);
const groups = field.object.children;
const halos = groups.map((group) => group.children[0]);
const cores = groups.map((group) => group.children[1]);
for (let index = 0; index < groups.length; index++) {
  const group = groups[index];
  const halo = halos[index];
  const core = cores[index];
  assert.equal(group.visible, true);
  assert.ok(halo instanceof THREE.Mesh && halo.geometry instanceof THREE.PlaneGeometry);
  assert.ok(halo.material instanceof THREE.ShaderMaterial);
  assert.equal(halo.material.depthTest, true);
  assert.equal(halo.material.depthWrite, false);
  assert.ok(core instanceof THREE.Mesh && core.geometry instanceof THREE.IcosahedronGeometry);
  assert.ok(core.material instanceof THREE.MeshBasicMaterial);
  assert.equal(core.material.depthTest, true);
  assert.equal(core.material.depthWrite, false);
}

const geometryRefs = [...halos, ...cores].map((mesh) => mesh.geometry);
const materialRefs = [...halos, ...cores].map((mesh) => mesh.material);
const childCounts = groups.map((group) => group.children.length);
field.update(sources, 0.25, new THREE.Vector3(0, 0, 100_000), 1080, Math.PI / 3);
assert.ok(halos[0].material.uniforms.uScale.value > 150, 'far cells retain an angular-size floor');
assert.deepEqual([...halos, ...cores].map((mesh) => mesh.geometry), geometryRefs);
assert.deepEqual([...halos, ...cores].map((mesh) => mesh.material), materialRefs);
assert.deepEqual(groups.map((group) => group.children.length), childCounts);

const firstPosition = groups[0].position.clone();
sources[0].position.set(4_000, 200, -500);
sources[0].id = 11;
sources[0].generation = 1;
sources[0].charge = 0.25;
field.update(sources, 0, new THREE.Vector3(), 1080, Math.PI / 3);
assert.ok(groups[0].position.distanceTo(firstPosition) > 1_000);
assert.equal(halos[0].material.uniforms.uCharge.value, 0.25);

sources[0].alive = false;
field.update(sources, 0.1, new THREE.Vector3(), 1080, Math.PI / 3);
assert.equal(groups[0].visible, true, 'pickup flash keeps a collected cell visible briefly');
field.update(sources, 0.3, new THREE.Vector3(), 1080, Math.PI / 3);
assert.equal(groups[0].visible, false);

field.reset();
assert.ok(groups.every((group) => !group.visible));
field.dispose();

console.log(JSON.stringify({ ok: true, debug }, null, 2));
