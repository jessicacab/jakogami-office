import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { makeSessionSupabase, makeSupabase } from './supabase.js';

test('session clients use the existing API key with isolated user Authorization headers', async t => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization, key: req.headers.apikey });
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  // Synthetic test values only; never load .env or contact Supabase.
  const env = { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SECRET_KEY: 'test-existing-key' };
  const office = makeSupabase(env);
  const alice = makeSessionSupabase(env, 'test-alice');
  const bob = makeSessionSupabase(env, 'test-bob');
  for (const client of [alice, bob, office, alice]) {
    const { error } = await client.rpc('test_only');
    assert.equal(error, null);
  }
  assert.deepEqual(requests, [
    { authorization: 'Bearer test-alice', key: 'test-existing-key' },
    { authorization: 'Bearer test-bob', key: 'test-existing-key' },
    { authorization: 'Bearer test-existing-key', key: 'test-existing-key' },
    { authorization: 'Bearer test-alice', key: 'test-existing-key' },
  ]);
});

test('session client fails closed without a verified token or existing configuration', () => {
  assert.equal(makeSessionSupabase({}, 'test-token'), null);
  assert.equal(makeSessionSupabase({ SUPABASE_URL: 'https://example.test', SUPABASE_SECRET_KEY: 'test-key' }), null);
});
