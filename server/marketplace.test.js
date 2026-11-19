import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { makeApi } from './api.js';
import { MARKETPLACE_CATALOG, STARTING_COINS, characterAttributes, emptyEquipment } from '../src/config/marketplace.js';
import { isMissingSchema, marketErrorCode, normalizeState } from './routes/marketplace.js';

const ORIGIN = 'http://localhost:4173';
const PROFILE = { id: '11111111-1111-1111-1111-111111111111', full_name: 'Test Employee', role: 'employee' };
const OTHER = { id: '22222222-2222-2222-2222-222222222222', full_name: 'Other Admin', role: 'super_admin' };
const SESSION = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 };
const JAR = 'officeAccess=test-access; officeRefresh=test-refresh';
const PRICE = Object.fromEntries(MARKETPLACE_CATALOG.map(item => [item.id, item.price]));
const ACCOUNT_HEADER = { 'X-Office-Account': PROFILE.id };

function emptyAccount() {
  return { balance: STARTING_COINS, inventory: [], equipped: emptyEquipment() };
}

function createMarketDb(options = {}) {
  const accounts = new Map();
  const equipmentRows = new Map();
  const profiles = options.profiles || [
    { id: PROFILE.id, role: 'employee', full_name: PROFILE.full_name },
    { id: OTHER.id, role: 'super_admin', full_name: OTHER.full_name },
    { id: '33333333-3333-3333-3333-333333333333', role: 'client', full_name: 'Client' },
  ];
  const catalog = new Map(MARKETPLACE_CATALOG.map(item => [item.id, { ...item }]));
  const calls = { rpc: [], tables: [], rpcArgs: [], sessionTokens: [] };
  let missing = !!options.missingSchema;
  let malformedState = !!options.malformedState;

  function ensure(userId) {
    if (!accounts.has(userId)) accounts.set(userId, emptyAccount());
    if (!equipmentRows.has(userId)) equipmentRows.set(userId, emptyEquipment());
    return accounts.get(userId);
  }

  function snapshot(userId) {
    const account = ensure(userId);
    account.equipped = { ...equipmentRows.get(userId) };
    return {
      balance: account.balance,
      inventory: [...account.inventory],
      equipped: { ...account.equipped },
      attributes: characterAttributes(account.equipped),
    };
  }

  function fail(code) {
    return { data: null, error: { message: code, code: 'P0001' } };
  }

  const db = {
    rpc: async (fn, params = {}) => {
      calls.rpc.push(fn);
      calls.rpcArgs.push({ fn, params });
      if (missing) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.office_market_state' } };
      if (options.permissionError) return { data: null, error: { code: '42501' } };
      if (malformedState) return { data: null, error: null };

      assert.ok(!('p_user_id' in params), 'RPC identity must come from the session');
      const userId = options.sessionUserId || PROFILE.id;

      // the weapons migration adds the _full version (with the weapon); `options.oldAppearances` is a database without it
      if (fn === 'office_market_appearances_full' && options.oldAppearances) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.office_market_appearances_full' } };
      if (fn === 'office_market_appearances' || fn === 'office_market_appearances_full') return {
        data: profiles.filter(p => ['employee', 'super_admin'].includes(p.role)).map(p => {
          const row = { user_id: p.id, ...(equipmentRows.get(p.id) || emptyEquipment()) };
          if (fn === 'office_market_appearances') delete row.weapon;
          return row;
        }),
        error: null,
      };

      if (fn === 'office_market_my_state') return { data: snapshot(userId), error: null };

      if (fn === 'office_market_my_purchase') {
        const itemId = params.p_item_id;
        const expected = params.p_expected_price;
        const item = catalog.get(itemId);
        if (!item) return fail('invalid_item');
        if (expected !== item.price) return fail('catalog_changed');
        const account = ensure(userId);
        if (account.inventory.includes(itemId)) return { data: snapshot(userId), error: null };
        if (account.balance < item.price) return fail('insufficient_funds');
        account.balance -= item.price;
        account.inventory.push(itemId);
        return { data: snapshot(userId), error: null };
      }

      if (fn === 'office_market_my_equip') {
        const slot = params.p_slot;
        const itemId = params.p_item_id ?? null;
        if (!['outfit', 'armor', 'pet'].includes(slot)) return fail('invalid_slot');
        const account = ensure(userId);
        const equipped = equipmentRows.get(userId);
        if (itemId !== null) {
          const item = catalog.get(itemId);
          if (!item) return fail('invalid_item');
          if (item.slot !== slot) return fail('invalid_slot');
          if (!account.inventory.includes(itemId)) return fail('not_owned');
          equipped[slot] = itemId;
        } else {
          equipped[slot] = null;
        }
        return { data: snapshot(userId), error: null };
      }

      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
    from(table) {
      calls.tables.push(table);
      const state = { filters: {}, inValues: null, selectCols: null };
      const query = {
        select(cols) { state.selectCols = cols; return query; },
        eq(column, value) { state.filters[column] = value; return query; },
        in(column, values) { state.inValues = { column, values }; return query; },
        order() { return query; },
        maybeSingle: async () => {
          if (table === 'profiles') {
            const row = profiles.find(p => p.id === (state.filters.id || PROFILE.id)) || null;
            return { data: row ? { id: row.id, full_name: row.full_name, role: row.role } : null, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve().then(async () => {
            if (missing && table === 'office_market_equipment') {
              return { data: null, error: { code: '42P01', message: 'relation "office_market_equipment" does not exist' } };
            }
            if (table === 'profiles') {
              let rows = profiles.map(p => ({ id: p.id, role: p.role, full_name: p.full_name }));
              if (state.filters.role) rows = rows.filter(r => r.role === state.filters.role);
              if (state.inValues?.column === 'role') rows = rows.filter(r => state.inValues.values.includes(r.role));
              return { data: rows, error: null };
            }
            if (table === 'office_market_equipment') {
              let rows = [...equipmentRows.entries()].map(([user_id, eq]) => ({
                user_id, outfit: eq.outfit, armor: eq.armor, pet: eq.pet,
              }));
              if (state.inValues?.column === 'user_id') {
                const allowed = new Set(state.inValues.values);
                rows = rows.filter(r => allowed.has(r.user_id));
              }
              return { data: rows, error: null };
            }
            return { data: [], error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };

  return {
    db,
    calls,
    accounts,
    equipmentRows,
    ensure,
    snapshot,
    catalog,
    setMissing(value) { missing = value; },
    PRICE,
  };
}

async function fixture(t, options = {}) {
  const market = createMarketDb(options);
  if (options.seedEquipment) {
    for (const [userId, eq] of Object.entries(options.seedEquipment)) {
      market.ensure(userId);
      market.equipmentRows.set(userId, { ...emptyEquipment(), ...eq });
    }
  }
  const clientFactory = () => ({
    auth: {
      signInWithPassword: async () => ({ data: { session: SESSION }, error: null }),
      getUser: async token => ({
        data: { user: token === 'test-access' ? { id: options.sessionUserId || PROFILE.id } : null },
        error: token === 'test-access' ? null : { status: 401 },
      }),
      refreshSession: async () => ({ data: { session: SESSION }, error: null }),
      admin: { signOut: async () => ({ error: null }) },
    },
  });
  const app = express();
  app.use('/api', makeApi({ APP_ORIGIN: ORIGIN }, {
    db: { ...market.db, rpc() { throw new Error('Marketplace must not use the shared office client'); } },
    clientFactory,
    marketplaceClientFactory: token => {
      market.calls.sessionTokens.push(token);
      assert.equal(token, SESSION.access_token);
      return market.db;
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = (path, init = {}) => fetch(url + path, init);
  const authed = (path, init = {}) => request(path, {
    ...init,
    headers: {
      Origin: ORIGIN,
      Cookie: JAR,
      ...ACCOUNT_HEADER,
      ...(init.headers || {}),
    },
  });
  const json = (path, body, method = 'POST') => authed(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(arguments[3] || {}) },
    body: JSON.stringify(body),
  });
  // Allow header overrides on JSON posts without breaking call sites.
  const jsonWith = (path, body, headers = {}, method = 'POST') => authed(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { ...market, request, authed, json, jsonWith, url };
}

test('normalize helpers reject malformed state and detect missing schema', () => {
  assert.deepEqual(normalizeState({ balance: 3000, inventory: ['outfit-tide', 'outfit-tide'], equipped: { outfit: 'outfit-tide' } }), {
    balance: 3000,
    inventory: ['outfit-tide'],
    equipped: { outfit: 'outfit-tide', armor: null, pet: null, weapon: null },
  });
  assert.throws(() => normalizeState(null), /invalid_state/);
  assert.throws(() => normalizeState({ balance: 0 }), /invalid_state/); // incomplete payload
  assert.throws(() => normalizeState({ balance: -1, inventory: [], equipped: {} }), /invalid_state/);
  assert.throws(() => normalizeState({ balance: null, inventory: [], equipped: {} }), /invalid_state/);
  assert.throws(() => normalizeState({ balance: '3000', inventory: [], equipped: {} }), /invalid_state/);
  assert.deepEqual(normalizeState({ balance: 0, inventory: [], equipped: {} }), {
    balance: 0, inventory: [], equipped: emptyEquipment(),
  });
  assert.equal(isMissingSchema({ code: 'PGRST202', message: 'Could not find the function' }), true);
  assert.equal(marketErrorCode({ message: 'insufficient_funds' }), 'insufficient_funds');
  assert.equal(marketErrorCode({ message: 'catalog_changed' }), 'catalog_changed');
  assert.equal(marketErrorCode({ message: 'boom' }), null);
});

test('attributes come from equipped gear, not purchased inventory or client totals', async t => {
  const { json, authed } = await fixture(t);
  const purchased = await json('/marketplace/purchase', { itemId: 'pet-cloud' });
  assert.deepEqual((await purchased.json()).attributes.total, { strength: 10, agility: 10, intelligence: 10 });
  const forged = await json('/marketplace/equip', { slot: 'pet', itemId: 'pet-cloud', attributes: { strength: 9999 } });
  assert.equal(forged.status, 400);
  const equipped = await json('/marketplace/equip', { slot: 'pet', itemId: 'pet-cloud' });
  assert.deepEqual((await equipped.json()).attributes.total, { strength: 10, agility: 12, intelligence: 17 });
  const restored = await authed('/marketplace');
  assert.deepEqual((await restored.json()).attributes.total, { strength: 10, agility: 12, intelligence: 17 });
  const removed = await json('/marketplace/equip', { slot: 'pet', itemId: null });
  assert.deepEqual((await removed.json()).attributes.total, { strength: 10, agility: 10, intelligence: 10 });
});

test('GET /marketplace initializes welcome balance once and stays no-store', async t => {
  const { authed, snapshot } = await fixture(t);
  const res = await authed('/marketplace');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body, snapshot(PROFILE.id));
  assert.equal(body.balance, STARTING_COINS);
  const again = await authed('/marketplace');
  assert.deepEqual(await again.json(), { balance: STARTING_COINS, inventory: [], equipped: emptyEquipment(), attributes: characterAttributes(null) });
});

test('purchase uses session identity and server catalog price; rejects extraneous fields', async t => {
  const { json, calls, snapshot } = await fixture(t);
  const forged = await json('/marketplace/purchase', {
    itemId: 'outfit-tide',
    userId: OTHER.id,
    price: 1,
    balance: 999999,
  });
  assert.equal(forged.status, 400);
  assert.deepEqual(await forged.json(), {
    error: 'Invalid marketplace request.',
    code: 'invalid_request',
  });

  const res = await json('/marketplace/purchase', { itemId: 'outfit-tide' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.balance, STARTING_COINS - PRICE['outfit-tide']);
  assert.deepEqual(body.inventory, ['outfit-tide']);
  assert.ok(!('p_user_id' in calls.rpcArgs.at(-1).params));
  assert.equal(calls.rpcArgs.at(-1).params.p_item_id, 'outfit-tide');
  assert.equal(calls.rpcArgs.at(-1).params.p_expected_price, PRICE['outfit-tide']);
  assert.equal(snapshot(OTHER.id).balance, STARTING_COINS);
  assert.deepEqual(snapshot(OTHER.id).inventory, []);
});

test('X-Office-Account must match session; mismatch and missing never call RPC', async t => {
  const { authed, jsonWith, request, calls } = await fixture(t);
  calls.rpc.length = 0;

  const missing = await request('/marketplace', {
    headers: { Origin: ORIGIN, Cookie: JAR },
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'invalid_request');

  const mismatchGet = await authed('/marketplace', { headers: { 'X-Office-Account': OTHER.id } });
  assert.equal(mismatchGet.status, 409);
  assert.deepEqual(await mismatchGet.json(), {
    error: 'Signed-in account changed. Reload and try again.',
    code: 'account_changed',
  });

  const mismatchBuy = await jsonWith('/marketplace/purchase', { itemId: 'outfit-tide' }, { 'X-Office-Account': OTHER.id });
  assert.equal(mismatchBuy.status, 409);
  assert.equal((await mismatchBuy.json()).code, 'account_changed');

  const mismatchEquip = await jsonWith('/marketplace/equip', { slot: 'pet', itemId: null }, { 'X-Office-Account': OTHER.id });
  assert.equal(mismatchEquip.status, 409);
  assert.equal((await mismatchEquip.json()).code, 'account_changed');

  // Public equipment list does not require the account header.
  const equipment = await request('/marketplace/equipment', {
    headers: { Origin: ORIGIN, Cookie: JAR },
  });
  assert.equal(equipment.status, 200);

  assert.deepEqual(calls.rpc, ['office_market_appearances_full']);
});

test('catalog_changed when DB price diverges from shared catalog expected price', async t => {
  const { json, catalog } = await fixture(t);
  catalog.get('outfit-tide').price = 9999;
  const res = await json('/marketplace/purchase', { itemId: 'outfit-tide' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'catalog_changed');
});

test('duplicate purchase is idempotent and does not double-charge', async t => {
  const { json } = await fixture(t);
  const first = await json('/marketplace/purchase', { itemId: 'pet-sprout' });
  const second = await json('/marketplace/purchase', { itemId: 'pet-sprout' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const a = await first.json();
  const b = await second.json();
  assert.deepEqual(a, b);
  assert.equal(a.balance, STARTING_COINS - PRICE['pet-sprout']);
  assert.deepEqual(a.inventory, ['pet-sprout']);
});

test('insufficient funds and invalid item return stable codes', async t => {
  const { json, ensure } = await fixture(t);
  ensure(PROFILE.id).balance = 10;
  const poor = await json('/marketplace/purchase', { itemId: 'armor-solar' });
  assert.equal(poor.status, 400);
  assert.deepEqual(await poor.json(), {
    error: 'Not enough coins for this purchase.',
    code: 'insufficient_funds',
  });
  const bad = await json('/marketplace/purchase', { itemId: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'invalid_item');
});

test('equip requires ownership and matching slot; null unequips; rejects extras', async t => {
  const { json } = await fixture(t);
  assert.equal((await json('/marketplace/equip', { slot: 'pet', itemId: 'pet-cloud', userId: OTHER.id })).status, 400);
  assert.equal((await (await json('/marketplace/equip', { slot: 'pet', itemId: 'pet-cloud', userId: OTHER.id })).json()).code, 'invalid_request');

  assert.equal((await json('/marketplace/equip', { slot: 'pet', itemId: 'pet-cloud' })).status, 400);
  assert.equal((await (await json('/marketplace/equip', { slot: 'pet', itemId: 'pet-cloud' })).json()).code, 'not_owned');

  await json('/marketplace/purchase', { itemId: 'pet-cloud' });
  const wrongSlot = await json('/marketplace/equip', { slot: 'armor', itemId: 'pet-cloud' });
  assert.equal(wrongSlot.status, 400);
  assert.equal((await wrongSlot.json()).code, 'invalid_slot');

  const equipped = await json('/marketplace/equip', { slot: 'pet', itemId: 'pet-cloud' });
  assert.equal(equipped.status, 200);
  assert.deepEqual((await equipped.json()).equipped, { outfit: null, armor: null, pet: 'pet-cloud', weapon: null });

  const cleared = await json('/marketplace/equip', { slot: 'pet', itemId: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).equipped.pet, null);

  const badSlot = await json('/marketplace/equip', { slot: 'weapon', itemId: null });
  assert.equal(badSlot.status, 400);
  assert.equal((await badSlot.json()).code, 'invalid_slot');
});

test('GET /marketplace/equipment returns appearance only for employee/super_admin without wallet init', async t => {
  const { authed, accounts, calls } = await fixture(t, {
    seedEquipment: {
      [OTHER.id]: { outfit: 'outfit-ember', armor: null, pet: 'pet-sprout' },
    },
  });
  accounts.delete(OTHER.id);
  accounts.delete(PROFILE.id);

  const res = await authed('/marketplace/equipment');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(calls.rpc, ['office_market_appearances_full']);
  assert.equal(accounts.size, 0);
  assert.ok(!body.equipment.some(row => row.userId === '33333333-3333-3333-3333-333333333333'));
  assert.deepEqual(body.equipment.find(row => row.userId === OTHER.id), {
    userId: OTHER.id,
    equipped: { outfit: 'outfit-ember', armor: null, pet: 'pet-sprout', weapon: null },
  });
  assert.deepEqual(body.equipment.find(row => row.userId === PROFILE.id), {
    userId: PROFILE.id,
    equipped: emptyEquipment(),
  });
  assert.ok(body.equipment.every(row => !('inventory' in row) && !('balance' in row) && !('wallet' in row)));
});

test('missing schema and malformed RPC state return stable 503 codes without breaking session', async t => {
  const missing = await fixture(t, { missingSchema: true });
  const session = await missing.authed('/auth/session');
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { profile: PROFILE });

  for (const path of ['/marketplace', '/marketplace/equipment']) {
    const res = await missing.authed(path);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: 'Marketplace setup is required. Run the Marketplace SQL migrations, including the session-access update.',
      code: 'setup_required',
    });
  }
  assert.equal((await missing.json('/marketplace/purchase', { itemId: 'outfit-tide' })).status, 503);
  assert.equal((await missing.request('/marketplace')).status, 401);

  const badState = await fixture(t, { malformedState: true });
  const res = await badState.authed('/marketplace');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    error: 'Marketplace is temporarily unavailable.',
    code: 'service_unavailable',
  });
});

test('marketplace routes reject unauthenticated access before rpc', async t => {
  const { request, calls } = await fixture(t);
  for (const path of ['/marketplace', '/marketplace/equipment']) {
    const res = await request(path);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls.rpc, []);
  assert.deepEqual(calls.sessionTokens, []);
});

test('Marketplace ignores Authorization headers and propagates verified and refreshed cookie tokens', async t => {
  const { authed, calls } = await fixture(t);
  for (const headers of [
    { Authorization: 'Bearer attacker-token' },
    { Cookie: 'officeAccess=expired; officeRefresh=test-refresh' },
  ]) {
    const res = await authed('/marketplace', { headers });
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(await res.json()).includes(SESSION.access_token), false);
  }
  assert.deepEqual(calls.sessionTokens, [SESSION.access_token, SESSION.access_token]);
  assert.deepEqual(calls.rpcArgs, [
    { fn: 'office_market_my_state', params: {} },
    { fn: 'office_market_my_state', params: {} },
  ]);
});

test('permission errors explain the SQL setup rather than a temporary outage', async t => {
  const { authed } = await fixture(t, { permissionError: true });
  const res = await authed('/marketplace');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'setup_required');
  assert.match(body.error, /session-access update/);
});

test('another signed-in account uses its own Marketplace state', async t => {
  const { authed, jsonWith, accounts } = await fixture(t, { sessionUserId: OTHER.id });
  const res = await jsonWith('/marketplace/purchase', { itemId: 'pet-cloud' }, { 'X-Office-Account': OTHER.id });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).inventory, ['pet-cloud']);
  assert.equal(accounts.has(PROFILE.id), false);
  const stale = await authed('/marketplace');
  assert.equal(stale.status, 409);
});

test('shared catalog seed contract used by SQL matches runtime exports', () => {
  assert.equal(STARTING_COINS, 3000);
  assert.deepEqual(
    MARKETPLACE_CATALOG.map(({ id, slot, price }) => ({ id, slot, price })),
    [
      { id: 'outfit-tide', slot: 'outfit', price: 450 },
      { id: 'outfit-ember', slot: 'outfit', price: 600 },
      { id: 'armor-sentinel', slot: 'armor', price: 900 },
      { id: 'armor-solar', slot: 'armor', price: 1200 },
      { id: 'pet-sprout', slot: 'pet', price: 700 },
      { id: 'pet-cloud', slot: 'pet', price: 1000 },
      { id: 'outfit-hoodie', slot: 'outfit', price: 300 },
      { id: 'outfit-track', slot: 'outfit', price: 650 },
      { id: 'outfit-suit', slot: 'outfit', price: 750 },
      { id: 'armor-vest', slot: 'armor', price: 650 },
      { id: 'armor-circuit', slot: 'armor', price: 1300 },
      { id: 'armor-obsidian', slot: 'armor', price: 1400 },
      { id: 'pet-cat', slot: 'pet', price: 550 },
      { id: 'pet-drone', slot: 'pet', price: 950 },
      { id: 'pet-ember', slot: 'pet', price: 900 },
      { id: 'weapon-katana', slot: 'weapon', price: 1800 },
      { id: 'weapon-staff', slot: 'weapon', price: 2200 },
      { id: 'weapon-hammer', slot: 'weapon', price: 2400 },
      { id: 'weapon-greatsword', slot: 'weapon', price: 2600 },
      { id: 'weapon-pistol', slot: 'weapon', price: 2800 },
      { id: 'weapon-rifle', slot: 'weapon', price: 4000 },
    ],
  );
});

test('appearances fall back to the original function before the weapons migration', async t => {
  const { request, calls } = await fixture(t, { oldAppearances: true });
  const res = await request('/marketplace/equipment', { headers: { Origin: ORIGIN, Cookie: JAR } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.rpc, ['office_market_appearances_full', 'office_market_appearances']);
  assert.ok((await res.json()).equipment.every(row => row.equipped.weapon === null));
});
