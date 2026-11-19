import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { applyEquipment, clearEquipment, updateEquipment } from './equipment.js';
import { DEFAULT_SPEC } from './spec.js';

function bodyFor(scale) {
  const root = new THREE.Group(), character = new THREE.Group(), hips = new THREE.Group(), spine = new THREE.Group();
  character.scale.setScalar(scale); root.add(character); character.add(hips); hips.add(spine);
  hips.position.y = .7 / scale; spine.position.y = .15 / scale;
  const baseGeometry = new THREE.BoxGeometry(.3 / scale, .28 / scale, .2 / scale), baseMaterial = new THREE.MeshStandardMaterial({ color: '#5a6e83' });
  spine.add(new THREE.Mesh(baseGeometry, baseMaterial));
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-.22 / scale, .12 / scale, 0); armR.position.set(.22 / scale, .12 / scale, 0);
  spine.add(armL, armR);
  root.position.set(4, 0, -3); root.rotation.y = .8;
  const spec = structuredClone(DEFAULT_SPEC);
  return { root, hips, spine, armL, armR, standHip: .7, spec, baseGeometry, baseMaterial };
}

for (const [style, scale] of [['chibi', .108], ['blocky', .0447]]) {
  test(`${style}: equipment preserves identity, world pose, and original geometry`, () => {
    const body = bodyFor(scale), spec = structuredClone(body.spec), position = body.root.position.clone(), rotation = body.root.quaternion.clone();
    const baseCount = body.spine.children.length;
    applyEquipment(body, { outfit: 'outfit-tide', armor: 'armor-sentinel', pet: 'pet-cloud' });
    assert.deepEqual(body.spec, spec);
    assert.ok(body.root.position.equals(position));
    assert.ok(body.root.quaternion.equals(rotation));
    assert.ok(body.marketLayers.length >= 6);
    body.root.visible = false;
    assert.equal(body.marketPet.parent, body.root, 'pet inherits owner visibility instead of appearing while owner is absent');
    updateEquipment(body, 2);
    assert.ok(Number.isFinite(body.marketPet.position.y));
    clearEquipment(body);
    assert.equal(body.spine.children.length, baseCount);
    assert.equal(body.marketPet, null);
    assert.equal(body.marketLayers.length, 0);
    body.baseGeometry.dispose(); body.baseMaterial.dispose();
  });
}

test('changing and removing cosmetics disposes their geometry without disposing the base character', () => {
  const body = bodyFor(.108);
  let baseDisposed = false, equipmentDisposed = 0;
  body.baseGeometry.addEventListener('dispose', () => { baseDisposed = true; });
  applyEquipment(body, { outfit: 'outfit-ember', pet: 'pet-sprout' });
  const oldPet = body.marketPet;
  for (const layer of body.marketLayers) layer.traverse(o => {
    if (o.isMesh) o.geometry.addEventListener('dispose', () => { equipmentDisposed++; });
  });
  applyEquipment(body, { armor: 'armor-solar' });
  assert.ok(equipmentDisposed > 0);
  assert.equal(oldPet.parent, null);
  assert.equal(body.marketPet, null);
  assert.equal(baseDisposed, false);
  clearEquipment(body);
  body.baseGeometry.dispose(); body.baseMaterial.dispose();
});

test('equipping while leaning uses the same local dimensions as an upright character', () => {
  const upright = bodyFor(.108), leaning = bodyFor(.108);
  leaning.spine.rotation.x = Math.PI / 3;
  applyEquipment(upright, { outfit: 'outfit-tide', armor: 'armor-sentinel' });
  applyEquipment(leaning, { outfit: 'outfit-tide', armor: 'armor-sentinel' });
  const parameters = body => body.marketLayers.flatMap(layer => layer.children.filter(o => o.isMesh).map(o => o.geometry.parameters));
  assert.deepEqual(parameters(leaning), parameters(upright));
  for (const body of [upright, leaning]) { clearEquipment(body); body.baseGeometry.dispose(); body.baseMaterial.dispose(); }
});

test('every catalog look builds, animates and clears (hoodie, vest, cat, drone and the rest)', async () => {
  const { MARKETPLACE_CATALOG } = await import('../config/marketplace.js');
  for (const item of MARKETPLACE_CATALOG) {
    const body = bodyFor(.108), before = body.spine.children.length;
    applyEquipment(body, { [item.slot]: item.id });
    assert.ok(body.marketLayers.length >= 1, `${item.id} added nothing`);
    for (const t of [0, .5, 2]) updateEquipment(body, t);
    if (item.slot === 'pet') assert.ok(Number.isFinite(body.marketPet.position.y), item.id);
    clearEquipment(body);
    assert.equal(body.spine.children.length, before, `${item.id} left something behind`);
    body.baseGeometry.dispose(); body.baseMaterial.dispose();
  }
});
