import { ARENA, DUEL_TIME, MOVE } from '../config/duel.js';
import { angDiff } from '../core/util.js';
import { addLog } from './state.js';
import { endTask } from './tasks.js';

/* ================= Duels ================= */
// The server referees every duel (server/duel.js); this module keeps each one's picture. A duel happens away from the
// office, on the rooftop arena (world/arena.js): the two fighters' characters in the office are hidden for the duel
// ("In a duel") and come back where they were afterwards, while two arena fighters (made by ui/duel.js, in the arena's
// own scene) do the fighting. ui/duel.js passes the server's events in; your own fighter's position is moved by
// ui/duelArena.js (your keys), the other one's follows the server.
// A match: { id, names, userIds, mine (the side this browser fights for, or null), phase ('intro', 'fight' or 'end'),
// t (seconds into the phase), stats, hp, mana, guard, wind (a wind-up per side: { act, t, dur }), swing / hurt /
// dodged / missed (seconds since, or null), stagger (seconds left), lastAct, winner (side or null), result, dealt,
// fighters (the two arena fighters), office (each one's character in the office, or null), was (how the office left
// them), onStop (ui: called when it is over) }.
// An arena fighter: { body, pos, goal (the server's position), face, state ('doing' or 'walking'), task, pose, animT,
// walkPhase, last (position a frame ago), moving }.
const duel = { matches: [] };

const inDuel = p => duel.matches.some(m => m.office.includes(p));

// Take someone's office character out for the duel: hidden, not doing anything, Live's attendance refresh leaves them
// alone (sim/day.js). `was` remembers enough to put them back.
function leaveOffice(p, m) {
  const was = { state: p.state, visible: p.body.root.visible, ring: p.body.ring.visible };
  endTask(p);
  Object.assign(p, { state: 'doing', task: { kind: 'duel', cat: 'break', anim: 'stand', until: Infinity, duel: m }, until: Infinity, path: null, chatWith: null });
  p.body.root.visible = p.body.ring.visible = false;
  return was;
}
function backToOffice(p, was) {
  if (p.task?.duel) p.task = null;
  p.path = null; p.dizzy = false;
  p.body.root.visible = was.visible; p.body.ring.visible = was.ring;
  if (p.id === -1) p.state = 'player';    // your own character: yours again
  else if (was.state === 'away') p.state = 'away';
  else p.state = 'idle';                   // sim/tasks.js chooseNext picks what next
}

function arenaFighter(body, x, m, side) {
  return {
    body, pos: body.root.position.set(x, 0, 0).clone(), goal: { x, z: 0 }, last: { x, z: 0 }, face: side ? -Math.PI / 2 : Math.PI / 2,
    state: 'doing', task: { kind: 'duel', anim: 'duelReady', duel: m, run: true }, pose: {}, animT: Math.random() * 10, walkPhase: 0, moving: false,
  };
}

// A duel the server started (or one already going when we connected). `o`: { id, phase, mine, names, userIds, stats,
// state, bodies (the two arena fighters' rigs), office (their office characters or null), onStop }.
function startDuel(o) {
  for (const old of [...duel.matches]) if (old.id === o.id) stopDuel(old);
  const m = {
    id: o.id, names: o.names, userIds: o.userIds, mine: o.mine ?? null, phase: o.phase === 'fight' ? 'fight' : 'intro', t: 0, stats: o.stats,
    hp: o.state?.hp ?? o.stats.map(s => s.hp), mana: o.state?.mana ?? [50, 50], guard: o.state?.guard ?? [false, false],
    wind: [null, null], swing: [null, null], hurt: [null, null], dodged: [null, null], missed: [null, null], stagger: [0, 0], lastAct: [null, null],
    winner: null, result: null, dealt: [0, 0], office: [...o.office], was: [null, null], onStop: o.onStop ?? (() => {}),
  };
  m.fighters = o.bodies.map((body, i) => arenaFighter(body, i ? ARENA.start : -ARENA.start, m, i));
  if (o.state?.pos) duelState(m, o.state, true);
  m.office.forEach((p, i) => { if (p) m.was[i] = leaveOffice(p, m); });
  duel.matches.push(m);
  addLog(`${m.names[0]} and ${m.names[1]} went up to the rooftop for a duel`);
  return m;
}

function duelFight(m) { Object.assign(m, { phase: 'fight', t: 0 }); }

// A server event: { who, kind, act?, ms?, dmg?, crit?, on? }. With a gun, the shot is the `fire` event and everything
// after it (hit, guarded, dodge, a deflection, a miss) is the bolt arriving: the shooter's arm does not swing again.
function duelEvent(m, e) {
  const s = e.who, o = 1 - s, gun = m.stats[s].weapon?.kind === 'gun';
  if (e.kind === 'windup') { m.wind[s] = { act: e.act, t: 0, dur: e.ms / 1000 }; return; }
  if (e.kind === 'guard') { m.guard[s] = !!e.on; return; }
  if (e.kind === 'fire') { m.lastAct[s] = e.act === 'bolt' ? 'bolt' : 'blast'; m.wind[s] = null; m.swing[s] = 0; return; }
  if (e.kind === 'fizzle') { m.dodged[o] = 0; return; } // something fired that found nobody there
  if (e.kind === 'blast') { m.hp[o] = Math.max(0, m.hp[o] - e.dmg); m.hurt[o] = 0; m.dealt[s] += e.dmg; return; } // it arrives
  if (!gun) { m.lastAct[s] = m.wind[s]?.act ?? 'strike'; m.wind[s] = null; m.swing[s] = 0; }
  if (e.kind === 'hit' || e.kind === 'guarded') { m.hp[o] = Math.max(0, m.hp[o] - e.dmg); m.hurt[o] = 0; m.dealt[s] += e.dmg; }
  else if (e.kind === 'dodge') m.dodged[o] = 0;
  else if (e.kind === 'miss') m.missed[s] = 0;
  else if (e.kind === 'parry') { m.stagger[s] = e.ms / 1000; m.swing[s] = null; }
}
// The server's picture, 20 times a second. The other fighter glides to `goal`; your own position stays yours (ui/
// duelArena.js decides when the server has really corrected you: the server's view of you is always a little behind
// on a real network). `snap` puts everyone where the server says at once (joining late).
function duelState(m, s, snap = false) {
  m.hp = s.hp; m.mana = s.mana; m.guard = s.guard;
  s.pos?.forEach(([x, z], i) => {
    const f = m.fighters[i]; f.goal = { x, z };
    if (snap) { f.pos.x = x; f.pos.z = z; }
  });
}
function duelEnd(m, winner, result, dealt) {
  Object.assign(m, { phase: 'end', t: 0, winner, result, wind: [null, null], guard: [false, false], stagger: [0, 0] });
  if (dealt) m.dealt = dealt;
  const [a, b] = m.names;
  addLog(winner === null ? `${a} and ${b} drew a duel` : `${m.names[winner]} beat ${m.names[1 - winner]} in a duel${result === 'ko' ? ' by KO' : ''}`);
}

// The duel is over: the two come back to the office where they were; the arena fighters go (ui disposes them).
function stopDuel(m) {
  const i = duel.matches.indexOf(m); if (i < 0) return;
  duel.matches.splice(i, 1);
  m.office.forEach((p, side) => { if (p && m.was[side]) backToOffice(p, m.was[side]); });
  m.onStop(m);
}

// Each fighter's pose for the moment (people/animation.js); `dizzy` (staggered by a parry) puts birds round the head.
// Moving shows the run, unless they are in the middle of something.
// Each weapon swings its own way (people/animation.js): blades slash, the staff thrusts, guns aim and kick, fists punch.
// `task.k` is how far through the wind-up (the hit lands at 1) or the follow-through it is.
const FOLLOW = .4; // seconds of follow-through after a strike lands (or a shot leaves)
function pose(m, f, i) {
  let a = null;
  const w = m.stats[i].weapon ?? { model: 'fists', kind: 'melee' }, gun = w.kind === 'gun', staff = w.model === 'staff';
  const blade = w.kind === 'melee' && w.model !== 'fists' && !staff;
  f.task.two = w.model === 'greatsword' || w.model === 'hammer' || w.model === 'rifle';
  if (m.phase === 'end') a = i === m.winner ? 'cheer' : m.winner === null ? null : m.result === 'ko' ? 'slapKO' : 'duelLose';
  else if (m.stagger[i] > 0) a = 'slapDizzy';
  else if (m.hurt[i] !== null && m.hurt[i] < .3) a = 'duelHurt';
  else if (m.wind[i]) {
    f.task.k = Math.min(1, m.wind[i].t / m.wind[i].dur);
    a = m.wind[i].act === 'blast' ? 'duelCharge' : gun ? 'duelAim' : staff ? 'duelThrust' : blade ? 'duelSlash' : 'duelWind';
  } else if (m.swing[i] !== null && m.swing[i] < (w.model === 'fists' ? .3 : FOLLOW)) {
    f.task.k = m.swing[i] / FOLLOW;
    a = m.lastAct[i] === 'blast' ? 'duelBlast' : gun ? 'duelShoot' : staff ? 'duelThrustHit' : blade ? 'duelSlashFollow' : 'duelPunch';
  } else if (m.guard[i]) a = 'duelGuard';
  else if (m.dodged[i] !== null && m.dodged[i] < .35) a = 'duelDodge';
  f.state = !a && f.moving ? 'walking' : 'doing';
  f.task.anim = a ?? (gun ? 'duelReadyGun' : blade || staff ? 'duelReadyBlade' : 'duelReady');
  f.dizzy = a === 'slapDizzy';
}

// Every frame, in real seconds, paused or not (the server's clock does not stop): timers, the other fighter gliding to
// the server's position, both facing each other (locked on), and poses.
function updateDuel(dt) {
  const k = 1 - Math.exp(-dt * 14);
  for (const m of duel.matches) {
    m.t += dt;
    for (let i = 0; i < 2; i++) {
      if (m.wind[i]) m.wind[i].t += dt;
      for (const key of ['swing', 'hurt', 'dodged', 'missed']) if (m[key][i] !== null) m[key][i] += dt;
      m.stagger[i] = Math.max(0, m.stagger[i] - dt);
      const f = m.fighters[i];
      if (i !== m.mine || m.phase !== 'fight') { f.pos.x += (f.goal.x - f.pos.x) * k; f.pos.z += (f.goal.z - f.pos.z) * k; }
      const moved = Math.hypot(f.pos.x - f.last.x, f.pos.z - f.last.z);
      f.moving = moved > MOVE.speed * dt * .15;
      f.walkPhase += moved * 4.6; f.animT += dt;
      f.last.x = f.pos.x; f.last.z = f.pos.z;
    }
    for (let i = 0; i < 2; i++) {
      const f = m.fighters[i], o = m.fighters[1 - i];
      const want = Math.atan2(o.pos.x - f.pos.x, o.pos.z - f.pos.z);
      f.face += angDiff(f.face, want) * (1 - Math.exp(-dt * 16));
      f.faceGoal = f.face;
      pose(m, f, i);
    }
  }
  // stopping is decided in real time by ui/duel.js; this is the safety net if that never comes
  for (const m of [...duel.matches]) if (m.phase === 'end' && m.t > DUEL_TIME.end * 3) stopDuel(m);
}

export { duel, duelEnd, duelEvent, duelFight, duelState, inDuel, startDuel, stopDuel, updateDuel };
