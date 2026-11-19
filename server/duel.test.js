import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { io as connectClient } from 'socket.io-client';
import { DUEL_LIMITS, DUEL_MAX, DUEL_TIME, STRIKE, duelStats } from '../src/config/duel.js';
import { characterAttributes } from '../src/config/marketplace.js';
import { makeApi } from './api.js';
import { makeDuelHub, makeGearLoader } from './duel.js';

const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', C = '33333333-3333-3333-3333-333333333333';
const GEAR = { outfit: 'outfit-ember', armor: 'armor-solar', pet: 'pet-sprout' };

function fixture({ gear = {}, failGear = false, practice = false } = {}) {
  let time = 1_000_000;
  const saved = [], logs = [];
  const loadGear = async ids => {
    if (failGear) throw new Error('down');
    return new Map(ids.map(id => [id, { equipped: gear[id] ?? {}, attributes: characterAttributes(gear[id]).total }]));
  };
  const hub = makeDuelHub({ now: () => time, rng: () => .5, loadGear, saveResult: async r => { saved.push(r); }, log: m => logs.push(m), practice });
  const conn = (userId, name, available = true) => {
    const c = { id: `${userId}:${Math.random()}`, user: { id: userId, name }, available, got: [], emit(event, data) { c.got.push([event, data]); } };
    c.last = event => c.got.filter(([e]) => e === event).at(-1)?.[1];
    c.all = event => c.got.filter(([e]) => e === event).map(([, d]) => d);
    hub.connect(c);
    return c;
  };
  const advance = ms => { const end = time + ms; while (time < end) { time = Math.min(end, time + 50); hub.tick(); } };
  return { hub, conn, advance, saved, logs, now: () => time };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

async function startDuel(f, a, b) {
  const sent = await f.hub.handle(a, 'duel:challenge', { to: B });
  assert.equal(sent.ok, true, sent.error);
  const accepted = await f.hub.handle(b, 'duel:answer', { id: sent.id, accept: true });
  assert.equal(accepted.ok, true, accepted.error);
  return sent.id;
}

test('a challenge reaches only the challenged person, and nothing starts without Accept', async () => {
  const f = fixture(), a = f.conn(A, 'Ana Reyes'), b = f.conn(B, 'Ben Cruz'), c = f.conn(C, 'Cara Lim');
  const sent = await f.hub.handle(a, 'duel:challenge', { to: B });
  assert.equal(sent.ok, true);
  assert.equal(b.last('duel:invite').from.name, 'Ana Reyes');
  assert.equal(c.last('duel:invite'), undefined);
  f.advance(DUEL_LIMITS.inviteMs - 100);
  assert.equal(f.hub._state.matches.size, 0);
  f.advance(200);
  assert.equal(a.last('duel:declined').why, 'expired');
  assert.equal(f.hub._state.invites.size, 0);
});

test('only the challenged user can accept; a third user cannot answer for them', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben'), c = f.conn(C, 'Cara');
  const sent = await f.hub.handle(a, 'duel:challenge', { to: B });
  assert.equal((await f.hub.handle(c, 'duel:answer', { id: sent.id, accept: true })).ok, false);
  assert.equal((await f.hub.handle(a, 'duel:answer', { id: sent.id, accept: true })).ok, false);
  assert.equal(f.hub._state.matches.size, 0);
  assert.ok(b.last('duel:invite'));
});

test('declining blocks the same challenger for a while; availability, self and busy are refused', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben'), c = f.conn(C, 'Cara', false);
  assert.match((await f.hub.handle(a, 'duel:challenge', { to: A })).error, /yourself/);
  assert.match((await f.hub.handle(a, 'duel:challenge', { to: C })).error, /isn't taking duels/);
  assert.match((await f.hub.handle(a, 'duel:challenge', { to: 'nobody' })).error, /not online/);
  const sent = await f.hub.handle(a, 'duel:challenge', { to: B });
  assert.match((await f.hub.handle(c, 'duel:challenge', { to: B })).error, /busy/);
  await f.hub.handle(b, 'duel:answer', { id: sent.id, accept: false });
  assert.equal(a.last('duel:declined').why, 'declined');
  f.advance(DUEL_LIMITS.spacingMs);
  assert.match((await f.hub.handle(a, 'duel:challenge', { to: B })).error, /again in 5 min/);
  f.advance(DUEL_LIMITS.repeatMs);
  assert.equal((await f.hub.handle(a, 'duel:challenge', { to: B })).ok, true);
});

test('challenges are spaced out per challenger', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben'); f.conn(C, 'Cara');
  const sent = await f.hub.handle(a, 'duel:challenge', { to: B });
  await f.hub.handle(a, 'duel:cancel', { id: sent.id });
  assert.equal(b.last('duel:invite-closed').why, 'cancelled');
  assert.match((await f.hub.handle(a, 'duel:challenge', { to: C })).error, /Slow down/);
});

test('stats come from the database, not the browser; the fight starts after the intro', async () => {
  const f = fixture({ gear: { [A]: GEAR } }), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben'), c = f.conn(C, 'Cara');
  await startDuel(f, a, b);
  const start = c.last('duel:start');
  assert.equal(start.mine, null, 'a spectator');
  assert.equal(a.last('duel:start').mine, 0);
  assert.equal(b.last('duel:start').mine, 1);
  assert.deepEqual(start.fighters[0].stats, duelStats(characterAttributes(GEAR).total));
  assert.deepEqual(start.fighters[1].stats, duelStats());
  await f.hub.handle(a, 'duel:input', { id: start.id, act: 'strike' });
  assert.equal(c.all('duel:event').length, 0, 'no fighting during the intro');
  f.advance(DUEL_TIME.intro * 1000);
  assert.ok(c.last('duel:fight'));
});

test('only the fighting connection of each side can act; everyone sees the events', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben'), c = f.conn(C, 'Cara');
  const a2 = f.conn(A, 'Ana'); // Ana's second tab
  const id = await startDuel(f, a, b);
  f.advance(DUEL_TIME.intro * 1000);
  await f.hub.handle(c, 'duel:input', { id, act: 'strike' });
  await f.hub.handle(a2, 'duel:input', { id, act: 'strike' });
  assert.equal(c.all('duel:event').length, 0);
  await f.hub.handle(a, 'duel:input', { id, act: 'strike' });
  assert.equal(c.last('duel:event').kind, 'windup');
  f.advance(STRIKE.windup * 1000);
  assert.equal(c.last('duel:event').kind, 'miss', 'six metres apart: out of reach');
  assert.ok(c.last('duel:state'));
});

test('input flooding is capped per connection', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben');
  const id = await startDuel(f, a, b);
  f.advance(DUEL_TIME.intro * 1000);
  for (let i = 0; i < 100; i++) { await f.hub.handle(a, 'duel:input', { id, act: i % 2 ? 'guardOff' : 'guardOn' }); }
  assert.equal(b.all('duel:event').length, DUEL_LIMITS.inputsPerSec);
});

test('a fighter who drops gets a grace period, then forfeits; one result row is saved', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben');
  const id = await startDuel(f, a, b);
  f.advance(DUEL_TIME.intro * 1000);
  f.hub.disconnect(b);
  f.advance(DUEL_TIME.grace * 1000 - 100);
  assert.equal(a.last('duel:end'), undefined);
  f.advance(200);
  assert.deepEqual([a.last('duel:end').winner, a.last('duel:end').result], [A, 'forfeit']);
  await flush();
  assert.equal(f.saved.length, 1);
  assert.deepEqual([f.saved[0].challenger, f.saved[0].opponent, f.saved[0].winner, f.saved[0].result], [A, B, A, 'forfeit']);
  assert.equal(f.hub._state.matches.has(id), false);
});

test('coming back within the grace period continues the fight from the new connection', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben');
  const id = await startDuel(f, a, b);
  f.advance(DUEL_TIME.intro * 1000);
  f.hub.disconnect(b);
  f.advance(3000);
  const back = f.conn(B, 'Ben');
  assert.equal(back.last('duel:hello').matches[0].mine, 1);
  f.advance(DUEL_TIME.grace * 1000);
  assert.equal(a.last('duel:end'), undefined);
  await f.hub.handle(back, 'duel:input', { id, act: 'strike' });
  assert.equal(a.last('duel:event').who, 1);
});

test('a duel runs to the end, and the slot is freed', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben');
  const id = await startDuel(f, a, b);
  f.advance(DUEL_TIME.intro * 1000);
  // Ana walks up to Ben (they start 6 m apart), then strikes until he is down
  for (let x = -3; x < 1.6; x += .15) { await f.hub.handle(a, 'duel:move', { id, x, z: 0 }); f.advance(50); }
  for (let t = 0; t < 60000 && !a.last('duel:end'); t += 1250) { await f.hub.handle(a, 'duel:input', { id, act: 'strike' }); f.advance(1250); }
  assert.deepEqual([a.last('duel:end').winner, a.last('duel:end').result], [A, 'ko']);
  const sent = await f.hub.handle(b, 'duel:challenge', { to: A });
  assert.equal(sent.ok, true, 'free again');
});

test('a cap on concurrent duels', async () => {
  const f = fixture(), pairs = [];
  for (let i = 0; i < DUEL_MAX + 1; i++) {
    const x = f.conn(`x${i}`, `X${i}`), y = f.conn(`y${i}`, `Y${i}`);
    pairs.push([x, y]);
  }
  for (const [i, [x, y]] of pairs.slice(0, DUEL_MAX).entries()) {
    const sent = await f.hub.handle(x, 'duel:challenge', { to: `y${i}` });
    assert.equal((await f.hub.handle(y, 'duel:answer', { id: sent.id, accept: true })).ok, true);
  }
  const [x, y] = pairs[DUEL_MAX];
  assert.match((await f.hub.handle(x, 'duel:challenge', { to: y.user.id })).error, /Too many duels/);
});

test('no stats, no duel: a database failure cancels the start', async () => {
  const f = fixture({ failGear: true }), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben');
  const sent = await f.hub.handle(a, 'duel:challenge', { to: B });
  const res = await f.hub.handle(b, 'duel:answer', { id: sent.id, accept: true });
  assert.equal(res.ok, false);
  assert.equal(a.last('duel:failed').why, 'Duels are unavailable right now');
  assert.equal(f.hub._state.matches.size, 0);
});

test('going offline closes your open challenges', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben');
  await f.hub.handle(a, 'duel:challenge', { to: B });
  f.hub.disconnect(b);
  assert.equal(a.last('duel:declined').why, 'offline');
  assert.equal(f.hub._state.invites.size, 0);
});

test('gear loader reads equipped items with the server client and computes totals', async () => {
  const db = { from: table => ({ select: () => ({ in: async (col, ids) => {
    assert.equal(table, 'office_market_equipment'); assert.equal(col, 'user_id');
    return { data: [{ user_id: A, outfit: 'outfit-ember', armor: 'not-an-item', pet: null }], error: null };
  } }) }) };
  const gear = await makeGearLoader(db)([A, B]);
  assert.equal(gear.get(A).equipped.outfit, 'outfit-ember');
  assert.equal(gear.get(A).equipped.armor, null);
  assert.equal(gear.get(B).attributes.strength, 10);
  await assert.rejects(makeGearLoader(null)([A]));
});

// ----- the real socket: the handshake needs an allowed origin and a valid session cookie
const ORIGIN = 'http://localhost:4173';
async function socketServer(t) {
  const db = { from: table => {
    const q = { select: () => q, eq: () => q, in: async () => ({ data: [], error: null }), insert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: table === 'profiles' ? { id: A, full_name: 'Ana Reyes', role: 'employee' } : null, error: null }) };
    return q;
  } };
  const clientFactory = () => ({ auth: { getUser: async token => (token === 'good' ? { data: { user: { id: A } }, error: null } : { data: null, error: { status: 401 } }) } });
  const api = makeApi({ APP_ORIGIN: ORIGIN }, { db, clientFactory });
  const server = createServer(api);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  api.attachRealtime(server);
  t.after(() => new Promise(resolve => { api.stopBackgroundJobs(); server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function tryConnect(url, headers) {
  const socket = connectClient(url, { path: '/api/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: headers });
  return new Promise(resolve => {
    socket.on('duel:hello', hello => { socket.close(); resolve({ ok: true, hello }); });
    socket.on('connect_error', error => { socket.close(); resolve({ ok: false, error: error.message }); });
  });
}

test('socket handshake: allowed origin and session cookie are required', async t => {
  const url = await socketServer(t);
  assert.deepEqual(await tryConnect(url, { Origin: ORIGIN, Cookie: 'officeAccess=bad' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(await tryConnect(url, { Origin: 'https://evil.example', Cookie: 'officeAccess=good' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(await tryConnect(url, { Cookie: 'officeAccess=good' }), { ok: false, error: 'unauthorized' });
  const good = await tryConnect(url, { Origin: ORIGIN, Cookie: 'officeAccess=good' });
  assert.equal(good.ok, true);
  assert.equal(good.hello.you, A);
});

test('moves: only the fighting connection, only during the fight, limited in speed, shared in state', async () => {
  const f = fixture(), a = f.conn(A, 'Ana'), b = f.conn(B, 'Ben'), c = f.conn(C, 'Cara');
  const id = await startDuel(f, a, b);
  await f.hub.handle(a, 'duel:move', { id, x: -2, z: 0 });
  f.advance(DUEL_TIME.intro * 1000);
  assert.deepEqual(c.last('duel:state').pos[0], [-3, 0], 'no moving during the intro');
  await f.hub.handle(c, 'duel:move', { id, x: -2, z: 0 });
  f.advance(50);
  assert.deepEqual(c.last('duel:state').pos[0], [-3, 0], 'a spectator cannot move a fighter');
  await f.hub.handle(a, 'duel:move', { id, x: 3, z: 0 }); // a teleport across the helipad
  f.advance(50);
  const x = c.last('duel:state').pos[0][0];
  assert.ok(x > -3 && x < -2.5, `moved only a step: ${x}`);
});

test('practice duels are off unless the hub is made for local development', async () => {
  const f = fixture(), a = f.conn(A, 'Ana');
  assert.equal(a.last('duel:hello').practice, false);
  const res = await f.hub.handle(a, 'duel:practice', { weapon: 'weapon-katana' });
  assert.equal(res.ok, false);
  assert.match(res.error, /only available when running locally/);
  assert.equal(f.hub._state.matches.size, 0);
});

test('practice: starts at once against the bot, which moves and fights; your weapon can be overridden; never saved', async () => {
  const f = fixture({ practice: true }), a = f.conn(A, 'Ana'), c = f.conn(C, 'Cara');
  assert.equal(a.last('duel:hello').practice, true);
  assert.match((await f.hub.handle(a, 'duel:practice', { weapon: 'not-a-weapon' })).error, /Unknown weapon/);
  assert.match((await f.hub.handle(a, 'duel:practice', { weapon: 'outfit-tide' })).error, /Unknown weapon/);
  const res = await f.hub.handle(a, 'duel:practice', { weapon: 'weapon-katana', mine: 'weapon-pistol', skill: 'skilled' });
  assert.equal(res.ok, true, res.error);
  const start = a.last('duel:start');
  assert.equal(start.mine, 0);
  assert.equal(start.fighters[1].name, 'Sparring Bot');
  assert.equal(start.fighters[0].stats.weapon.model, 'pistol');
  assert.equal(start.fighters[1].stats.weapon.model, 'sword');
  assert.equal(c.last('duel:start').mine, null, 'others can watch it');
  assert.ok(c.last('duel:online').find(o => o.userId === A).busy, 'you are busy while practising');
  f.advance(DUEL_TIME.intro * 1000 + 3000);
  assert.notDeepEqual(a.last('duel:state').pos[1], [3, 0], 'the bot moved');
  f.advance(120000);
  assert.ok(a.all('duel:event').some(e => e.who === 1 && e.kind === 'windup'), 'the bot attacked');
  assert.ok(a.last('duel:end'), 'it ended');
  await flush();
  assert.equal(f.saved.length, 0, 'practice is never saved to records');
});
