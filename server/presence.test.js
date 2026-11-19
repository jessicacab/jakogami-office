import assert from 'node:assert/strict';
import test from 'node:test';
import { PRESENCE, makePresenceHub } from './presence.js';

function fixture() {
  let time = 1_000_000;
  const hub = makePresenceHub({ now: () => time });
  const conn = (userId, name = userId) => {
    const c = { id: Math.random(), user: { id: userId, name }, got: [], emit(e, d) { c.got.push([e, d]); } };
    c.all = e => c.got.filter(([x]) => x === e).map(([, d]) => d);
    hub.connect(c); return c;
  };
  const advance = ms => { const end = time + ms; while (time < end) { time = Math.min(end, time + 50); hub.tick(); } };
  return { hub, conn, advance };
}
const MOVE = { x: 10, z: 5, face: 1.2, anim: 'walk' };

test('a walker is sent to everyone else, not back to themselves', () => {
  const f = fixture(), a = f.conn('ana', 'Ana'), b = f.conn('ben', 'Ben');
  f.hub.handle(a, 'presence:move', MOVE);
  f.advance(PRESENCE.batchMs);
  assert.deepEqual(b.all('presence:update').at(-1), [{ userId: 'ana', name: 'Ana', x: 10, z: 5, face: 1.2, anim: 'walk', hipY: null }]);
  assert.equal(a.all('presence:update').length, 0);
  const c = f.conn('cara');
  assert.equal(c.all('presence:all').at(-1)[0].userId, 'ana', 'someone arriving sees who is already walking');
});

test('updates are batched and only what changed is sent', () => {
  const f = fixture(), a = f.conn('ana'), b = f.conn('ben');
  for (let i = 0; i < 3; i++) f.hub.handle(a, 'presence:move', { ...MOVE, x: 10 + i });
  f.advance(PRESENCE.batchMs);
  assert.equal(b.all('presence:update').length, 1);
  assert.equal(b.all('presence:update')[0][0].x, 12, 'the latest position');
  f.advance(PRESENCE.batchMs * 3);
  assert.equal(b.all('presence:update').length, 1, 'nothing new, nothing sent');
});

test('bad updates are ignored: off the floor, not numbers, odd poses; and flooding is capped', () => {
  const f = fixture(), a = f.conn('ana'), b = f.conn('ben');
  for (const bad of [{ ...MOVE, x: 500 }, { ...MOVE, z: -40 }, { ...MOVE, x: 'ten' }, { ...MOVE, face: NaN }, { ...MOVE, anim: '<script>' }, { ...MOVE, anim: undefined }, null]) f.hub.handle(a, 'presence:move', bad);
  f.advance(PRESENCE.batchMs);
  assert.equal(b.all('presence:update').length, 0);
  f.advance(1000); // (the bad ones counted towards this second's limit too)
  for (let i = 0; i < 40; i++) f.hub.handle(a, 'presence:move', { ...MOVE, x: 1 + i * .1 });
  f.advance(PRESENCE.batchMs);
  assert.ok(Math.abs(b.all('presence:update')[0][0].x - (1 + (PRESENCE.perSec - 1) * .1)) < 1e-9, 'stops at the cap');
});

test('stopping, the last tab closing, or going silent all leave', () => {
  const f = fixture(), a = f.conn('ana'), a2 = f.conn('ana'), b = f.conn('ben');
  f.hub.handle(a, 'presence:move', MOVE); f.advance(PRESENCE.batchMs);
  f.hub.disconnect(a); f.advance(PRESENCE.batchMs);
  assert.equal(b.all('presence:leave').length, 0, 'another tab is still open');
  f.hub.handle(a2, 'presence:stop'); f.advance(PRESENCE.batchMs);
  assert.deepEqual(b.all('presence:leave'), [{ userId: 'ana' }]);
  f.hub.handle(a2, 'presence:move', MOVE); f.advance(PRESENCE.batchMs);
  f.hub.disconnect(a2); f.advance(PRESENCE.batchMs);
  assert.equal(b.all('presence:leave').length, 2);
  const c = f.conn('cara');
  f.hub.handle(c, 'presence:move', MOVE);
  f.advance(PRESENCE.silentMs + 200);
  assert.equal(b.all('presence:leave').at(-1).userId, 'cara', 'silent for too long');
});
