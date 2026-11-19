import assert from 'node:assert/strict';
import test from 'node:test';
import { equipItem, fetchMarketplace, purchaseItem, validateMarketState } from './marketplace.js';
import { characterAttributes } from '../config/marketplace.js';

const STATE = { balance: 2550, inventory: ['outfit-tide'], equipped: { outfit: null, armor: null, pet: null, weapon: null } };

test('a changed cookie account signals reload rather than spending under another displayed identity', async t => {
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = originalWindow; });
  let changed = 0;
  window.addEventListener('office-account-changed', () => changed++);
  mockFetch(t, async () => ({ ok: false, status: 409, json: async () => ({ error: 'Account changed.', code: 'account_changed' }) }));
  await assert.rejects(purchaseItem('outfit-tide', 'account-a'), error => error.code === 'account_changed');
  assert.equal(changed, 1);
});
function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}
test('invalid balances and unowned equipment fail closed', () => {
  for (const balance of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3000']) {
    assert.throws(() => validateMarketState({ ...STATE, balance }), /invalid account/);
  }
  assert.throws(() => validateMarketState({ ...STATE, equipped: { outfit: 'outfit-ember' } }), /inventory could not be verified/);
  assert.deepEqual(validateMarketState(STATE), { ...STATE, attributes: characterAttributes(STATE.equipped) });
});

test('marketplace mutations send only item and slot, never client account IDs or prices', async t => {
  const calls = [];
  mockFetch(t, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => structuredClone(STATE) };
  });
  await purchaseItem('outfit-tide', 'account-a');
  await equipItem('outfit', 'outfit-tide', 'account-a');
  await equipItem('outfit', null, 'account-a');
  assert.deepEqual(calls.map(c => JSON.parse(c.options.body)), [
    { itemId: 'outfit-tide' }, { slot: 'outfit', itemId: 'outfit-tide' }, { slot: 'outfit', itemId: null },
  ]);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Office-Account'], 'account-a');
  }
});

test('missing SQL returns setup error and never fabricates a 3000-coin wallet', async t => {
  mockFetch(t, async () => ({ ok: false, status: 503, json: async () => ({ error: 'Run marketplace migration.', code: 'setup_required' }) }));
  await assert.rejects(fetchMarketplace(), error => error.code === 'setup_required' && error.status === 503);
});

test('an expired session dispatches auth loss rather than a local purchase fallback', async t => {
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = originalWindow; });
  let ended = 0;
  window.addEventListener('office-auth-lost', () => ended++);
  mockFetch(t, async () => ({ ok: false, status: 401, json: async () => ({ error: 'Sign in again.' }) }));
  await assert.rejects(purchaseItem('outfit-tide'), /Sign in again/);
  assert.equal(ended, 1);
});
