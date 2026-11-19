import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { fetchEmployees } from '../persistence/store.js';
import { initAuth } from './auth.js';

const PROFILE = { id: 'test-user', full_name: 'Test Employee', role: 'employee' };

function element(hidden = false) {
  const listeners = new Map();
  return {
    hidden, inert: hidden, value: '', textContent: '', disabled: false, type: 'password', attributes: {},
    addEventListener(name, callback) { listeners.set(name, callback); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    emit(name) { return listeners.get(name)?.({ preventDefault() {} }); },
  };
}

function fixture(t, initial = {}) {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  const elements = Object.fromEntries(['authGate', 'officeApp', 'loginForm', 'authStatus', 'loginError', 'loginPassword', 'passwordToggle', 'retryLogout', 'loginSubmit', 'accountName', 'loginEmail', 'signOut']
    .map(id => [id, element(['officeApp', 'loginForm', 'retryLogout'].includes(id))]));
  globalThis.document = { getElementById: id => elements[id] };
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  const calls = { requests: [], imports: 0, starts: 0, stops: 0, reloads: 0 };
  const state = { ...initial }, intervals = new Map();
  const timers = {
    setInterval(callback) { const id = Symbol(); intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  window.setInterval = function(callback, delay) {
    assert.equal(this, window, 'browser timers require the Window receiver');
    return timers.setInterval(callback, delay);
  };
  window.clearInterval = function(id) {
    assert.equal(this, window, 'browser timers require the Window receiver');
    timers.clearInterval(id);
  };
  const request = async (path, body) => {
    calls.requests.push({ path, body });
    if (path === 'session' && state.pending) return state.pending;
    if (path === 'session' && !state.signedIn) throw new Error('Please sign in again.');
    if (path === 'login' && state.badLogin) throw new Error('Email or password is incorrect.');
    if (path === 'logout' && state.logoutError) throw new Error('Offline');
    if (path === 'logout') { state.signedIn = false; return {}; }
    return { profile: state.profile ?? PROFILE };
  };
  initAuth({
    request,
    loadOffice: async () => {
      calls.imports++;
      return {
        initOffice: async isCurrent => { if (isCurrent()) calls.starts++; if (state.sceneError) throw new Error('No roster'); },
        stopOffice: () => { calls.stops++; },
      };
    },
    reload: () => { calls.reloads++; },
    ...(initial.browserTimers ? {} : { timers }),
  });
  return { calls, elements, intervals, state };
}

async function flush() { await setImmediate(); }

test('a different account in another tab clears the old office and reloads before interaction', async t => {
  const { state, calls, elements, intervals } = fixture(t, { signedIn: true });
  await flush();
  state.profile = { ...PROFILE, id: 'another-account' };
  await [...intervals.values()][0]();
  assert.equal(elements.officeApp.hidden, true);
  assert.equal(calls.reloads, 1);
  assert.ok(calls.stops >= 1);
});

test('an account-bound Marketplace mismatch clears and reloads the old authenticated scene', async t => {
  const { calls, elements } = fixture(t, { signedIn: true });
  await flush();
  window.dispatchEvent(new Event('office-account-changed'));
  assert.equal(elements.officeApp.hidden, true);
  assert.equal(calls.reloads, 1);
});

test('default timer adapters preserve the browser Window receiver during login and session polling', async t => {
  const { calls, elements, intervals } = fixture(t, { browserTimers: true });
  await flush();
  assert.equal(elements.loginForm.hidden, false);
  await elements.loginForm.emit('submit');
  assert.equal(calls.starts, 1);
  assert.equal(intervals.size, 1);
  await elements.signOut.emit('click');
  assert.equal(elements.loginForm.hidden, false);
  assert.equal(intervals.size, 0);
});

test('no office imports or employee calls occur while session restoration is pending or denied', async t => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const { calls, elements } = fixture(t, { pending });
  assert.equal(calls.imports, 0);
  assert.deepEqual(calls.requests.map(item => item.path), ['session']);
  assert.equal(elements.officeApp.hidden, true);
  reject(new Error('Please sign in again.'));
  await flush();
  assert.equal(calls.imports, 0);
  assert.equal(elements.loginForm.hidden, false);
  assert.equal(elements.loginEmail.focused, true);
});

test('failed login stays recoverable, masks and clears password, and never loads scene', async t => {
  const { calls, elements } = fixture(t, { badLogin: true });
  await flush();
  elements.loginPassword.value = 'test-only-password';
  elements.loginPassword.type = 'text';
  await elements.loginForm.emit('submit');
  assert.equal(calls.imports, 0);
  assert.match(elements.loginError.textContent, /incorrect/);
  assert.equal(elements.loginPassword.value, '');
  assert.equal(elements.loginPassword.type, 'password');
  assert.equal(elements.passwordToggle.attributes['aria-pressed'], 'false');
  assert.equal(elements.loginSubmit.disabled, false);
});

test('successful login dynamically starts office after auth and displays verified name', async t => {
  const { calls, elements } = fixture(t);
  await flush();
  await elements.loginForm.emit('submit');
  assert.deepEqual(calls.requests.map(item => item.path), ['session', 'login']);
  assert.equal(calls.imports, 1);
  assert.equal(calls.starts, 1);
  assert.equal(elements.authGate.hidden, true);
  assert.equal(elements.officeApp.hidden, false);
  assert.equal(elements.accountName.textContent, PROFILE.full_name);
});

test('restored session enters once and sign out clears scene, account and polling', async t => {
  const { calls, elements, intervals } = fixture(t, { signedIn: true });
  await flush();
  assert.equal(calls.starts, 1);
  assert.equal(intervals.size, 1);
  await elements.signOut.emit('click');
  assert.ok(calls.stops >= 1);
  assert.equal(elements.officeApp.hidden, true);
  assert.equal(elements.officeApp.inert, true);
  assert.equal(elements.accountName.textContent, '');
  assert.equal(intervals.size, 0);
  assert.equal(calls.requests.at(-1).path, 'logout');
  await elements.loginForm.emit('submit');
  assert.equal(calls.reloads, 1);
  assert.equal(calls.imports, 1);
});

test('failed session revalidation clears the office and requests login', async t => {
  const { state, calls, elements, intervals } = fixture(t, { signedIn: true });
  await flush();
  state.signedIn = false;
  await [...intervals.values()][0]();
  assert.equal(elements.officeApp.hidden, true);
  assert.equal(elements.loginForm.hidden, false);
  assert.match(elements.loginError.textContent, /session/);
  assert.ok(calls.stops >= 1);
});

test('protected-data session loss clears the scene and scene failures never reveal office', async t => {
  const { calls, elements } = fixture(t, { signedIn: true });
  await flush();
  window.dispatchEvent(new Event('office-auth-lost'));
  assert.equal(elements.officeApp.hidden, true);
  assert.ok(calls.stops >= 1);
  assert.match(elements.loginError.textContent, /session has ended/);
});

test('scene startup failure returns to login rather than presenting fallback staff', async t => {
  const { calls, elements } = fixture(t, { signedIn: true, sceneError: true });
  await flush();
  assert.equal(elements.officeApp.hidden, true);
  assert.equal(elements.authGate.hidden, false);
  assert.match(elements.loginError.textContent, /office could not load/);
  assert.ok(calls.stops >= 1);
});

test('sign-out network failure offers an accessible retry and keeps office hidden', async t => {
  const { state, elements } = fixture(t, { signedIn: true, logoutError: true });
  await flush();
  await elements.signOut.emit('click');
  assert.equal(elements.officeApp.hidden, true);
  assert.equal(elements.retryLogout.hidden, false);
  state.logoutError = false;
  await elements.retryLogout.emit('click');
  assert.equal(elements.retryLogout.hidden, true);
});

test('employee 401 rejects startup and signals lost session, while an empty real roster is preserved', async t => {
  const originalFetch = globalThis.fetch;
  fixture(t);
  await flush();
  t.after(() => { globalThis.fetch = originalFetch; });
  let lost = 0;
  window.addEventListener('office-auth-lost', () => { lost++; });
  globalThis.fetch = async () => ({ status: 401, ok: false });
  await assert.rejects(fetchEmployees(), /roster unavailable/);
  assert.equal(lost, 1);
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => [] });
  assert.deepEqual(await fetchEmployees(), []);
});
