import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { DEFAULT_SPEC } from '../character/spec.js';
import { emptyEquipment, marketplaceItem } from '../config/marketplace.js';
import { initMarketplace, stopMarketplace } from './marketplace.js';

class Node {
  constructor() {
    this.children = []; this.dataset = {}; this.attrs = {}; this.handlers = new Map();
    this.style = { setProperty() {} }; this.hidden = false; this.open = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(name, callback) { this.handlers.set(name, callback); }
  removeEventListener(name) { this.handlers.delete(name); }
  closest() { return this.dataset.marketAction ? this : null; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  emit(name, target = this) { return this.handlers.get(name)?.({ target, stopPropagation() {} }); }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { await setImmediate(); }
function fixture(t) {
  const original = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Node()]));
  const filters = ['all', 'outfit', 'armor', 'pet', 'owned'].map(filter => {
    const node = new Node(); node.dataset.marketFilter = filter; return node;
  });
  globalThis.document = {
    getElementById(id) { assert.ok(nodes.has(id), `missing HTML control ${id}`); return nodes.get(id); },
    createElement: () => new Node(),
    createElementNS(namespaceURI) { const node = new Node(); node.namespaceURI = namespaceURI; return node; },
    querySelectorAll: () => filters,
  };
  t.after(() => { stopMarketplace(); globalThis.document = original; globalThis.window = originalWindow; });
  let account = { balance: 3000, inventory: [], equipped: emptyEquipment() };
  const state = {}, calls = { purchases: [], equipment: [], expected: [], starts: 0, stops: 0, disposes: 0, renders: [] };
  const preview = {
    start() { calls.starts++; }, stop() { calls.stops++; }, dispose() { calls.disposes++; },
    equip(equipped) { calls.renders.push(equipped); },
  };
  const api = {
    async fetchMarketplace(id) {
      calls.expected.push(id);
      if (state.accountWait) return state.accountWait;
      if (state.setupError) throw Object.assign(new Error('setup'), { code: 'setup_required' });
      return structuredClone(account);
    },
    async fetchMarketEquipment() { return []; },
    async purchaseItem(itemId, accountId) {
      calls.purchases.push(itemId); calls.expected.push(accountId);
      if (state.purchaseWait) await state.purchaseWait;
      const item = marketplaceItem(itemId);
      account.balance -= item.price; account.inventory.push(itemId);
      return structuredClone(account);
    },
    async equipItem(slot, itemId, accountId) {
      calls.expected.push(accountId); account.equipped[slot] = itemId;
      return structuredClone(account);
    },
  };
  const intervals = new Map();
  const owner = { userId: 'account-a', spec: structuredClone(DEFAULT_SPEC) };
  initMarketplace({ id: 'account-a', full_name: 'Test Employee' }, {
    people: [owner, { userId: 'selected-other-account', spec: structuredClone(DEFAULT_SPEC) }],
    api,
    equipPerson(person, equipment) { calls.equipment.push({ userId: person.userId, equipment }); },
    applyEquipmentSnapshot() {},
    async makePreview() { if (state.previewWait) await state.previewWait; return preview; },
    timers: {
      setInterval(callback) { const id = Symbol(); intervals.set(id, callback); return id; },
      clearInterval(id) { intervals.delete(id); },
    },
  });
  function action(action, itemId) {
    const target = new Node(); target.dataset = { marketAction: action, itemId };
    nodes.get('marketDialog').emit('click', target);
  }
  return { nodes, state, calls, filters, action, intervals };
}

test('purchase needs confirmation and a duplicate click cannot send a second request', async t => {
  const { nodes, state, calls, action } = fixture(t);
  await flush();
  action('buy', 'outfit-tide');
  assert.equal(calls.purchases.length, 0);
  assert.equal(nodes.get('marketConfirm').hidden, false);
  const waiting = deferred(); state.purchaseWait = waiting.promise;
  const pending = nodes.get('marketConfirmBuy').emit('click');
  nodes.get('marketConfirmBuy').emit('click');
  assert.deepEqual(calls.purchases, ['outfit-tide']);
  assert.equal(nodes.get('marketBalance').textContent, '3,000', 'no optimistic coin deduction');
  waiting.resolve(); await pending; await flush();
  assert.equal(nodes.get('marketBalance').textContent, '2,550');
  assert.ok(calls.expected.every(id => id === 'account-a'));
});

test('character attributes distinguish try-on projections from confirmed equipped stats', async t => {
  const { nodes, action } = fixture(t);
  const totals = () => nodes.get('marketAttributes').children.map(node => node.children[1].textContent);
  await flush();
  assert.deepEqual(totals(), ['10', '10', '10']);
  action('preview', 'pet-cloud');
  assert.deepEqual(totals(), ['10', '12', '17']);
  assert.equal(nodes.get('marketAttributesMode').textContent, 'Try-on projection');
  nodes.get('marketResetPreview').emit('click');
  assert.deepEqual(totals(), ['10', '10', '10']);
  action('buy', 'outfit-tide'); await nodes.get('marketConfirmBuy').emit('click');
  assert.deepEqual(totals(), ['10', '10', '10'], 'purchasing alone grants no bonus');
  action('equip', 'outfit-tide'); await flush();
  assert.deepEqual(totals(), ['11', '13', '15']);
  action('unequip', 'outfit-tide'); await flush();
  assert.deepEqual(totals(), ['10', '10', '10']);
});

test('try-on does not purchase or change the office character, equip affects only the account owner', async t => {
  const { nodes, calls, action } = fixture(t);
  await flush();
  nodes.get('marketplaceBtn').emit('click'); await flush();
  const before = calls.equipment.length;
  action('preview', 'pet-cloud');
  assert.equal(calls.equipment.length, before);
  assert.equal(calls.purchases.length, 0);
  assert.equal(nodes.get('marketPreviewBadge').textContent, 'Try-on only');
  action('buy', 'outfit-tide'); await nodes.get('marketConfirmBuy').emit('click');
  action('equip', 'outfit-tide'); await flush();
  assert.ok(calls.equipment.every(entry => entry.userId === 'account-a'));
  assert.equal(calls.equipment.at(-1).equipment.outfit, 'outfit-tide');
});

test('mutations are blocked while an account refresh is pending', async t => {
  const { nodes, state, calls, action } = fixture(t);
  await flush();
  const waiting = deferred(); state.accountWait = waiting.promise;
  nodes.get('marketRefresh').emit('click');
  action('buy', 'outfit-tide'); nodes.get('marketConfirmBuy').emit('click');
  assert.equal(calls.purchases.length, 0);
  waiting.resolve({ balance: 3000, inventory: [], equipped: emptyEquipment() }); await flush();
});

test('logout discards late account responses and disposes an asynchronously created preview', async t => {
  const { nodes, state, calls, intervals } = fixture(t);
  await flush();
  const previewWaiting = deferred(); state.previewWait = previewWaiting.promise;
  nodes.get('marketplaceBtn').emit('click'); await flush();
  const accountWaiting = deferred(); state.accountWait = accountWaiting.promise;
  nodes.get('marketRefresh').emit('click');
  stopMarketplace();
  previewWaiting.resolve(); accountWaiting.resolve({ balance: 2550, inventory: ['outfit-tide'], equipped: emptyEquipment() });
  await flush();
  assert.equal(calls.disposes, 1);
  assert.equal(nodes.get('marketDialog').open, false);
  assert.equal(nodes.get('marketBalance').textContent, '—');
  assert.equal(nodes.get('marketGrid').children.length, 0);
  assert.equal(intervals.size, 0);
});

test('missing SQL shows setup instructions instead of a fabricated wallet', async t => {
  const { nodes, state } = fixture(t);
  await flush(); state.setupError = true;
  nodes.get('marketRefresh').emit('click'); await flush();
  assert.match(nodes.get('marketError').textContent, /202611090001_marketplace\.sql/);
  assert.equal(nodes.get('marketError').hidden, false);
});

test('confirmed rewards refresh the wallet and logout removes the listener', async t => {
  const { calls } = fixture(t);
  await flush();
  const before = calls.expected.length;
  window.dispatchEvent(new Event('office-wallet-changed'));
  await flush();
  assert.equal(calls.expected.length, before + 1);
  stopMarketplace();
  window.dispatchEvent(new Event('office-wallet-changed'));
  await flush();
  assert.equal(calls.expected.length, before + 1);
});
