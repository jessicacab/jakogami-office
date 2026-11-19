import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { jiraRequest } from '../persistence/jira.js';
import { initJira, jobCard, stopJira } from './jira.js';

class Element {
  constructor() { this.handlers = new Map(); this.children = []; this.value = ''; this.open = false; this.textContent = ''; }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  removeEventListener(name) { this.handlers.delete(name); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  emit(name) { return this.handlers.get(name)?.({ preventDefault() {}, stopPropagation() {} }); }
}
function fixture(t, initial = {}) {
  const oldDoc = globalThis.document, oldWindow = globalThis.window;
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  globalThis.document = { getElementById: id => nodes.get(id), createElement: () => new Element() };
  globalThis.window = new EventTarget();
  const calls = [], intervals = new Map(), state = {
    status: { configured: true, aiConfigured: true, connected: true, jobs: [], policy: { enabled: true } }, ...initial,
  };
  initJira({ id: 'test-user', role: 'employee' }, {
    request: async (path, id, body) => {
      calls.push({ path, id, body });
      if (path && state.error) throw new Error(state.error);
      if (state.pending && !path) return state.pending;
      return path ? {} : state.status;
    },
    timers: { setInterval(fn) { const key = Symbol(); intervals.set(key, fn); return key; }, clearInterval(key) { intervals.delete(key); } },
  });
  t.after(() => { stopJira(); globalThis.document = oldDoc; globalThis.window = oldWindow; });
  return { nodes, calls, intervals, state };
}
async function flush() { await setImmediate(); }

test('Jira panel submits only a link with the current account and retains provider errors', async t => {
  const { nodes, state, calls } = fixture(t);
  nodes.get('jiraBtn').emit('click'); await flush();
  assert.equal(nodes.get('jiraSetup').hidden, true);
  nodes.get('jiraLink').value = ' https://test.atlassian.net/browse/TEST-1 ';
  state.error = 'Jira permission missing';
  nodes.get('jiraForm').emit('submit'); await flush();
  assert.deepEqual(calls.at(-1), { path: '/submit', id: 'test-user', body: { link: 'https://test.atlassian.net/browse/TEST-1' } });
  assert.equal(nodes.get('jiraError').textContent, 'Jira permission missing');
});

test('logout drops late Jira responses, clears history and removes polling/listeners', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { nodes, intervals } = fixture(t, { pending });
  nodes.get('jiraBtn').emit('click');
  assert.equal(intervals.size, 1);
  stopJira();
  resolve({ configured: true, connected: true, jobs: [{ id: 'private', issueKey: 'PRIVATE-1' }] });
  await flush();
  assert.equal(nodes.get('jiraJobs').children.length, 0);
  assert.equal(nodes.get('jiraDialog').open, false);
  assert.equal(intervals.size, 0);
  assert.equal(nodes.get('jiraConnect').handlers.size, 0);
});

test('only awarded jobs notify the wallet and previews are explicitly not credited', async t => {
  const { nodes, state } = fixture(t);
  let count = 0; window.addEventListener('office-wallet-changed', () => count++);
  state.status.jobs = [{ id: '1', state: 'waiting', amount: 0, analysis: { amount: 501 } }];
  nodes.get('jiraBtn').emit('click'); await flush();
  assert.equal(count, 0);
  assert.match(nodes.get('jiraJobs').children[0].children.find(child => child.className === 'jira-amount').textContent, /501 coins estimated — not credited/);
  state.status.jobs = [{ id: '1', state: 'awarded', amount: 501, analysis: {} }];
  await nodes.get('jiraRefresh').emit('click'); await flush();
  assert.equal(count, 1);
  await nodes.get('jiraRefresh').emit('click'); await flush();
  assert.equal(count, 1);
  const malicious = jobCard({ issueKey: '<script>bad()</script>', state: 'waiting', analysis: { summary: '<img onerror=bad()>' } });
  assert.equal(malicious.children[0].textContent, '<script>bad()</script>');
});

test('Jira transport uses no-store and dispatches account/session loss events', async t => {
  fixture(t);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let changed = 0, lost = 0;
  window.addEventListener('office-account-changed', () => changed++);
  window.addEventListener('office-auth-lost', () => lost++);
  globalThis.fetch = async (url, init) => {
    assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['X-Office-Account'], 'test-user');
    return new Response(JSON.stringify({ code: 'account_changed', error: 'Changed' }), { status: 409 });
  };
  await assert.rejects(jiraRequest('', 'test-user'));
  assert.equal(changed, 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Sign in' }), { status: 401 });
  await assert.rejects(jiraRequest('', 'test-user')); assert.equal(lost, 1);
});

test('Connect Jira is disabled once connected and re-enabled after disconnecting', async t => {
  const { nodes, state } = fixture(t);
  nodes.get('jiraBtn').emit('click'); await flush();
  assert.equal(nodes.get('jiraConnect').disabled, true);
  assert.equal(nodes.get('jiraConnect').textContent, 'Jira connected');
  assert.equal(nodes.get('jiraDisconnect').disabled, false);
  state.status = { ...state.status, connected: false };
  nodes.get('jiraRefresh').emit('click'); await flush();
  assert.equal(nodes.get('jiraConnect').disabled, false);
  assert.equal(nodes.get('jiraConnect').textContent, 'Connect Jira');
  assert.equal(nodes.get('jiraDisconnect').disabled, true);
});
