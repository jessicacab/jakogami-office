import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { makeApi } from './api.js';
import { analysisInput, analyzeIssue, evaluateIssue, validateAssessment } from './jira/analysis.js';
import { makeJiraClient } from './jira/client.js';
import { issueKeyFromLink, jiraConfig } from './jira/config.js';
import { decryptTokens, encryptTokens, makeWorkerStore } from './jira/crypto.js';
import { makeJiraWorker, makeUserLock, normalizeTokens } from './jira/worker.js';

const SECRET = 'ab'.repeat(32); // Synthetic test value only.
const CLOUD = '11111111-1111-1111-1111-111111111111';
const PROFILE = { id: '22222222-2222-2222-2222-222222222222', full_name: 'Test User', role: 'employee' };
const ENV = {
  APP_ORIGIN: 'http://localhost:5173', JIRA_SITE_URL: 'https://test-team.atlassian.net',
  JIRA_OAUTH_CALLBACK_URL: 'http://localhost:5173/api/jira/callback',
  JIRA_OAUTH_CLIENT_ID: 'test-client', JIRA_OAUTH_CLIENT_SECRET: 'test-oauth-secret',
  JIRA_REWARD_SIGNING_SECRET: SECRET, JIRA_AI_ENABLED: 'true', OPENAI_API_KEY: 'test-ai', OPENAI_MODEL: 'test-model',
};
const POLICY = { enabled: true, baseCoins: { trivial: 100, small: 200, moderate: 350, complex: 500, very_complex: 750 }, priorityMultipliers: { '2': 1.3 }, withinEstimateMultiplier: 1.1, perIssueCap: 1200, dailyCap: 2000, doneStatusIds: ['100'], allowedResolutionIds: ['1'], excludedResolutionIds: [], projectKeys: ['TEAM'] };
const ASSESSMENT = { complexity: 'moderate', sufficientEvidence: true, explanation: 'Multiple components and tests.', evidence: ['Update the API and UI'] };
function issue() {
  return {
    id: '10001', key: 'TEAM-123',
    fields: {
      summary: 'Test task', description: 'Update the API and UI with schema validation and regression tests.',
      project: { key: 'TEAM' }, assignee: { accountId: 'jira-user' }, priority: { id: '2' }, issuetype: { name: 'Story', subtask: false },
      status: { id: '100', name: 'Done', statusCategory: { key: 'done' } }, resolution: { id: '1' },
      timetracking: { originalEstimateSeconds: 7200 }, timespent: 3600, updated: '2026-01-03T00:00:00Z',
    },
    worklogs: [{ id: '1', author: { accountId: 'jira-user' }, timeSpentSeconds: 3600, updated: '2026-01-01T00:00:00Z' }],
    changelog: [{ created: '2026-01-02T00:00:00Z', items: [{ field: 'status', to: '100' }] }],
  };
}
function workerFixture(options = {}) {
  const calls = [];
  const job = { id: 'job-1', userId: PROFILE.id, issueKey: 'TEAM-123', cloudId: CLOUD, accountId: 'jira-user', leaseToken: 'test-lease', analysis: null };
  const connection = { ...job, encryptedTokens: encryptTokens({ access_token: 'test-access', refresh_token: 'test-refresh', expiresAt: Date.now() + 3600000 }, SECRET, PROFILE.id) };
  let reads = 0;
  const store = async (action, values) => {
    calls.push({ action, values });
    if (action === 'policy') return { config: POLICY, version: 1 };
    if (action === 'claim') return job;
    if (action === 'connection') return connection;
    if (action === 'reserve_ai') return { allowed: true };
    if (action === 'issue_claimed') return { claimed: options.claimed === true };
    return {};
  };
  const jira = { issue: async () => { reads++; return options.issue ? options.issue(reads) : issue(); }, refresh: async () => ({ access_token: 'new-test-access', refresh_token: 'new-test-refresh', expires_in: 3600 }) };
  const analyze = async () => {
    if (options.failAI) throw new Error('jira_invalid_ai_response');
    return { inputHash: analysisInput(issue()).inputHash, model: 'test-model', assessment: ASSESSMENT };
  };
  const worker = makeJiraWorker({ config: jiraConfig(ENV), store, jira, analyze });
  return { worker, calls, connection };
}

test('Jira setup fails closed and issue links reject arbitrary hosts, credentials and paths', () => {
  assert.equal(jiraConfig({}).ready, false);
  assert.equal(jiraConfig(ENV).ready, true);
  assert.equal(jiraConfig({ ...ENV, JIRA_SITE_URL: 'http://127.0.0.1' }).ready, false);
  assert.equal(jiraConfig({ ...ENV, JIRA_OAUTH_CALLBACK_URL: 'https://attacker.test/callback' }).ready, false);
  assert.equal(issueKeyFromLink(`${ENV.JIRA_SITE_URL}/browse/TEAM-123?src=link`, ENV.JIRA_SITE_URL), 'TEAM-123');
  for (const link of ['https://attacker.test/browse/TEAM-123', 'https://test-team.atlassian.net.attacker.test/browse/TEAM-123', 'https://user:pass@test-team.atlassian.net/browse/TEAM-123', 'http://127.0.0.1/browse/TEAM-123', `${ENV.JIRA_SITE_URL}/rest/api/3/issue/TEAM-123`]) {
    assert.throws(() => issueKeyFromLink(link, ENV.JIRA_SITE_URL), /invalid_jira_link/);
  }
});

test('OAuth ciphertext is randomized, account-bound and authenticated', () => {
  const first = encryptTokens({ access_token: 'test-access' }, SECRET, PROFILE.id);
  const second = encryptTokens({ access_token: 'test-access' }, SECRET, PROFILE.id);
  assert.notEqual(first, second);
  assert.equal(first.includes('test-access'), false);
  assert.deepEqual(decryptTokens(first, SECRET, PROFILE.id), { access_token: 'test-access' });
  assert.throws(() => decryptTokens(first, SECRET, 'different-user'));
  assert.throws(() => decryptTokens(first.slice(0, -3) + 'xxx', SECRET, PROFILE.id));
  assert.throws(() => normalizeTokens({ access_token: 'test-only' }));
});

test('signed operations bind exact payload and expiry without exposing the signing key', async () => {
  let args;
  const store = makeWorkerStore({ rpc: async (fn, values) => { assert.equal(fn, 'office_jira_worker'); args = values; return { data: { ok: true } }; } }, SECRET, () => 1000000);
  await store('award', { jobId: 'job-1', amount: 100 });
  assert.equal(args.p_signature, createHmac('sha256', SECRET).update(args.p_payload).digest('hex'));
  assert.equal(JSON.parse(args.p_payload).expiresAt, 1120);
  assert.equal(args.p_payload.includes(SECRET), false);
});

test('database criteria change new estimates and unsafe evidence blocks automatic payouts', () => {
  assert.equal(evaluateIssue(issue(), 'jira-user', POLICY, ASSESSMENT).eligible, true);
  assert.equal(evaluateIssue(issue(), 'jira-user', POLICY, ASSESSMENT).amount, 501);
  assert.equal(evaluateIssue(issue(), 'jira-user', { ...POLICY, baseCoins: { ...POLICY.baseCoins, moderate: 100 } }, ASSESSMENT).amount, 143);
  for (const mutate of [
    value => { value.fields.status.statusCategory.key = 'indeterminate'; },
    value => { value.fields.resolution.id = 'cancelled'; },
    value => { value.fields.assignee.accountId = 'another-user'; },
    value => { value.worklogs[0].author.accountId = 'another-user'; },
    value => { value.fields.timetracking.originalEstimateSeconds = 0; },
    value => { value.fields.timespent = 7200; },
    value => { value.worklogs[0].visibility = { type: 'group' }; },
    value => { value.worklogs[0].updated = '2026-01-05T00:00:00Z'; },
    value => { value.changelog = []; },
    value => { value.changelog.push({ created: '2026-01-04T00:00:00Z', items: [{ field: 'assignee' }] }); },
    value => { value.changelog.push({ created: '2026-01-01T00:00:00Z', items: [{ field: 'timeoriginalestimate' }] }); },
  ]) {
    const value = issue(); mutate(value);
    assert.equal(evaluateIssue(value, 'jira-user', POLICY, ASSESSMENT).eligible, false);
  }
  assert.equal(evaluateIssue(issue(), 'jira-user', { ...POLICY, enabled: false }, ASSESSMENT).eligible, false);
});

test('AI results require bounded complexity and real quotes; input removes common identifiers', () => {
  const value = issue(); value.fields.description += ' Contact person@example.test token=do-not-send';
  const input = analysisInput(value);
  assert.doesNotMatch(JSON.stringify(input), /person@example.test|do-not-send/);
  assert.deepEqual(validateAssessment(ASSESSMENT, input), ASSESSMENT);
  assert.throws(() => validateAssessment({ ...ASSESSMENT, complexity: 'pay_me_999999' }, input));
  assert.throws(() => validateAssessment({ ...ASSESSMENT, evidence: ['fabricated'] }, input));
  // Real quotes wrapped in quotation marks are accepted; commentary is dropped, not trusted.
  const wrapped = validateAssessment({ ...ASSESSMENT, evidence: ['"Update the API and UI"', 'The model thinks this is big.'] }, input);
  assert.deepEqual(wrapped.evidence, ['Update the API and UI']);
  assert.throws(() => validateAssessment({ ...ASSESSMENT, evidence: ['"made up quote"'] }, input), /insufficient_evidence/);
});

test('unchanged scope reuses a validated AI result without a paid request', async () => {
  const cached = { inputHash: analysisInput(issue()).inputHash, model: 'test-model', assessment: ASSESSMENT };
  assert.deepEqual(await analyzeIssue(jiraConfig(ENV), issue(), cached, () => { throw new Error('must not call provider'); }), cached);
});

test('AI calls have no tools or coin authority; refusals never become assessments', async () => {
  let body;
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error');
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(ASSESSMENT) }] }] }));
  };
  const result = await analyzeIssue(jiraConfig(ENV), issue(), null, fetcher);
  assert.equal(result.assessment.complexity, 'moderate');
  assert.equal(body.tools, undefined); assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
  assert.equal(body.reasoning, undefined, 'non-reasoning model gets no reasoning parameter');
  await analyzeIssue(jiraConfig({ ...ENV, OPENAI_MODEL: 'gpt-5-nano' }), issue(), null, fetcher);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  await assert.rejects(analyzeIssue(jiraConfig(ENV), issue(), null, async () => new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))), /jira_ai_incomplete/);
  await assert.rejects(analyzeIssue(jiraConfig(ENV), issue(), null, async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }))), /insufficient_evidence/);
});

test('worker rechecks Jira before signing credits; changed or failed analysis never pays', async () => {
  const valid = workerFixture(); await valid.worker.runOnce();
  assert.equal(valid.calls.filter(call => call.action === 'award').length, 1);
  assert.equal(valid.calls.at(-1).values.analysis.amount, 501);
  const changed = workerFixture({ issue: read => { const value = issue(); if (read > 1) value.fields.updated = 'changed'; return value; } });
  await changed.worker.runOnce();
  assert.equal(changed.calls.some(call => call.action === 'award'), false);
  const failed = workerFixture({ failAI: true }); await failed.worker.runOnce();
  assert.equal(failed.calls.some(call => call.action === 'award'), false);
  assert.equal(failed.calls.at(-1).values.state, 'needs_review');
});

test('only User Story tickets assigned to the connected account and not yet claimed reach paid analysis', async () => {
  const cases = [
    ['jira_not_assignee', { issue: () => { const value = issue(); value.fields.assignee.accountId = 'another-user'; return value; } }],
    ['jira_not_assignee', { issue: () => { const value = issue(); value.fields.assignee = null; return value; } }],
    ['jira_not_user_story', { issue: () => { const value = issue(); value.fields.issuetype = { name: 'Bug' }; return value; } }],
    ['jira_not_user_story', { issue: () => { const value = issue(); value.fields.issuetype = { name: 'Story', subtask: true }; return value; } }],
    ['jira_not_user_story', { issue: () => { const value = issue(); delete value.fields.issuetype; return value; } }],
    ['jira_wrong_project', { issue: () => { const value = issue(); value.fields.project.key = 'OTHER'; return value; } }],
    ['jira_already_claimed', { claimed: true }],
  ];
  for (const [reason, options] of cases) {
    const f = workerFixture(options); await f.worker.runOnce();
    assert.equal(f.calls.some(call => call.action === 'reserve_ai'), false, `${reason} must not spend on AI`);
    assert.equal(f.calls.some(call => call.action === 'award'), false, `${reason} must not pay`);
    const finish = f.calls.at(-1);
    assert.equal(finish.action, 'finish');
    assert.equal(finish.values.reason, reason);
    assert.equal(finish.values.state, 'failed', `${reason} must allow a corrected resubmission`);
  }
  for (const name of ['Story', 'User Story', ' user story ']) {
    const f = workerFixture({ issue: () => { const value = issue(); value.fields.issuetype = { name }; return value; } });
    await f.worker.runOnce();
    assert.equal(f.calls.filter(call => call.action === 'award').length, 1, `${name} should be accepted`);
  }
  const bug = issue(); bug.fields.issuetype = { name: 'Bug' };
  assert.equal(evaluateIssue(bug, 'jira-user', POLICY, ASSESSMENT).eligible, false);
});

test('unfinished tickets remain previews; rotating tokens are persisted only as ciphertext', async () => {
  const f = workerFixture({ issue: () => { const value = issue(); value.fields.status.statusCategory.key = 'indeterminate'; return value; } });
  f.connection.encryptedTokens = encryptTokens({ access_token: 'old-test', refresh_token: 'test-refresh', expiresAt: 1 }, SECRET, PROFILE.id);
  await f.worker.runOnce();
  assert.equal(f.calls.some(call => call.action === 'award'), false);
  assert.equal(f.calls.at(-1).values.state, 'waiting');
  assert.equal(f.calls.at(-1).values.analysis.amount, 501);
  const saved = f.calls.find(call => call.action === 'save_tokens').values.encryptedTokens;
  assert.equal(saved.includes('new-test-access'), false);
  assert.equal(decryptTokens(saved, SECRET, PROFILE.id).access_token, 'new-test-access');
});

test('per-user locks serialize refresh/connect and stopping the worker prevents new jobs', async () => {
  const lock = makeUserLock(), order = [];
  await Promise.all([1, 2, 3].map(id => lock('same', async () => { order.push(id); await new Promise(resolve => setTimeout(resolve, 1)); order.push(id); })));
  assert.deepEqual(order, [1, 1, 2, 2, 3, 3]);
  const f = workerFixture(); f.worker.stop(); await f.worker.runOnce(); assert.equal(f.calls.length, 0);
});

test('Jira client fetches complete worklog/history pages and forbids arbitrary request paths', async () => {
  const urls = [];
  const client = makeJiraClient(jiraConfig(ENV), async (url, options) => {
    urls.push(url); assert.equal(options.redirect, 'error');
    if (url.includes('/worklog')) return new Response(JSON.stringify({ startAt: 0, total: 1, worklogs: issue().worklogs }));
    if (url.includes('/changelog')) return new Response(JSON.stringify({ startAt: 0, total: 1, values: issue().changelog }));
    return new Response(JSON.stringify(issue()));
  });
  const value = await client.issue(CLOUD, 'test-access', 'TEAM-123');
  assert.equal(value.worklogs.length, 1); assert.equal(value.changelog.length, 1); assert.equal(urls.length, 3);
  await assert.rejects(client.issue(CLOUD, 'test-access', '../../admin'));
});

async function apiFixture(t, role = 'employee', configured = true, submitError = null) {
  const rpcCalls = [], storeCalls = [];
  let connectError = null;
  const sessionClient = () => ({ rpc: async (fn, params) => { rpcCalls.push({ fn, params }); if (submitError && fn === 'office_jira_submit') return { error: { message: submitError, code: 'P0001' } }; return { data: fn === 'office_jira_status' ? { connected: true, jobs: [], policy: POLICY } : { ok: true } }; } });
  const db = { from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { ...PROFILE, role } }) }; return q; } };
  const clientFactory = () => ({ auth: { getUser: async token => ({ data: { user: token === 'test-access' ? PROFILE : null }, error: token === 'test-access' ? null : true }) } });
  const app = express();
  app.use('/api', makeApi(configured ? ENV : {}, {
    db, clientFactory, marketplaceClientFactory: sessionClient,
    jiraStore: async (action, values) => { storeCalls.push({ action, values }); if (action === 'connect' && connectError) throw connectError; return {}; },
    jiraClient: { exchange: async () => ({ access_token: 'test-jira-access', refresh_token: 'test-jira-refresh', expires_in: 3600 }), identity: async () => ({ cloudId: CLOUD, accountId: 'jira-user' }) },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = (path, init = {}) => fetch(base + path, { ...init, redirect: 'manual', headers: { Origin: ENV.APP_ORIGIN, Cookie: 'officeAccess=test-access', 'X-Office-Account': PROFILE.id, ...init.headers } });
  const post = (path, body = {}) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { request, post, rpcCalls, storeCalls, setConnectError: error => { connectError = error; } };
}

test('Jira API is session/account-bound and missing setup never breaks the office', async t => {
  const f = await apiFixture(t, 'employee', false);
  assert.equal((await f.request('/jira', { headers: { Cookie: '' } })).status, 401);
  assert.equal((await f.request('/jira', { headers: { 'X-Office-Account': 'different' } })).status, 409);
  assert.equal((await (await f.request('/jira')).json()).configured, false); assert.equal(f.rpcCalls.length, 0);
});

test('Jira API rejects forged reward amounts and ordinary-user signing-secret bootstrap', async t => {
  const f = await apiFixture(t);
  assert.equal((await f.post('/jira/setup', { secret: 'attacker' })).status, 403);
  assert.equal((await f.post('/jira/submit', { link: `${ENV.JIRA_SITE_URL}/browse/TEAM-123`, amount: 999999 })).status, 400);
  assert.equal((await f.post('/jira/submit', { link: 'https://attacker.test/browse/TEAM-123' })).status, 400);
  assert.equal((await f.post('/jira/submit', { link: `${ENV.JIRA_SITE_URL}/browse/TEAM-123` })).status, 202);
  assert.deepEqual(f.rpcCalls.at(-1), { fn: 'office_jira_submit', params: { p_issue_key: 'TEAM-123' } });
});

test('submitting an already claimed ticket is refused with a clear message, other failures stay generic', async t => {
  const claimed = await apiFixture(t, 'employee', true, 'jira_already_claimed');
  const response = await claimed.post('/jira/submit', { link: `${ENV.JIRA_SITE_URL}/browse/TEAM-123` });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, 'jira_already_claimed');
  assert.match(body.error, /already been claimed/);
  const unexpected = await apiFixture(t, 'employee', true, 'relation "secret_table" does not exist');
  const failure = await unexpected.post('/jira/submit', { link: `${ENV.JIRA_SITE_URL}/browse/TEAM-123` });
  assert.equal(failure.status, 503);
  assert.doesNotMatch(JSON.stringify(await failure.json()), /secret_table/);
});

test('a Jira identity linked to another Office account gets a specific message without revealing that account', async t => {
  const f = await apiFixture(t);
  f.setConnectError(Object.assign(new Error('jira_storage_unavailable'), { code: 'P0001', reason: 'jira_identity_taken' }));
  const connect = await f.post('/jira/connect');
  const state = new URL((await connect.json()).url).searchParams.get('state');
  const response = await f.request(`/jira/callback?state=${state}&code=test-code`, { headers: { Cookie: `officeAccess=test-access; officeJiraState=${state}` } });
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.match(text, /already connected to a different Jakogami account/);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/);
});

test('OAuth callback requires one-use browser-bound state and allows cross-site return only on that route', async t => {
  const f = await apiFixture(t);
  const connect = await f.post('/jira/connect');
  const state = new URL((await connect.json()).url).searchParams.get('state');
  const headers = { Cookie: `officeAccess=test-access; officeJiraState=${state}`, 'Sec-Fetch-Site': 'cross-site' };
  const callback = `/jira/callback?state=${state}&code=test-code`;
  const response = await f.request(callback, { headers });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(f.storeCalls[0].action, 'connect');
  assert.equal(JSON.stringify(f.storeCalls[0]).includes('test-jira-access'), false);
  assert.equal((await f.request(callback, { headers })).status, 400);
  assert.equal((await f.request('/jira', { headers })).status, 403);
  const again = await f.post('/jira/connect');
  const wrong = new URL((await again.json()).url).searchParams.get('state');
  assert.equal((await f.request(`/jira/callback?state=${wrong}&code=test-code`, { headers: { Cookie: 'officeAccess=test-access' } })).status, 400);
});
