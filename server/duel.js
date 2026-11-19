import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { DUEL_ACTS, DUEL_LIMITS, DUEL_MAX, DUEL_STATE_EVERY, DUEL_TICK_MS, DUEL_TIME, duelStats } from '../src/config/duel.js';
import { characterAttributes, marketplaceItem, normalizeEquipment } from '../src/config/marketplace.js';
import { SKILL, botTurn } from './duelBots.js';
import { act, forfeit, makeFight, move, snapshot, tick } from './duelEngine.js';
import { makePresenceHub } from './presence.js';

// Duels between signed-in coworkers (docs/DUEL-SPEC.md). The browser side is src/ui/duel.js.
// makeDuelHub is the referee and knows nothing about sockets: connections are { id, user: { id, name }, available,
// emit(event, data) }, events arrive through handle(), and the clock moves through tick(), so tests can drive it
// with a fake clock. attachDuel puts it on Socket.IO, authenticated with the Office Floor session cookie.
// Nothing happens without consent: a challenge only becomes a duel when the challenged person accepts it.
// State is in memory: keep one server instance (like login throttling); a restart ends duels without a result.
const MAX_ID = 64;
// Practice duels against a sparring bot: only when the hub is made with `practice: true`, which only the local dev
// server does (vite.config.js `npm run dev`); the production server never turns it on. Never saved to records.
const BOT = { id: 'practice-bot', name: 'Sparring Bot' };
const isWeapon = id => id === null || id === 'fists' || marketplaceItem(id)?.slot === 'weapon';
const firstName = name => String(name || 'They').split(' ')[0];
const isId = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;

function makeDuelHub({ now = Date.now, rng = Math.random, loadGear, saveResult = async () => {}, log = () => {}, practice = false }) {
  const users = new Map();     // userId → { id, name, conns: Set, available, attributes (totals) | null }
  const conns = new Set();     // everyone connected sees every duel
  const invites = new Map();   // id → { id, from, to, fromConn, expiresAt }
  const blocked = new Map();   // 'from>to' → time a declined or expired challenger may ask again
  const lastAsked = new Map(); // userId → when they last challenged
  const matches = new Map();   // id → { id, users: [a, b], names, conns: [a, b], away: [time|null, …], phase, … }
  let ticks = 0;

  const online = () => [...users.values()].filter(u => u.conns.size);
  const inMatch = id => [...matches.values()].some(m => m.users.includes(id));
  const busy = id => inMatch(id) || [...invites.values()].some(i => i.from === id || i.to === id);
  const broadcast = (event, data) => { for (const c of conns) c.emit(event, data); };
  const tell = (userId, event, data) => { for (const c of users.get(userId)?.conns ?? []) c.emit(event, data); };
  const listOnline = () => broadcast('duel:online', online().map(u => ({ userId: u.id, name: u.name, available: u.available, busy: busy(u.id), attributes: u.attributes })));
  const full = () => matches.size >= DUEL_MAX;

  // What a browser needs to show a duel; `mine` is the side that connection fights for (null: watching).
  function view(m, c) {
    const t = now(), side = m.conns.indexOf(c);
    return {
      id: m.id, phase: m.phase, mine: side < 0 ? null : side,
      fighters: m.users.map((id, i) => ({ userId: id, name: m.names[i], attributes: m.attributes[i], equipped: m.equipped[i], stats: m.stats[i] })),
      introMs: m.phase === 'intro' ? Math.max(0, m.introUntil - t) : 0,
      endsInMs: m.fight ? Math.max(0, m.fight.endsAt - t) : null,
      state: m.fight ? snapshot(m.fight) : null,
    };
  }
  const sendMatch = (m, event) => { for (const c of conns) c.emit(event, view(m, c)); };

  async function refreshAttributes(ids) {
    const gear = await loadGear(ids);
    for (const id of ids) { const u = users.get(id); if (u) u.attributes = gear.get(id)?.attributes ?? characterAttributes(null).total; }
    return gear;
  }

  function closeInvite(inv, why) {
    invites.delete(inv.id);
    if (why === 'declined' || why === 'expired') blocked.set(`${inv.from}>${inv.to}`, now() + DUEL_LIMITS.repeatMs);
    tell(inv.to, 'duel:invite-closed', { id: inv.id, why });
    tell(inv.from, 'duel:declined', { id: inv.id, userId: inv.to, name: users.get(inv.to)?.name ?? '', why });
  }

  function connect(conn) {
    let u = users.get(conn.user.id);
    if (!u) { u = { id: conn.user.id, name: conn.user.name, conns: new Set(), available: true, attributes: null }; users.set(u.id, u); }
    u.name = conn.user.name; u.available = conn.available !== false; u.conns.add(conn); conns.add(conn);
    // back within the grace time: this connection fights on
    for (const m of matches.values()) { const side = m.users.indexOf(u.id); if (side >= 0 && m.away[side] !== null) { m.conns[side] = conn; m.away[side] = null; } }
    conn.emit('duel:hello', { you: u.id, practice, matches: [...matches.values()].filter(m => m.phase !== 'loading').map(m => view(m, conn)) });
    listOnline();
    refreshAttributes([u.id]).then(listOnline, () => {});
  }

  function disconnect(conn) {
    conns.delete(conn);
    const u = users.get(conn.user.id); if (!u) return;
    u.conns.delete(conn);
    for (const m of matches.values()) {
      const side = m.conns.indexOf(conn); if (side < 0) continue;
      const next = [...u.conns][0];
      if (next) { m.conns[side] = next; next.emit('duel:control', { id: m.id, mine: side }); } // another tab of theirs takes over
      else m.away[side] = now();
    }
    if (!u.conns.size) {
      for (const inv of [...invites.values()]) {
        if (inv.to === u.id) closeInvite(inv, 'offline');
        else if (inv.from === u.id) closeInvite(inv, 'cancelled');
      }
      if (!inMatch(u.id)) users.delete(u.id);
    }
    listOnline();
  }

  function challenge(conn, msg) {
    const me = users.get(conn.user.id), to = msg?.to, them = isId(to) ? users.get(to) : null, t = now();
    if (!them?.conns.size) return { ok: false, error: 'They are not online any more' };
    const name = firstName(them.name);
    if (them.id === me.id) return { ok: false, error: "You can't challenge yourself" };
    if (busy(me.id)) return { ok: false, error: 'Finish your current challenge or duel first' };
    if (!them.available) return { ok: false, error: `${name} isn't taking duels right now` };
    if (busy(them.id)) return { ok: false, error: `${name} is busy right now` };
    const until = blocked.get(`${me.id}>${them.id}`) ?? 0;
    if (until > t) return { ok: false, error: `You can challenge ${name} again in ${Math.ceil((until - t) / 60000)} min` };
    if (t - (lastAsked.get(me.id) ?? -Infinity) < DUEL_LIMITS.spacingMs) return { ok: false, error: 'Slow down a little' };
    if (invites.size >= DUEL_LIMITS.maxInvites) return { ok: false, error: 'Too many open challenges, try again in a bit' };
    if (full()) return { ok: false, error: 'Too many duels are on right now, try again in a bit' };
    lastAsked.set(me.id, t);
    const inv = { id: randomUUID(), from: me.id, to: them.id, fromConn: conn, expiresAt: t + DUEL_LIMITS.inviteMs };
    invites.set(inv.id, inv);
    tell(them.id, 'duel:invite', { id: inv.id, from: { userId: me.id, name: me.name, attributes: me.attributes }, expiresInMs: DUEL_LIMITS.inviteMs });
    listOnline();
    return { ok: true, id: inv.id, expiresInMs: DUEL_LIMITS.inviteMs };
  }

  async function answer(conn, msg) {
    const inv = isId(msg?.id) ? invites.get(msg.id) : null;
    if (!inv || inv.to !== conn.user.id) return { ok: false, error: 'That challenge is no longer open' };
    if (msg.accept !== true) { closeInvite(inv, 'declined'); listOnline(); return { ok: true }; }
    if (full()) { closeInvite(inv, 'full'); listOnline(); return { ok: false, error: 'Too many duels are on right now, try again in a bit' }; }
    invites.delete(inv.id);
    tell(inv.to, 'duel:invite-closed', { id: inv.id, why: 'accepted' });
    const fromConn = users.get(inv.from)?.conns.has(inv.fromConn) ? inv.fromConn : [...(users.get(inv.from)?.conns ?? [])][0];
    const m = { id: inv.id, users: [inv.from, inv.to], names: [users.get(inv.from).name, users.get(inv.to).name], conns: [fromConn, conn], away: [null, null], phase: 'loading', startedAt: now() };
    matches.set(m.id, m);
    listOnline();
    let gear;
    try { gear = await refreshAttributes(m.users); } catch (_) { gear = null; }
    // the stats are read from the database, never taken from a browser; no stats, no duel
    const gone = m.users.find(id => !users.get(id)?.conns.size);
    if (!gear || gone) {
      matches.delete(m.id);
      const why = gone ? `${firstName(users.get(gone)?.name ?? m.names[m.users.indexOf(gone)])} went offline` : 'Duels are unavailable right now';
      for (const id of m.users) tell(id, 'duel:failed', { id: m.id, why });
      listOnline();
      return { ok: false, error: why };
    }
    m.equipped = m.users.map(id => gear.get(id)?.equipped ?? normalizeEquipment(null));
    m.attributes = m.equipped.map(e => characterAttributes(e).total);
    m.stats = m.attributes.map((a, i) => duelStats(a, m.equipped[i].weapon)); // the weapon changes the strike
    m.phase = 'intro'; m.introUntil = now() + DUEL_TIME.intro * 1000;
    sendMatch(m, 'duel:start');
    listOnline();
    return { ok: true };
  }

  function cancel(conn, msg) {
    const inv = isId(msg?.id) ? invites.get(msg.id) : null;
    if (!inv || inv.from !== conn.user.id) return { ok: false, error: 'That challenge is no longer open' };
    closeInvite(inv, 'cancelled'); listOnline();
    return { ok: true };
  }

  // A practice duel against the sparring bot (local only): starts at once, no invitation. `weapon` is the bot's,
  // `mine` optionally overrides your own weapon for this duel (to try one you have not bought), `skill` the bot's level.
  async function startPractice(conn, msg) {
    if (!practice) return { ok: false, error: 'Practice duels are only available when running locally' };
    const me = users.get(conn.user.id), weapon = msg?.weapon ?? null, mine = msg?.mine, skill = SKILL[msg?.skill] ? msg.skill : 'average';
    if (!isWeapon(weapon) || (mine !== undefined && !isWeapon(mine))) return { ok: false, error: 'Unknown weapon' };
    if (busy(me.id)) return { ok: false, error: 'Finish your current challenge or duel first' };
    if (full()) return { ok: false, error: 'Too many duels are on right now, try again in a bit' };
    const m = { id: randomUUID(), users: [me.id, BOT.id], names: [me.name, BOT.name], conns: [conn, null], away: [null, null], phase: 'loading', startedAt: now(), practice: { skill: SKILL[skill], bot: {} } };
    matches.set(m.id, m);
    let gear;
    try { gear = await refreshAttributes([me.id]); } catch (_) { gear = null; }
    if (!gear || !users.get(me.id)?.conns.size) { matches.delete(m.id); return { ok: false, error: 'Duels are unavailable right now' }; }
    const own = gear.get(me.id)?.equipped ?? normalizeEquipment(null);
    m.equipped = [mine === undefined ? own : { ...own, weapon: mine === 'fists' ? null : mine }, normalizeEquipment({ weapon: weapon === 'fists' ? null : weapon })];
    m.attributes = m.equipped.map(e => characterAttributes(e).total);
    m.stats = m.attributes.map((a, i) => duelStats(a, m.equipped[i].weapon));
    m.phase = 'intro'; m.introUntil = now() + DUEL_TIME.intro * 1000;
    sendMatch(m, 'duel:start');
    listOnline();
    return { ok: true };
  }

  // Where a fighter's browser has moved them; the engine limits speed and keeps them on the helipad. Everyone hears the
  // result in the next state update. Not acknowledged (it comes 20 times a second).
  function moveTo(conn, msg) {
    const m = isId(msg?.id) ? matches.get(msg.id) : null, side = m ? m.conns.indexOf(conn) : -1;
    if (side < 0 || m.phase !== 'fight') return null;
    const t = now();
    conn.moves = (conn.moves ?? []).filter(x => t - x < 1000);
    if (conn.moves.length >= DUEL_LIMITS.movesPerSec) return null;
    conn.moves.push(t);
    move(m.fight, side, Number(msg.x), Number(msg.z), t);
    return null;
  }

  function input(conn, msg) {
    const m = isId(msg?.id) ? matches.get(msg.id) : null, side = m ? m.conns.indexOf(conn) : -1;
    if (side < 0 || m.phase !== 'fight' || !DUEL_ACTS.includes(msg.act)) return null;
    const t = now();
    conn.inputs = (conn.inputs ?? []).filter(x => t - x < 1000);
    if (conn.inputs.length >= DUEL_LIMITS.inputsPerSec) return null;
    conn.inputs.push(t);
    const ev = act(m.fight, side, msg.act, t);
    if (ev) broadcast('duel:event', { id: m.id, ...ev });
    return null;
  }

  function end(m) {
    matches.delete(m.id);
    const f = m.fight, winner = f.winner === null ? null : m.users[f.winner];
    broadcast('duel:end', { id: m.id, winner, result: f.result, hp: f.f.map(x => x.hp), dealt: f.f.map(x => x.dealt) });
    if (!m.practice) saveResult({
      challenger: m.users[0], opponent: m.users[1], winner, result: f.result,
      challengerAttributes: m.attributes[0], opponentAttributes: m.attributes[1],
      startedAt: new Date(m.startedAt).toISOString(), endedAt: new Date(now()).toISOString(),
    }).catch(error => log('duel result not saved', error));
    for (const id of m.users) if (!users.get(id)?.conns.size) users.delete(id);
    listOnline();
  }

  function step() {
    const t = now(); ticks++;
    for (const inv of [...invites.values()]) if (t >= inv.expiresAt) { closeInvite(inv, 'expired'); listOnline(); }
    for (const [key, until] of blocked) if (until <= t) blocked.delete(key);
    for (const m of [...matches.values()]) {
      if (m.phase === 'loading') continue;
      const gone = m.away.findIndex(at => at !== null && t - at >= DUEL_TIME.grace * 1000);
      if (m.phase === 'intro') {
        if (gone >= 0 || t >= m.introUntil) {
          m.phase = 'fight'; m.fight = makeFight(m.stats[0], m.stats[1], t, rng);
          sendMatch(m, 'duel:fight');
        } else continue;
      }
      if (gone >= 0) forfeit(m.fight, gone);
      if (m.practice) botTurn(m.fight, 1, m.practice.bot, m.practice.skill, t, Math.random, ev => broadcast('duel:event', { id: m.id, ...ev }));
      for (const ev of tick(m.fight, t)) broadcast('duel:event', { id: m.id, ...ev });
      if (m.fight.over) end(m);
      else if (ticks % DUEL_STATE_EVERY === 0) broadcast('duel:state', { id: m.id, ...snapshot(m.fight) });
    }
  }

  async function handle(conn, event, payload) {
    if (!users.get(conn.user.id)?.conns.has(conn)) return { ok: false, error: 'Not connected' };
    switch (event) {
      case 'duel:available': users.get(conn.user.id).available = payload?.on !== false; listOnline(); return { ok: true };
      case 'duel:challenge': return challenge(conn, payload);
      case 'duel:answer': return answer(conn, payload);
      case 'duel:cancel': return cancel(conn, payload);
      case 'duel:input': return input(conn, payload);
      case 'duel:move': return moveTo(conn, payload);
      case 'duel:practice': return startPractice(conn, payload);
      default: return { ok: false, error: 'Unknown request' };
    }
  }

  return { connect, disconnect, handle, tick: step, _state: { users, invites, matches, blocked } };
}

// Equipped gear for some users, read with the server-only client: Map userId → { equipped, attributes (totals) }.
// Throws when the database cannot be read (then no duel starts). Before the weapons migration there is no `weapon`
// column: then everyone fights with fists.
function makeGearLoader(db) {
  return async ids => {
    if (!db) throw new Error('Supabase is not configured');
    const read = columns => db.from('office_market_equipment').select(columns).in('user_id', ids);
    let { data, error } = await read('user_id, outfit, armor, pet, weapon');
    if (error && (error.code === '42703' || /weapon/.test(error.message ?? ''))) ({ data, error } = await read('user_id, outfit, armor, pet'));
    if (error) throw new Error('Equipment lookup failed');
    const gear = new Map();
    for (const id of ids) {
      const row = (data ?? []).find(r => r.user_id === id), equipped = normalizeEquipment(row);
      gear.set(id, { equipped, attributes: characterAttributes(equipped).total });
    }
    return gear;
  };
}
// One row per finished duel. A missing table (migration not applied) is reported once, then ignored.
function makeResultSaver(db, log) {
  let warned = false;
  return async r => {
    if (!db) return;
    const { error } = await db.from('office_duel_matches').insert({
      challenger: r.challenger, opponent: r.opponent, winner: r.winner, result: r.result,
      challenger_attributes: r.challengerAttributes, opponent_attributes: r.opponentAttributes,
      started_at: r.startedAt, ended_at: r.endedAt,
    });
    if (error && !warned) { warned = true; log('duel results are not being saved: apply supabase/migrations/202611180001_duel.sql'); }
  };
}

// Socket.IO at /api/socket.io (under /api so the session cookies, Path=/api, are sent), WebSocket only (so the
// browser always sends Origin), on the app's own HTTP server. The same connection carries live presence
// (server/presence.js: who is walking around). Returns { hub, presence, io, close }.
function attachDuel(httpServer, { verify, db, now, rng, practice = false, log = message => console.warn('[duel]', message) }) {
  const io = new Server(httpServer, {
    path: '/api/socket.io', transports: ['websocket'], serveClient: false, maxHttpBufferSize: 4096,
    destroyUpgrade: false, // other WebSocket upgrades on this server (Vite's hot reload) are not ours to close
  });
  // practice duels: only when asked for (the local dev server) and never on a Render deployment
  const hub = makeDuelHub({ now, rng, loadGear: makeGearLoader(db), saveResult: makeResultSaver(db, log), log: message => log(message), practice: practice && !process.env.RENDER });
  const presence = makePresenceHub({ now });
  io.use(async (socket, next) => {
    try {
      const profile = await verify(socket.handshake.headers);
      if (!profile) return next(new Error('unauthorized'));
      socket.data.profile = profile; next();
    } catch (_) { next(new Error('unavailable')); }
  });
  io.on('connection', socket => {
    const { id, full_name: fullName } = socket.data.profile;
    const conn = { id: socket.id, user: { id, name: fullName || 'A coworker' }, available: socket.handshake.auth?.available !== false, emit: (e, d) => socket.emit(e, d) };
    hub.connect(conn);
    presence.connect(conn);
    for (const event of ['presence:move', 'presence:stop']) socket.on(event, payload => presence.handle(conn, event, payload));
    for (const event of ['duel:available', 'duel:challenge', 'duel:answer', 'duel:cancel', 'duel:input', 'duel:move', 'duel:practice']) {
      socket.on(event, async (payload, ack) => {
        const result = await hub.handle(conn, event, payload);
        if (result && typeof ack === 'function') ack(result);
      });
    }
    socket.on('disconnect', () => { hub.disconnect(conn); presence.disconnect(conn); });
  });
  const timer = setInterval(() => { hub.tick(); presence.tick(); }, DUEL_TICK_MS);
  timer.unref?.();
  return { hub, presence, io, close() { clearInterval(timer); io.disconnectSockets(true); } };
}

export { attachDuel, makeDuelHub, makeGearLoader };
