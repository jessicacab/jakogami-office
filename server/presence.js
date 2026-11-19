// Live presence (docs/PRESENCE-SPEC.md): who is walking around the office right now, and where. Browsers send their
// own position while their user walks; this forwards it to everyone else, batched every PRESENCE.batchMs. It knows
// nothing about sockets (like makeDuelHub in server/duel.js): connections are { id, user: { id, name }, emit } and the
// clock moves through tick(), so tests can drive it. Nothing is stored; a restart forgets everyone.
const PRESENCE = { batchMs: 100, silentMs: 5000, perSec: 15 };
// The office floor in metres (config/plan.js: 1300 × 520 plan pixels at 0.02 m), with a little margin.
const FLOOR = { x: [-1, 27], z: [-1, 12] };
const ANIMS = /^[a-zA-Z]{1,24}$/;
const num = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

function makePresenceHub({ now = Date.now } = {}) {
  const walkers = new Map(); // userId → { userId, name, x, z, face, anim, hipY, at, dirty }
  const conns = new Set();
  const left = [];           // userIds that stopped since the last batch
  let lastBatch = 0;

  const pub = w => ({ userId: w.userId, name: w.name, x: w.x, z: w.z, face: w.face, anim: w.anim, hipY: w.hipY });
  const othersOf = (list, c) => list.filter(w => w.userId !== c.user.id); // never your own back

  function connect(conn) {
    conns.add(conn);
    conn.emit('presence:all', othersOf([...walkers.values()].map(pub), conn));
  }
  function stop(userId) { if (walkers.delete(userId)) left.push(userId); }
  function disconnect(conn) {
    conns.delete(conn);
    // the user's last tab went: they stop walking
    if (![...conns].some(c => c.user.id === conn.user.id)) stop(conn.user.id);
  }

  // `presence:move` { x, z, face, anim, hipY? } or `presence:stop`. Invalid updates are ignored.
  function handle(conn, event, msg) {
    if (!conns.has(conn)) return;
    if (event === 'presence:stop') { stop(conn.user.id); return; }
    if (event !== 'presence:move') return;
    const t = now();
    conn.presenceAt = (conn.presenceAt ?? []).filter(x => t - x < 1000);
    if (conn.presenceAt.length >= PRESENCE.perSec) return;
    conn.presenceAt.push(t);
    const x = num(msg?.x, ...FLOOR.x), z = num(msg?.z, ...FLOOR.z), face = num(msg?.face, -100, 100);
    const anim = typeof msg?.anim === 'string' && ANIMS.test(msg.anim) ? msg.anim : null;
    const hipY = msg?.hipY === undefined || msg.hipY === null ? null : num(msg.hipY, 0, 1.5);
    if (x === null || z === null || face === null || !anim) return;
    walkers.set(conn.user.id, { userId: conn.user.id, name: conn.user.name, x, z, face, anim, hipY, at: t, dirty: true });
  }

  // Every server tick: drop walkers who went silent, and every PRESENCE.batchMs send what changed to everyone else.
  function tick() {
    const t = now();
    for (const w of [...walkers.values()]) if (t - w.at > PRESENCE.silentMs) stop(w.userId);
    if (t - lastBatch < PRESENCE.batchMs) return;
    lastBatch = t;
    const changed = [...walkers.values()].filter(w => w.dirty);
    changed.forEach(w => { w.dirty = false; });
    const moves = changed.map(pub), gone = left.splice(0);
    if (!moves.length && !gone.length) return;
    for (const c of conns) {
      const mine = othersOf(moves, c);
      if (mine.length) c.emit('presence:update', mine);
      for (const userId of gone) if (userId !== c.user.id) c.emit('presence:leave', { userId });
    }
  }

  return { connect, disconnect, handle, tick, _state: { walkers } };
}

export { FLOOR, PRESENCE, makePresenceHub };
