import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { makeApi } from './api.js';

const ORIGIN = 'http://localhost:4173', ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JAR = 'officeAccess=good';

async function fixture(t, { missingTable = false } = {}) {
  const looks = new Map(), profiles = [{ id: ME, full_name: 'Ana Reyes', role: 'employee' }, { id: OTHER, full_name: 'Ben Cruz', role: 'employee' }];
  const db = { from(table) {
    let rows = table === 'profiles' ? [...profiles] : table === 'office_character_looks' ? [...looks.entries()].map(([user_id, spec]) => ({ user_id, spec })) : [];
    const missing = { code: '42P01', message: 'relation "office_character_looks" does not exist' };
    const q = {
      select() { return q; }, eq(c, v) { rows = rows.filter(r => r[c] === v); return q; }, order() { return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      upsert: async row => { if (missingTable) return { error: missing }; looks.set(row.user_id, row.spec); return { error: null }; },
      then(ok, bad) { return Promise.resolve(table === 'office_character_looks' && missingTable ? { data: null, error: missing } : { data: rows, error: null }).then(ok, bad); },
    };
    return q;
  } };
  const clientFactory = () => ({ auth: { getUser: async token => (token === 'good' ? { data: { user: { id: ME } }, error: null } : { data: null, error: { status: 401 } }) } });
  const app = express(); app.use('/api', makeApi({ APP_ORIGIN: ORIGIN }, { db, clientFactory }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const put = (body, cookie = JAR) => fetch(url + '/characters/me', { method: 'PUT', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const employees = () => fetch(url + '/employees', { headers: { Cookie: JAR } }).then(r => r.json());
  return { looks, put, employees };
}

test('saving needs a signed-in session', async t => {
  const f = await fixture(t);
  assert.equal((await f.put({ spec: { body: 'female' } }, 'officeAccess=bad')).status, 401);
  assert.equal(f.looks.size, 0);
});

test('you save only your own look, cleaned; it comes back in the staff list', async t => {
  const f = await fixture(t);
  const res = await f.put({ spec: { type: 'chibi', body: 'female', hair: { style: 'long', color: '#2b1b14' }, top: { style: 'dress', color: '#47a9ac' }, skin: 'not a colour' } });
  assert.equal(res.status, 200);
  const { spec } = await res.json();
  assert.deepEqual([spec.body, spec.hair.style, spec.top.style], ['female', 'long', 'dress']);
  assert.match(spec.skin, /^#[0-9a-f]{6}$/, 'a bad colour is replaced');
  assert.deepEqual([...f.looks.keys()], [ME], 'saved under the session account only');
  const staff = await f.employees();
  assert.equal(staff.find(e => e.userId === ME).character.body, 'female');
  assert.equal(staff.find(e => e.userId === OTHER).character, null);
});

test("someone else's account cannot be named, and odd requests are refused", async t => {
  const f = await fixture(t);
  assert.equal((await f.put({ spec: { body: 'male' }, userId: OTHER })).status, 400);
  assert.equal((await f.put({ spec: 'female' })).status, 400);
  assert.equal((await f.put([])).status, 400);
  assert.equal(f.looks.size, 0);
});

test('before the migration: a clear setup message, and the staff list still works', async t => {
  const f = await fixture(t, { missingTable: true });
  const res = await f.put({ spec: { body: 'female' } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'setup_required');
  assert.equal((await f.employees()).length, 2);
});
