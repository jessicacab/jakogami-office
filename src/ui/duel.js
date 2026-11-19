import * as THREE from 'three';
import { setView } from '../camera/controller.js';
import { buildBody, disposeBody } from '../character/rig.js';
import { DEFAULT_SPEC, normalizeSpec, randomSpec } from '../character/spec.js';
import { BLAST, DUEL_LIMITS, DUEL_TIME } from '../config/duel.js';
import { seededRandom } from '../core/util.js';
import { equipPerson } from '../people/equipment.js';
import { employeeById, simRole } from '../people/roster.js';
import { askDuel, connectDuel, disconnectDuel, fetchDuelRecords, onDuel, savedAvailability, sendDuel, setAvailability } from '../persistence/duel.js';
import { ctl } from '../player/control.js';
import { player, setSelfEquipment, walkAsSelf } from '../player/player.js';
import { clearDuelFx, spawnBurst, spawnNumber, spawnOrb } from '../render/duelFx.js';
import { renderer, scene } from '../render/renderer.js';
import { duel, duelEnd, duelEvent, duelFight, duelState, startDuel, stopDuel } from '../sim/duel.js';
import { people } from '../sim/state.js';
import { disposeArena } from '../world/arena.js';
import { $, keyed } from './dom.js';
import { arenaScene, enterArena, initDuelArena, leaveArena, reconcile, stopDuelArena, updateDuelArena, viewing } from './duelArena.js';
import { renderPerson, selected } from './person.js';

/* ================= Duel: challenges, the panel and the fight HUD ================= */
// docs/DUEL-SPEC.md. The server (server/duel.js) referees; this module asks it things, passes its events to sim/duel.js
// and the effects (render/duelFx.js), takes you to the rooftop arena for your own duel or to watch one
// (ui/duelArena.js), and shows:
// - the Duel panel (dock): who is online, their attributes and record, Challenge, and your "Available for duels" switch
// - the card at the top: a challenge for you (Accept / Decline), yours waiting for an answer, short notes
// - the fight HUD: health, mana, the clock, and (in your own duel) Strike / Guard / Blast with their cooldowns
// - a crossed-swords marker over everyone online, and G to challenge whoever you look at while walking
// Nobody can be challenged unless they are online and available, and nothing starts until they accept.
const ui = {
  profile: null, me: null, online: [], byId: new Map(), status: 'connecting', available: true,
  records: new Map(), recordsAt: new Map(), recordsNote: '', wanted: new Set(), recordsTimer: null, blocked: new Map(),
  invite: null, outgoing: null, note: '', noteUntil: 0, guarding: false, cd: { strike: 0, blast: 0, total: { strike: 1, blast: 1 } },
  resume: null, shown: new Map(), markers: new Map(), personById: new Map(), acc: 0, listeners: [], active: false,
};
const first = name => String(name || '').split(' ')[0] || 'They';
const now = () => performance.now();
function note(text, secs = 5) { ui.note = text; ui.noteUntil = now() + secs * 1000; }
function listen(node, event, fn, opts) { node.addEventListener(event, fn, opts); ui.listeners.push(() => node.removeEventListener(event, fn, opts)); }
const typing = e => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName) || e.target?.isContentEditable;

// ----- who is online, and who can be challenged
const onlineUser = id => ui.byId.get(id) ?? null;
const myMatch = () => duel.matches.find(m => m.userIds.includes(ui.me) && m.phase !== 'end') ?? null;
const imBusy = () => !!ui.outgoing || !!ui.invite || !!myMatch();
function canChallenge(id) { return id !== ui.me && !whyNot(id) && ui.status === 'online'; }
function whyNot(id) {
  const o = onlineUser(id);
  if (!o) return 'Not online';
  if (o.busy) return 'In a duel';
  if (!o.available) return 'Not taking duels';
  if (imBusy()) return 'Finish yours first';
  const wait = (ui.blocked.get(id) ?? 0) - now(); // they said no (or did not answer): the server refuses for a while
  if (wait > 0) return `Again in ${Math.ceil(wait / 60000)} min`;
  return '';
}

async function challenge(userId) {
  const o = onlineUser(userId); if (!o) { note('They are not online any more'); return; }
  const res = await askDuel('duel:challenge', { to: userId });
  if (!res.ok) { note(res.error || 'The challenge did not go through'); render(); return; }
  ui.outgoing = { id: res.id, userId, name: o.name, until: now() + res.expiresInMs, total: res.expiresInMs };
  if ($('duelDialog').open) $('duelDialog').close(); // the card at the top shows the wait
  note('', 0); render();
}
async function answer(accept) {
  const inv = ui.invite; if (!inv) return;
  ui.invite = null; render();
  const res = await askDuel('duel:answer', { id: inv.id, accept });
  if (!res.ok && accept) note(res.error || 'Could not start the duel');
}
async function cancel() {
  const out = ui.outgoing; if (!out) return;
  ui.outgoing = null; render();
  await askDuel('duel:cancel', { id: out.id });
}
async function toggleAvailable(on) {
  ui.available = on; render();
  const res = await setAvailability(on);
  if (!res.ok) note(res.error || 'Could not change that right now');
}

// ----- the people in a duel: two fighters made for the arena (their look and gear), and their characters in the office,
// which vanish for the duel and come back afterwards
function officeOf(userId) {
  if (userId === ui.me && player.person?.id === -1 && player.person.body.root.visible) return player.person; // your own character
  return people.find(q => q.userId === userId && !q.helper) ?? null;
}
function specFor(userId) {
  const here = officeOf(userId);
  if (here) return here.spec;
  if (userId === ui.me) return player.spec;
  const e = employeeById(userId);
  return normalizeSpec(e?.character ?? (e ? randomSpec(simRole(e.department), seededRandom(e.userId)) : DEFAULT_SPEC));
}
function arenaBody(f) {
  const body = buildBody(specFor(f.userId));
  body.ring.visible = false; body.root.visible = false;
  equipPerson({ body }, f.equipped);
  arenaScene().add(body.root);
  return body;
}
// A flash where someone leaves the office for the arena, or comes back.
function flash(p) { if (p?.body.root.visible) spawnBurst(new THREE.Vector3(p.pos.x, 1, p.pos.z), 0xffd36b, 1.6); }
// Walking when your duel starts: you stop, and walk on afterwards.
function stopWalking() {
  ui.resume = ctl.active ? (ctl.mode === 'fp' ? 'fp' : 'third') : null;
  if (ctl.active) setView('free');
}
// The duel is over (sim/duel.js has put the two back in the office): the arena fighters go, and you come back.
function ended(m) {
  for (const f of m.fighters) { f.body.root.removeFromParent(); disposeBody(f.body); }
  m.office.forEach(flash);
  if (viewing() === m) leaveArena();
  if (m.mine !== null && ui.resume) { const mode = ui.resume; ui.resume = null; walkAsSelf(); setView(mode); }
  render();
}

// A duel from the server (duel:start, duel:hello, or duel:fight we missed the start of).
function begin(v) {
  const was = duel.matches.find(m => m.id === v.id);
  if (was) { // already showing it (a reconnect): catch up
    was.mine = v.mine;
    if (v.phase === 'fight' && was.phase === 'intro') duelFight(was);
    if (v.state) duelState(was, v.state, true);
    setDeadline(was, v);
    if (was.mine !== null && viewing() !== was) enterArena(was);
    return was;
  }
  if (v.mine !== null) stopWalking();
  const office = v.fighters.map(f => officeOf(f.userId));
  office.forEach(flash);
  v.fighters.forEach(f => { if (f.userId === ui.me) setSelfEquipment(f.equipped); });
  const m = startDuel({
    id: v.id, phase: v.phase, mine: v.mine, names: v.fighters.map(f => first(f.name)), userIds: v.fighters.map(f => f.userId),
    stats: v.fighters.map(f => f.stats), state: v.state, bodies: v.fighters.map(arenaBody), office, onStop: ended,
  });
  m.attributes = v.fighters.map(f => f.attributes);
  setDeadline(m, v);
  if (m.userIds.includes(ui.me)) { ui.outgoing = null; ui.invite = null; }
  if (m.mine !== null) {
    if ($('duelDialog').open) $('duelDialog').close();
    ui.cd = { strike: 0, blast: 0, total: { strike: m.stats[m.mine].strikeCooldown * 1000, blast: BLAST.cooldown * 1000 } };
    enterArena(m);
  }
  render();
  return m;
}

// The clock on the HUD counts to the server's deadline in real time (frames can be slow; the server's clock is not).
function setDeadline(m, v) { m.deadline = now() + (v.phase === 'fight' ? v.endsInMs ?? 0 : v.introMs ?? 0); if (v.phase === 'fight') m.fightAt ??= now(); }

// ----- effects for a server event, in the arena, if you are looking at that duel
const at = (p, y) => new THREE.Vector3(p.pos.x, y, p.pos.z);
const handsOf = p => new THREE.Vector3(p.pos.x + Math.sin(p.face) * .35, 1.05, p.pos.z + Math.cos(p.face) * .35);
function effects(m, e) {
  if (m.mine === e.who && e.kind === 'windup') { const k = e.act === 'blast' ? 'blast' : 'strike'; ui.cd[k] = now() + ui.cd.total[k]; }
  if (viewing() !== m) return;
  const into = arenaScene(), a = m.fighters[e.who], b = m.fighters[1 - e.who];
  // numbers fan out a little so quick hits do not stack on top of each other
  const over = at(b, 1.7 + Math.random() * .2).add(new THREE.Vector3((Math.random() - .5) * .5, 0, (Math.random() - .5) * .5)), dmg = Math.round(e.dmg ?? 0);
  if (e.kind === 'windup' && e.act === 'blast') spawnBurst(handsOf(a), 0x8cc7ea, .4, into);
  else if (e.kind === 'fire') {
    const bolt = e.act === 'bolt', color = bolt ? 0xffb347 : 0x8cc7ea; // a gun's bolt is orange, a Focus Blast blue
    spawnOrb(new THREE.Vector3(e.from[0], bolt ? 1.25 : 1.1, e.from[1]), new THREE.Vector3(e.aim[0], bolt ? 1.25 : 1.1, e.aim[1]), e.ms / 1000, color, into);
    if (bolt) spawnBurst(handsOf(a).setY(1.25), 0xffb347, .3, into);
  }
  else if (e.kind === 'blast') { spawnBurst(at(b, 1.15), 0x8cc7ea, .9, into); spawnNumber(over, `-${dmg}${e.crit ? '!' : ''}`, '#8cc7ea', into); }
  else if (e.kind === 'fizzle') spawnNumber(over, 'Dodged', '#a7d6be', into);
  else if (e.kind === 'hit') { spawnBurst(at(b, 1.15), e.crit ? 0xffd36b : 0xffffff, e.crit ? .8 : .5, into); spawnNumber(over, `-${dmg}${e.crit ? '!' : ''}`, e.crit ? '#ffd36b' : '#ffffff', into); }
  else if (e.kind === 'guarded') { spawnBurst(at(b, 1.15), 0x9fb3c0, .35, into); spawnNumber(over, `-${dmg}`, '#c7d3db', into); }
  else if (e.kind === 'miss') spawnNumber(over, 'Miss', '#c7d3db', into);
  else if (e.kind === 'dodge') spawnNumber(over, 'Dodge', '#a7d6be', into);
  else if (e.kind === 'parry') { spawnBurst(at(b, 1.15), 0xffffff, .7, into); spawnNumber(over, e.act === 'bolt' ? 'Deflected!' : 'Parry!', '#ffffff', into); }
}

// ----- your inputs: only in your own duel, while it is on
function myFight() { const m = myMatch(); return m && m.mine !== null && m.phase === 'fight' ? m : null; }
function act(kind) { const m = myFight(); if (!m) return false; sendDuel('duel:input', { id: m.id, act: kind }); return true; }
function guard(on) {
  if (on === ui.guarding) return;
  if (!on) { ui.guarding = false; act('guardOff'); return; }
  if (act('guardOn')) ui.guarding = true;
}

// ----- records
function wantRecords(ids, force = false) {
  for (const id of ids) if (id && (force || now() - (ui.recordsAt.get(id) ?? -Infinity) > 60000)) ui.wanted.add(id);
  if (!ui.wanted.size || ui.recordsTimer) return;
  ui.recordsTimer = setTimeout(async () => {
    ui.recordsTimer = null;
    const batch = [...ui.wanted].slice(0, 100); batch.forEach(id => ui.wanted.delete(id));
    const res = await fetchDuelRecords(batch);
    if (!ui.active) return;
    if (res.error) { ui.recordsNote = res.setup ? 'Duel records need setup: an administrator runs supabase/migrations/202611180001_duel.sql.' : ''; }
    else { ui.recordsNote = ''; for (const id of batch) { ui.records.set(id, res.records.get(id) ?? { wins: 0, losses: 0, draws: 0 }); ui.recordsAt.set(id, now()); } }
    render(); renderPerson();
    if (ui.wanted.size) wantRecords([]);
  }, 600);
}
const recordText = id => { const r = ui.records.get(id); return r ? `${r.wins}–${r.losses}–${r.draws}` : '—'; };
const statsText = a => (a ? `STR ${a.strength} · AGI ${a.agility} · INT ${a.intelligence}` : 'STR — · AGI — · INT —');

// ----- the person card (ui/person.js asks)
function duelRecordLine(p) { return p?.userId && ui.records.has(p.userId) ? ` · Duels ${recordText(p.userId)}` : ''; }
function renderDuelButton(p) {
  const b = $('pDuel'), id = p?.userId;
  if (id) wantRecords([id]);
  const show = !!id && id !== ui.me && !!onlineUser(id);
  b.hidden = !show; if (!show) return;
  const why = whyNot(id);
  b.disabled = !!why; b.textContent = why ? `Duel · ${why}` : 'Challenge to a duel';
}

// ----- the Duel panel
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
const STATUS = { connecting: 'Connecting to duels…', retrying: 'Reconnecting to duels…', 'signed-out': 'Sign in again to duel.', online: '' };
function renderPanel() {
  const me = onlineUser(ui.me);
  $('duelMeName').textContent = ui.profile?.full_name || 'You';
  $('duelMeStats').textContent = statsText(me?.attributes);
  $('duelMeRecord').textContent = `Record ${recordText(ui.me)} (W–L–D)`;
  $('duelAvailable').checked = ui.available;
  $('duelConn').textContent = STATUS[ui.status] ?? '';
  $('duelConn').hidden = !STATUS[ui.status];
  $('duelSetup').textContent = ui.recordsNote; $('duelSetup').hidden = !ui.recordsNote;
  const others = ui.online.filter(o => o.userId !== ui.me).sort((a, b) => a.name.localeCompare(b.name));
  $('duelOnline').replaceChildren(...others.map(o => {
    const li = el('li', 'duel-row'), who = el('div', 'duel-who');
    who.append(el('strong', '', o.name), el('span', 'duel-meta', `${statsText(o.attributes)} · ${recordText(o.userId)}`));
    const why = whyNot(o.userId), b = el('button', 'btn sm' + (why ? '' : ' primary'), why || 'Challenge');
    b.type = 'button'; b.disabled = !!why || ui.status !== 'online';
    b.addEventListener('click', () => challenge(o.userId));
    li.append(who, b); return li;
  }));
  $('duelNobody').hidden = others.length > 0;
}
function render() {
  if ($('duelDialog').open) renderPanel();
  $('duelBadge').hidden = !ui.invite;
  if (selected) renderPerson();
}

// ----- the HUD and the card, every frame; the DOM is touched only when something changed
function set(id, text) { if (ui.shown.get(id) !== text) { ui.shown.set(id, text); $(id).textContent = text; } }
function show(id, on) { const n = $(id); if (n.hidden === on) n.hidden = !on; }
function flag(id, cls, on) { const n = $(id); if (n.classList.contains(cls) !== on) n.classList.toggle(cls, on); }
function bar(id, frac) { const s = `scaleX(${Math.max(0, Math.min(1, frac)).toFixed(3)})`; if (ui.shown.get(id) !== s) { ui.shown.set(id, s); $(id).style.transform = s; } }
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function featured() {
  return myMatch() ?? duel.matches.find(m => m.userIds.includes(ui.me)) ?? duel.matches.at(-1) ?? null;
}
function resultText(m) {
  if (m.winner === null) return 'Draw';
  const w = m.names[m.winner], l = m.names[1 - m.winner], youWon = m.userIds[m.winner] === ui.me, youLost = m.userIds[1 - m.winner] === ui.me;
  if (m.result === 'ko') return youWon ? 'KO! You win' : `KO! ${w} wins`;
  if (m.result === 'time') return youWon ? 'Time! You win on health' : `Time! ${w} wins on health`;
  return youLost ? 'You left the duel' : `${l} left the duel — ${youWon ? 'you win' : `${w} wins`}`;
}
const leftOf = m => Math.max(0, ((m.deadline ?? 0) - now()) / 1000);
function stateText(m) {
  if (m.phase === 'intro') return 'On the rooftop · get ready';
  if (m.phase === 'end') return resultText(m);
  if (m.mine !== null && m.stagger[m.mine] > 0) return 'Parried! Staggered';
  return clock(leftOf(m));
}
// The big words in the middle of the arena: the countdown, FIGHT!, the result.
function bannerText(m) {
  if (m.phase === 'intro') return String(Math.max(1, Math.ceil(leftOf(m))));
  if (m.phase === 'fight') return now() - (m.fightAt ?? 0) < 900 ? 'Fight!' : '';
  return resultText(m);
}
function updateHud() {
  const m = viewing() ?? featured();
  show('duelHud', !!m);
  const banner = m && viewing() === m ? bannerText(m) : '';
  set('duelBanner', banner); show('duelBanner', !!banner); flag('duelBanner', 'small', !!m && m.phase === 'end');
  if (!m) return;
  const mine = m.mine, label = i => (m.userIds[i] === ui.me ? 'You' : m.names[i]);
  const left = m.userIds[1] === ui.me ? 1 : 0; // you are always on the left
  for (const [i, s] of [[left, 'A'], [1 - left, 'B']]) {
    set(`duelName${s}`, label(i));
    bar(`duelHp${s}`, m.hp[i] / m.stats[i].hp); bar(`duelMana${s}`, m.mana[i] / 100);
    set(`duelNum${s}`, `${Math.ceil(m.hp[i])} / ${m.stats[i].hp}`);
    flag(`duelSide${s}`, 'guarding', !!m.guard[i]);
    flag(`duelSide${s}`, 'winding', !!m.wind[i]); // a wind-up coming: the warning to guard
    flag(`duelSide${s}`, 'dim', m.phase === 'end' && m.winner !== null && m.winner !== i);
  }
  set('duelState', stateText(m));
  flag('duelState', 'big', m.phase === 'end');
  const fighting = mine !== null && m.phase === 'fight';
  show('duelControls', fighting);
  if (fighting) {
    const t = now(), sLeft = Math.max(0, ui.cd.strike - t), bLeft = Math.max(0, ui.cd.blast - t);
    bar('duelStrikeCd', sLeft / ui.cd.total.strike); bar('duelBlastCd', bLeft / ui.cd.total.blast);
    const noMana = m.mana[mine] < BLAST.cost;
    if ($('duelBlast').disabled !== noMana) $('duelBlast').disabled = noMana;
    flag('duelGuard', 'on', ui.guarding);
    set('duelStrikeVerb', m.stats[mine].weapon?.verb ?? 'Strike'); // Slash, Smash, Shoot… for the weapon you hold
  } else if (ui.guarding) ui.guarding = false;
  show('duelWatch', viewing() !== m && m.mine === null);
  show('duelLeave', viewing() === m && m.mine === null);
}
function updateCard() {
  const t = now(), inv = ui.invite, out = ui.outgoing;
  if (ui.note && t > ui.noteUntil) ui.note = '';
  if (inv && t > inv.until + 1500) ui.invite = null; // the server closes it; this is a safety net
  show('duelInvite', !!inv);
  if (inv) {
    set('duelInviteFrom', inv.from.name);
    set('duelInviteMeta', `${statsText(inv.from.attributes)} · ${recordText(inv.from.userId)}`);
    bar('duelInviteTime', (inv.until - t) / inv.total);
  }
  show('duelOutgoing', !!out);
  if (out) { set('duelOutgoingText', `Challenge sent to ${first(out.name)}. Waiting for an answer… ${Math.max(0, Math.ceil((out.until - t) / 1000))}`); }
  set('duelMsg', ui.note); show('duelMsg', !!ui.note);
  show('duelCard', !!inv || !!out || !!ui.note);
}
// Walking: challenge whoever you look at (G).
function lookedAt() {
  const p = ctl.active ? player.lookAt : null;
  return p?.userId && p.userId !== ui.me && onlineUser(p.userId) ? p : null;
}
function updatePrompt() {
  const p = lookedAt(), can = !!p && canChallenge(p.userId);
  show('fpDuel', can);
  if (can) keyed($('fpDuel'), ctl.coarse ? null : 'G', `Challenge ${first(p.name)} to a duel`);
}

// ----- markers over everyone online
let markerMats = null;
function swordsTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(20,30,40,.75)'; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.lineCap = 'round';
  g.beginPath(); g.moveTo(18, 18); g.lineTo(46, 46); g.moveTo(46, 18); g.lineTo(18, 46); g.stroke();
  g.lineWidth = 5; g.beginPath(); g.moveTo(14, 38); g.lineTo(26, 50); g.moveTo(50, 38); g.lineTo(38, 50); g.stroke();
  return new THREE.CanvasTexture(c);
}
function markerMaterials() {
  if (markerMats) return markerMats;
  const map = swordsTexture();
  markerMats = {
    open: new THREE.SpriteMaterial({ map, color: 0xffffff, transparent: true, depthWrite: false }),
    busy: new THREE.SpriteMaterial({ map, color: 0x8a96a0, transparent: true, opacity: .55, depthWrite: false }),
  };
  return markerMats;
}
function refreshPeople() {
  ui.personById.clear();
  for (const p of people) if (p.userId) ui.personById.set(p.userId, p);
  if (player.person?.userId) ui.personById.set(player.person.userId, player.person);
}
function syncMarkers() {
  const want = new Set(ui.online.filter(o => o.userId !== ui.me).map(o => o.userId));
  for (const [id, s] of ui.markers) if (!want.has(id)) { scene.remove(s); ui.markers.delete(id); }
  const mats = markerMaterials();
  for (const id of want) {
    let s = ui.markers.get(id);
    if (!s) { s = new THREE.Sprite(mats.open); s.scale.setScalar(.2); s.renderOrder = 4; scene.add(s); ui.markers.set(id, s); }
    s.material = canChallenge(id) || (onlineUser(id)?.available && !onlineUser(id)?.busy) ? mats.open : mats.busy;
  }
}
function placeMarkers() {
  for (const [id, s] of ui.markers) {
    const p = ui.personById.get(id), seen = !!p && p.state !== 'away' && p.body.root.visible;
    s.visible = seen;
    if (seen) s.position.set(p.pos.x, (p.body.eyeY ?? 1.35) + .55, p.pos.z);
  }
}

// Per frame, from main.js.
function updateDuelUi(dt) {
  if (!ui.active) return;
  ui.acc += dt;
  if (ui.acc > .25) { ui.acc = 0; refreshPeople(); syncMarkers(); updatePrompt(); }
  for (const m of [...duel.matches]) if (m.phase === 'end' && now() > m.deadline) stopDuel(m);
  updateDuelArena(dt, now(), viewing() ? leftOf(viewing()) : 0);
  placeMarkers(); updateHud(); updateCard();
}

// ----- server events
function initEvents() {
  const byId = id => duel.matches.find(m => m.id === id);
  onDuel('duel:hello', ({ you, matches }) => {
    ui.me = you;
    const ids = new Set(matches.map(v => v.id));
    for (const m of [...duel.matches]) if (!ids.has(m.id)) stopDuel(m); // ended while we were away
    matches.forEach(begin);
  });
  onDuel('duel:online', list => {
    ui.online = Array.isArray(list) ? list : [];
    ui.byId = new Map(ui.online.map(o => [o.userId, o]));
    const mine = ui.byId.get(ui.me); if (mine) ui.available = mine.available;
    wantRecords(ui.online.map(o => o.userId));
    syncMarkers(); render();
  });
  onDuel('duel:invite', inv => { ui.invite = { ...inv, until: now() + inv.expiresInMs, total: inv.expiresInMs }; wantRecords([inv.from.userId]); render(); });
  onDuel('duel:invite-closed', ({ id, why }) => {
    if (ui.invite?.id !== id) return;
    ui.invite = null;
    if (why === 'expired') note('The challenge expired'); else if (why === 'cancelled') note('The challenge was withdrawn');
    render();
  });
  onDuel('duel:declined', ({ id, userId, name, why }) => {
    if (why === 'declined' || why === 'expired') ui.blocked.set(userId, now() + DUEL_LIMITS.repeatMs);
    if (ui.outgoing?.id !== id) return;
    ui.outgoing = null;
    const n = first(name);
    const text = { declined: `${n} said no`, expired: `${n} didn't answer`, offline: `${n} went offline`, full: 'Too many duels are on right now, try again in a bit' }[why];
    if (text) note(text);
    render();
  });
  onDuel('duel:failed', ({ why }) => { ui.outgoing = null; note(why || 'Duels are unavailable right now'); render(); });
  onDuel('duel:start', v => begin(v));
  onDuel('duel:fight', v => { const m = byId(v.id); if (!m) begin(v); else { duelFight(m); if (v.state) duelState(m, v.state); setDeadline(m, v); } });
  onDuel('duel:event', e => { const m = byId(e.id); if (!m) return; duelEvent(m, e); effects(m, e); });
  onDuel('duel:state', s => { const m = byId(s.id); if (m) { duelState(m, s); reconcile(m); } });
  onDuel('duel:control', ({ id, mine }) => { const m = byId(id); if (m) m.mine = mine; });
  onDuel('duel:end', ({ id, winner, result, dealt }) => {
    const m = byId(id); if (!m) return;
    duelEnd(m, winner === null ? null : m.userIds.indexOf(winner), result, dealt);
    m.deadline = now() + DUEL_TIME.end * 1000; // the result stays up this long, in real time
    ui.guarding = false;
    setTimeout(() => wantRecords(m.userIds, true), 1500);
  });
}
function initInputs() {
  // keys: J strike, K or Shift guard (hold), Q or L blast; only in your own duel (they do nothing else then)
  listen(window, 'keydown', e => {
    if (!myFight() || typing(e) || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'j') { if (!e.repeat) act('strike'); }
    else if (k === 'k' || k === 'shift') guard(true);
    else if (k === 'q' || k === 'l') { if (!e.repeat) act('blast'); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  listen(window, 'keyup', e => { const k = e.key.toLowerCase(); if (k === 'k' || k === 'shift') guard(false); });
  listen(window, 'blur', () => guard(false));
  // mouse: left click strikes, holding the right button guards
  const canvas = renderer.domElement;
  listen(canvas, 'pointerdown', e => {
    if (e.pointerType !== 'mouse' || !myFight()) return;
    if (e.button === 0) act('strike'); else if (e.button === 2) guard(true);
  }, true);
  listen(window, 'pointerup', e => { if (e.pointerType === 'mouse' && e.button === 2) guard(false); });
  // walking: G challenges whoever you look at
  listen(window, 'keydown', e => {
    if (e.key.toLowerCase() !== 'g' || e.repeat || typing(e)) return;
    const p = lookedAt(); if (p && canChallenge(p.userId)) challenge(p.userId);
  });
  // the HUD's buttons (touch, or a freed cursor)
  listen($('duelStrike'), 'click', () => act('strike'));
  listen($('duelBlast'), 'click', () => act('blast'));
  listen($('duelGuard'), 'pointerdown', e => { e.preventDefault(); guard(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) listen($('duelGuard'), ev, () => guard(false));
}

function initDuel(profile) {
  if (!profile?.id) { $('duelBtn').disabled = true; return; }
  Object.assign(ui, { profile, me: profile.id, active: true, available: savedAvailability() });
  initEvents();
  initInputs();
  initDuelArena({ onLeave: leaveArena }); // (after initInputs: its canvas listener holds back the office camera's)
  listen($('duelBtn'), 'click', () => { renderPanel(); $('duelDialog').showModal(); wantRecords([ui.me, ...ui.online.map(o => o.userId)]); });
  listen($('duelClose'), 'click', () => $('duelDialog').close());
  listen($('duelDialog'), 'keydown', e => e.stopPropagation()); // typing in the panel never moves the camera
  listen($('duelAvailable'), 'change', e => toggleAvailable(e.target.checked));
  listen($('duelAccept'), 'click', () => answer(true));
  listen($('duelDecline'), 'click', () => answer(false));
  listen($('duelCancel'), 'click', cancel);
  listen($('duelWatch'), 'click', () => { const m = featured(); if (m) enterArena(m); });
  listen($('duelLeave'), 'click', leaveArena);
  listen($('pDuel'), 'click', () => { if (selected?.userId) challenge(selected.userId); });
  listen($('walkBtn'), 'click', () => { walkAsSelf(); setView('third'); });
  connectDuel({ onStatus: status => { ui.status = status; render(); } });
}

function stopDuelUi() {
  if (!ui.active) return;
  ui.active = false;
  disconnectDuel();
  clearTimeout(ui.recordsTimer); ui.recordsTimer = null;
  for (const remove of ui.listeners) remove();
  ui.listeners.length = 0;
  for (const m of [...duel.matches]) stopDuel(m);
  stopDuelArena(); disposeArena();
  for (const s of ui.markers.values()) scene.remove(s);
  ui.markers.clear(); clearDuelFx();
  if ($('duelDialog').open) $('duelDialog').close();
  Object.assign(ui, { online: [], byId: new Map(), invite: null, outgoing: null, note: '', guarding: false });
}

export { duelRecordLine, initDuel, renderDuelButton, stopDuelUi, updateDuelUi };
