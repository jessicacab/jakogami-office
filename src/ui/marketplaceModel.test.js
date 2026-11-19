import assert from 'node:assert/strict';
import test from 'node:test';
import { ATTRIBUTE_KEYS, EQUIPMENT_SLOTS, MARKETPLACE_CATALOG, STARTING_COINS, characterAttributes, emptyEquipment, normalizeEquipment } from '../config/marketplace.js';
import { itemState, previewEquipment } from './marketplaceModel.js';

test('catalog has original items for each slot and an affordable starting look; weapons take earned coins', () => {
  assert.equal(STARTING_COINS, 3000);
  assert.equal(new Set(MARKETPLACE_CATALOG.map(item => item.id)).size, MARKETPLACE_CATALOG.length);
  const COUNTS = { outfit: 5, armor: 5, pet: 5, weapon: 6 };
  for (const slot of EQUIPMENT_SLOTS) assert.equal(MARKETPLACE_CATALOG.filter(item => item.slot === slot).length, COUNTS[slot], slot);
  const cheapest = slot => Math.min(...MARKETPLACE_CATALOG.filter(item => item.slot === slot).map(item => item.price));
  // the welcome coins buy a whole look (outfit, armor, pet); a weapon on top of that needs coins earned through Jira
  assert.ok(cheapest('outfit') + cheapest('armor') + cheapest('pet') <= STARTING_COINS);
  assert.ok(cheapest('outfit') + cheapest('armor') + cheapest('pet') + cheapest('weapon') > STARTING_COINS);
  assert.ok(MARKETPLACE_CATALOG.filter(item => item.slot === 'weapon').every(w => w.price > Math.max(...MARKETPLACE_CATALOG.filter(i => i.slot !== 'weapon').map(i => i.price))), 'weapons are the most expensive items');
  assert.ok(MARKETPLACE_CATALOG.every(item => Number.isInteger(item.price) && item.price > 0));
  for (const item of MARKETPLACE_CATALOG) for (const key of ATTRIBUTE_KEYS) assert.ok(Number.isInteger(item.attributes[key]) && item.attributes[key] >= 0);
});

test('equipped attributes stack by slot and replacement/unequip never accumulate old bonuses', () => {
  const gear = { outfit: 'outfit-tide', armor: 'armor-solar', pet: 'pet-cloud' };
  const original = structuredClone(gear);
  assert.deepEqual(characterAttributes(gear).total, { strength: 19, agility: 15, intelligence: 25 });
  assert.deepEqual(characterAttributes({ ...gear, outfit: 'outfit-ember' }).total, { strength: 21, agility: 16, intelligence: 21 });
  assert.deepEqual(characterAttributes({ ...gear, armor: null }).total, { strength: 11, agility: 15, intelligence: 22 });
  assert.deepEqual(characterAttributes({ outfit: 'pet-cloud' }).total, { strength: 10, agility: 10, intelligence: 10 });
  assert.deepEqual(gear, original);
});

test('no account, insufficient coins, and already-owned items cannot be purchased', () => {
  const item = MARKETPLACE_CATALOG[0];
  assert.equal(itemState(null, item.id).canBuy, false);
  assert.equal(itemState({ balance: item.price - 1, inventory: [], equipped: emptyEquipment() }, item.id).canBuy, false);
  assert.equal(itemState({ balance: 3000, inventory: [item.id], equipped: emptyEquipment() }, item.id).canBuy, false);
  assert.equal(itemState({ balance: item.price, inventory: [], equipped: emptyEquipment() }, item.id).canBuy, true);
});

test('try-on changes only the preview slot and never changes wallet, ownership, or equipped state', () => {
  const account = { balance: 3000, inventory: ['pet-cloud'], equipped: { outfit: null, armor: null, pet: 'pet-cloud' } };
  const before = structuredClone(account);
  const preview = previewEquipment(account, 'armor-sentinel');
  assert.deepEqual(preview, { outfit: null, armor: 'armor-sentinel', pet: 'pet-cloud', weapon: null });
  assert.deepEqual(account, before);
});

test('unknown IDs and wrong-slot cosmetics are not accepted as equipped', () => {
  assert.deepEqual(normalizeEquipment({ outfit: 'pet-cloud', armor: 'not-an-item', pet: 'pet-sprout' }), { outfit: null, armor: null, pet: 'pet-sprout', weapon: null });
  assert.deepEqual(previewEquipment(null, 'not-an-item'), emptyEquipment());
});
