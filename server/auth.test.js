import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { makeApi } from './api.js';

const ORIGIN = 'http://localhost:4173';
const PROFILE = { id: 'test-user', full_name: 'Test Employee', role: 'employee' };
const SESSION = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 };
const LOGIN = { email: 'employee@example.test', password: 'test-only-password' };
const JAR = 'officeAccess=test-access; officeRefresh=test-refresh';

async function fixture(t, options = {}) {
  let time = 1000;
  const calls = { clients: 0, refresh: 0, login: 0, signOut: 0, tables: [], tokens: [] };
  const state = { profile: PROFILE, ...options };
  const db = {
    // Deliberately no db.auth: signing into the privileged singleton would fail these tests.
    from(table) {
      calls.tables.push(table);
      const query = {
        select() { return query; }, eq() { return query; },
        maybeSingle: async () => {
          if (table === 'employees') return { data: state.employee, error: state.employeeError };
          await state.profileWait?.();
          return { data: state.profile, error: state.profileError };
        },
        order: async () => ({ data: [PROFILE], error: null }),
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
      };
      return query;
    },
  };
  const clientFactory = () => {
    calls.clients++;
    return { auth: {
      signInWithPassword: async () => {
        calls.login++;
        return {
          data: state.badLogin || state.loginError || state.missingSession ? null : { session: SESSION },
          error: state.loginError || (state.badLogin ? { code: 'invalid_credentials', status: 400, message: 'private detail' } : null),
        };
      },
      getUser: async token => {
        calls.tokens.push(token);
        return { data: { user: token === 'test-access' && !state.invalidAccess ? { id: PROFILE.id } : null }, error: token !== 'test-access' || state.invalidAccess ? { status: 401 } : null };
      },
      refreshSession: async () => {
        calls.refresh++;
        await new Promise(resolve => setTimeout(resolve, 15));
        return state.badRefresh ? { data: null, error: { status: 401 } } : { data: { session: SESSION }, error: null };
      },
      admin: { signOut: async () => { calls.signOut++; return { error: state.logoutError }; } },
    } };
  };
  const app = express();
  app.use('/api', state.unconfigured ? makeApi({}) : makeApi({ APP_ORIGIN: ORIGIN, ...state.env }, { db, clientFactory, now: () => time }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = (path, init = {}) => fetch(url + path, init);
  const login = (headers = {}) => request('/auth/login', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(LOGIN),
  });
  return { calls, login, request, state, advance: ms => { time += ms; } };
}

test('login returns only the verified allowed profile, not tokens, with HttpOnly cookies', async t => {
  const { login, calls } = await fixture(t);
  const res = await login();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { profile: PROFILE });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const jar = res.headers.getSetCookie();
  assert.equal(jar.length, 2);
  for (const value of jar) {
    assert.match(value, /HttpOnly/); assert.match(value, /SameSite=Lax/); assert.match(value, /Path=\/api/);
    assert.doesNotMatch(value, /Secure/);
  }
  assert.deepEqual(calls.tokens, ['test-access']);
  assert.deepEqual(calls.tables, ['profiles']);
});

test('login and session use the full employee name when a profile contains only a first name', async t => {
  const { login, request } = await fixture(t, {
    profile: { ...PROFILE, full_name: 'Alex' },
    employee: { first_name: 'Alex', last_name: 'Morgan' },
  });
  for (const res of [await login(), await request('/auth/session', { headers: { Cookie: JAR } })]) {
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { profile: { ...PROFILE, full_name: 'Alex Morgan' } });
  }
});

test('an unavailable employee name does not change access or invent a surname', async t => {
  const { login } = await fixture(t, {
    profile: { ...PROFILE, full_name: 'Alex' },
    employeeError: { code: '42P01' },
  });
  const res = await login();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).profile.full_name, 'Alex');
});

test('logout with only a refresh cookie revokes the renewed current session', async t => {
  const { request, calls } = await fixture(t);
  const res = await request('/auth/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: 'officeRefresh=old-refresh' } });
  assert.equal(res.status, 204);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.signOut, 1);
  res.headers.getSetCookie().forEach(value => assert.match(value, /Expires=Thu, 01 Jan 1970/));
});

test('logout invalidates an overlapping rotated refresh before it can write cookies', async t => {
  let release, signal;
  const waiting = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { signal = resolve; });
  const { request } = await fixture(t, { profileWait: async () => { signal(); await waiting; } });
  const pending = request('/auth/session', { headers: { Cookie: 'officeRefresh=old-refresh' } });
  await reached;
  const logout = await request('/auth/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: JAR } });
  assert.equal(logout.status, 204);
  release();
  const res = await pending;
  assert.equal(res.status, 401);
  res.headers.getSetCookie().forEach(value => assert.match(value, /Expires=Thu, 01 Jan 1970/));
});

test('missing Supabase configuration leaves health public but auth and data unavailable', async t => {
  const { request, login, calls } = await fixture(t, { unconfigured: true });
  assert.equal((await request('/health')).status, 200);
  for (const path of ['/auth/session', '/employees', '/attendance']) assert.equal((await request(path)).status, 503);
  assert.equal((await login()).status, 503);
  assert.equal(calls.clients, 0);
});

test('production without APP_ORIGIN fails closed on login', async t => {
  const { login } = await fixture(t, { env: { APP_ORIGIN: undefined, NODE_ENV: 'production' } });
  assert.equal((await login()).status, 403);
});

test('more than ten distinct employees can log in behind a shared proxy', async t => {
  const { request } = await fixture(t);
  for (let i = 0; i < 12; i++) {
    const res = await request('/auth/login', {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...LOGIN, email: `employee-${i}@example.test` }),
    });
    assert.equal(res.status, 200);
  }
});

test('production cookies remain Secure behind a proxy and explicit origin is required', async t => {
  const f = await fixture(t, { env: { NODE_ENV: 'production', APP_ORIGIN: 'https://office.example.test' } });
  assert.equal((await f.login()).status, 403);
  const res = await f.login({ Origin: 'https://office.example.test' });
  assert.equal(res.status, 200);
  res.headers.getSetCookie().forEach(value => assert.match(value, /Secure/));
  const forged = await f.login({ Origin: 'https://attacker.example.test', Host: 'attacker.example.test', 'X-Forwarded-Host': 'attacker.example.test' });
  assert.equal(forged.status, 403);
});

test('invalid credentials do not leak Supabase error details or cookies', async t => {
  const { login } = await fixture(t, { badLogin: true });
  const res = await login();
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Email or password is incorrect.' });
  res.headers.getSetCookie().forEach(value => assert.match(value, /Expires=Thu, 01 Jan 1970/));
});

test('invalid project keys are configuration failures, not incorrect account passwords', async t => {
  for (const loginError of [
    { status: 401, message: 'private provider detail' },
    { status: 403, message: 'private provider detail' },
    { status: 400, code: 'invalid_api_key', message: 'private provider detail' },
  ]) {
    const { login, calls } = await fixture(t, { loginError });
    const res = await login();
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'auth_configuration_error');
    assert.match(body.error, /same project/);
    assert.doesNotMatch(JSON.stringify(body), /private provider detail|password is incorrect/);
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.deepEqual(calls.tokens, []);
    assert.deepEqual(calls.tables, []);
  }
});

test('provider outages, rate limits, and missing sessions do not blame account credentials', async t => {
  for (const [options, expected] of [
    [{ loginError: { status: 503, message: 'private provider detail' } }, 503],
    [{ loginError: { status: 0, name: 'AuthRetryableFetchError' } }, 503],
    [{ loginError: { status: 429 } }, 429],
    [{ missingSession: true }, 503],
  ]) {
    const { login } = await fixture(t, options);
    const res = await login();
    assert.equal(res.status, expected);
    const body = await res.json();
    assert.doesNotMatch(JSON.stringify(body), /password is incorrect|private provider detail/);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
});

test('missing and disallowed profiles are rejected; super_admin is supported', async t => {
  for (const profile of [null, { ...PROFILE, role: 'client' }, { ...PROFILE, role: 'super_admin' }]) {
    const { login } = await fixture(t, { profile });
    const res = await login();
    assert.equal(res.status, profile?.role === 'super_admin' ? 200 : 403);
  }
});

test('profile database errors fail closed without leaking details', async t => {
  const { login } = await fixture(t, { profileError: { message: 'private database detail' } });
  const res = await login();
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Service temporarily unavailable.' });
});

test('all employee and attendance routes reject unauthenticated access before querying data', async t => {
  const { request, calls } = await fixture(t);
  for (const path of ['/employees', '/attendance', '/attendance/summary', '/auth/session']) {
    const res = await request(path);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls.tables, []);
});

test('valid access token is verified first and never needlessly refreshed', async t => {
  const { request, calls } = await fixture(t);
  for (const path of ['/employees', '/attendance', '/attendance/summary', '/auth/session']) {
    const res = await request(path, { headers: { Cookie: JAR } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.refresh, 0);
  assert.equal(calls.clients, 4);
});

test('expired access refreshes once for concurrent requests and verifies refreshed identity', async t => {
  const { request, calls } = await fixture(t);
  const responses = await Promise.all(['/employees', '/attendance', '/auth/session'].map(path =>
    request(path, { headers: { Cookie: 'officeAccess=expired; officeRefresh=old-refresh' } })));
  assert.equal(calls.refresh, 1);
  responses.forEach(res => { assert.equal(res.status, 200); assert.equal(res.headers.getSetCookie().length, 2); });
  assert.equal(calls.tokens.filter(token => token === 'test-access').length, 3);
});

test('refresh failure and unverifiable refreshed user clear cookies and deny access', async t => {
  for (const state of [{ badRefresh: true }, { invalidAccess: true }]) {
    const { request } = await fixture(t, state);
    const res = await request('/auth/session', { headers: { Cookie: 'officeRefresh=old-refresh' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.getSetCookie().length, 2);
  }
});

test('logout revokes only this session and clears cookies without requiring a valid profile', async t => {
  const { request, calls } = await fixture(t, { profile: null });
  const res = await request('/auth/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: JAR } });
  assert.equal(res.status, 204);
  assert.equal(calls.signOut, 1);
  assert.equal(calls.tables.length, 0);
  res.headers.getSetCookie().forEach(value => assert.match(value, /Expires=Thu, 01 Jan 1970/));
});

test('logout revocation failures still clear browser cookies', async t => {
  const { request } = await fixture(t, { logoutError: { status: 503 } });
  const res = await request('/auth/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: JAR } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.getSetCookie().length, 2);
});

test('mutations require origin and login requires bounded JSON credentials', async t => {
  const { request, login, calls } = await fixture(t);
  assert.equal((await login({ Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await login({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/auth/logout', { method: 'POST' })).status, 403);
  assert.equal((await request('/auth/login', { method: 'POST', headers: { Origin: ORIGIN }, body: 'not json' })).status, 415);
  assert.equal((await request('/auth/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal(calls.login, 0);
});

test('login is rate limited, ignores forged forwarding headers and resets after a minute', async t => {
  const { login, advance } = await fixture(t, { badLogin: true });
  for (let i = 0; i < 10; i++) assert.equal((await login({ 'X-Forwarded-For': `192.0.2.${i}` })).status, 401);
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  advance(60001);
  assert.equal((await login()).status, 401);
});

test('unconfirmed password_changed schema is not guessed or required for normal profiles', async t => {
  const { login, calls } = await fixture(t);
  assert.equal((await login()).status, 200);
  assert.ok(calls.tables.every(table => table === 'profiles'));
});
