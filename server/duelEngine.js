import { ARENA, BLAST, CRIT, DRAW_MARGIN, DUEL_TIME, GUARD, JUMP, MANA, MOVE, STRIKE, WEAPONS } from '../src/config/duel.js';

// One duel's fight, refereed on the server (server/duel.js). Pure: time comes in as `now` (ms) and chance from the
// injected `rng`, so tests and the balance simulation can replay fights exactly. Fighters only send intents (act)
// and where they want to be (move); every outcome is decided here, with the server's own positions.
// A fight: { f: [fighter, fighter], shots (Focus Blasts in flight), at, endsAt, last, rng, over, winner, result }.
// A fighter: { stats (config/duel.js duelStats), hp, mana, guard, guardAt, parryable, rearmAt, strikeAt, blastAt,
// staggerUntil, pending ({ kind, at } while winding up), dealt, pos ({ x, z } metres from the helipad's middle),
// movedAt, budget (metres it may still move right now) }.
const ms = s => s * 1000;
const round1 = v => Math.round(v * 10) / 10;
const round2 = v => Math.round(v * 100) / 100;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const weapon = me => me.stats.weapon ?? WEAPONS.fists; // (stats made before weapons existed: fists)

function fighter(stats, now, x) {
  return {
    stats, hp: stats.hp, mana: MANA.start, guard: false, guardAt: -Infinity, parryable: false, rearmAt: now,
    strikeAt: now, blastAt: now, staggerUntil: 0, pending: null, dealt: 0, airUntil: 0, jumpAt: now,
    pos: { x, z: 0 }, movedAt: now, budget: 0,
  };
}
function makeFight(statsA, statsB, now, rng = Math.random) {
  return {
    f: [fighter(statsA, now, -ARENA.start), fighter(statsB, now, ARENA.start)], shots: [],
    at: now, endsAt: now + ms(DUEL_TIME.fight), last: now, rng, over: false, winner: null, result: null,
  };
}

// On the helipad, and not inside the other one.
function place(p, other) {
  let { x, z } = p;
  const r = Math.hypot(x, z);
  if (r > ARENA.radius) { x *= ARENA.radius / r; z *= ARENA.radius / r; }
  let gx = x - other.x, gz = z - other.z, g = Math.hypot(gx, gz);
  if (g < MOVE.gap) {
    if (g < 1e-6) { gx = 1; gz = 0; g = 1; }
    x = other.x + gx / g * MOVE.gap; z = other.z + gz / g * MOVE.gap;
  }
  return { x, z };
}
// How fast a fighter can move right now: staggered, winding up or guarding slow you; some weapons are heavy (`pace`).
const pace = (me, now) => (now < me.staggerUntil ? MOVE.stagger : me.pending ? MOVE.windup : me.guard ? MOVE.guard : 1) * (weapon(me).pace ?? 1);

// A fighter wants to be at (x, z). They get as close as their speed allows since their last move (with a little slack
// for network jitter, never more than MOVE.burst seconds' worth at once). Returns true when the server's position
// differs from the one asked for (the browser should snap back).
function move(fight, side, x, z, now) {
  if (fight.over || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  const me = fight.f[side], them = fight.f[1 - side];
  me.budget = Math.min(MOVE.speed * MOVE.burst, me.budget + MOVE.speed * pace(me, now) * MOVE.slack * Math.max(0, now - me.movedAt) / 1000);
  me.movedAt = now;
  let dx = x - me.pos.x, dz = z - me.pos.z;
  const want = Math.hypot(dx, dz);
  if (want > me.budget) { const k = me.budget / want; dx *= k; dz *= k; }
  me.budget -= Math.hypot(dx, dz);
  me.pos = place({ x: me.pos.x + dx, z: me.pos.z + dz }, them.pos);
  return Math.hypot(me.pos.x - x, me.pos.z - z) > .05;
}

// A fighter's intent. Returns the event to tell everyone, or null when it is not allowed right now.
function act(fight, side, kind, now) {
  if (fight.over) return null;
  const me = fight.f[side], busy = !!me.pending || now < me.staggerUntil || now < me.airUntil; // (nothing else mid-air)
  if (kind === 'jump') {
    if (busy || me.guard || now < me.jumpAt) return null;
    me.airUntil = now + ms(JUMP.air); me.jumpAt = now + ms(JUMP.cooldown);
    return { who: side, kind: 'jump', ms: ms(JUMP.air) };
  }
  if (kind === 'strike') { // with fists, a melee weapon, or a gun (its wind-up and cooldown: config/duel.js WEAPONS)
    if (busy || me.guard || now < me.strikeAt) return null;
    const w = weapon(me);
    me.pending = { kind: 'strike', at: now + ms(w.windup) };
    me.strikeAt = now + ms(me.stats.strikeCooldown * w.cooldown);
    return { who: side, kind: 'windup', act: 'strike', ms: ms(w.windup) };
  }
  if (kind === 'blast') {
    if (busy || me.guard || now < me.blastAt || me.mana < BLAST.cost) return null;
    me.mana -= BLAST.cost;
    me.pending = { kind: 'blast', at: now + ms(BLAST.windup) };
    me.blastAt = now + ms(BLAST.cooldown);
    return { who: side, kind: 'windup', act: 'blast', ms: ms(BLAST.windup) };
  }
  if (kind === 'guardOn') {
    if (busy || me.guard) return null;
    me.guard = true; me.guardAt = now; me.parryable = now >= me.rearmAt; me.rearmAt = now + ms(GUARD.rearm);
    return { who: side, kind: 'guard', on: true };
  }
  if (kind === 'guardOff') {
    if (!me.guard) return null;
    me.guard = false;
    return { who: side, kind: 'guard', on: false };
  }
  return null;
}

function hit(fight, side, dmg, what, crit) {
  const me = fight.f[side], them = fight.f[1 - side];
  const d = Math.min(them.hp, round1(dmg));
  them.hp = round1(them.hp - d); me.dealt = round1(me.dealt + d);
  return { who: side, kind: what, dmg: d, crit };
}
// A wind-up finishes. A melee strike connects only within the weapon's reach, then can be dodged, guarded or parried.
// A blast, or a gun's bolt, leaves the hands aimed where the other one stands now, and is judged when it arrives.
function land(fight, side) {
  const me = fight.f[side], them = fight.f[1 - side], { kind, at } = me.pending, rng = fight.rng, w = weapon(me);
  me.pending = null;
  const crit = rng() < me.stats.crit;
  if (kind === 'blast' || w.kind === 'gun') {
    const speed = kind === 'blast' ? BLAST.speed : w.speed, flight = dist(me.pos, them.pos) / speed * 1000;
    fight.shots.push({ side, kind: kind === 'blast' ? 'blast' : 'bolt', aim: { ...them.pos }, at: at + flight, crit });
    return { who: side, kind: 'fire', act: kind === 'blast' ? 'blast' : 'bolt', from: [round2(me.pos.x), round2(me.pos.z)], aim: [round2(them.pos.x), round2(them.pos.z)], ms: Math.round(flight) };
  }
  if (dist(me.pos, them.pos) > w.reach) return { who: side, kind: 'miss' };
  if (rng() < them.stats.dodge) return { who: side, kind: 'dodge' };
  const dmg = me.stats.strike * w.dmg * (1 + (rng() * 2 - 1) * STRIKE.variance) * (crit ? CRIT.mult : 1);
  if (them.guard && them.guardAt <= at) { // a guard that came in after the impact time (same server tick) is too late
    if (them.parryable && at - them.guardAt <= ms(GUARD.parry)) {
      me.staggerUntil = at + ms(GUARD.stagger);
      return { who: side, kind: 'parry', ms: ms(GUARD.stagger) };
    }
    return hit(fight, side, dmg * GUARD.factor, 'guarded', crit);
  }
  return hit(fight, side, dmg, 'hit', crit);
}
// Something fired arrives. A blast cannot be guarded or dodged by chance, only by not being there. A gun's bolt can
// also be dodged by agility, mostly stopped by a guard, and deflected by a perfectly timed one (the shooter is
// staggered, like a parry).
function arrive(fight, shot) {
  const me = fight.f[shot.side], them = fight.f[1 - shot.side], mult = shot.crit ? CRIT.mult : 1;
  if (shot.at < them.airUntil) return { who: shot.side, kind: 'fizzle', act: shot.kind, jumped: true }; // jumped over it
  if (shot.kind === 'blast') {
    if (dist(them.pos, shot.aim) > BLAST.radius) return { who: shot.side, kind: 'fizzle' };
    return hit(fight, shot.side, me.stats.blast * mult, 'blast', shot.crit);
  }
  const w = weapon(me);
  if (dist(them.pos, shot.aim) > w.radius) return { who: shot.side, kind: 'fizzle', act: 'bolt' };
  if (fight.rng() < them.stats.dodge) return { who: shot.side, kind: 'dodge' };
  const dmg = me.stats.strike * w.dmg * (1 + (fight.rng() * 2 - 1) * STRIKE.variance) * mult;
  if (them.guard && them.guardAt <= shot.at) {
    if (them.parryable && shot.at - them.guardAt <= ms(GUARD.parry)) {
      me.staggerUntil = Math.max(me.staggerUntil, shot.at + ms(GUARD.stagger));
      return { who: shot.side, kind: 'parry', act: 'bolt', ms: ms(GUARD.stagger) };
    }
    return hit(fight, shot.side, dmg * GUARD.bolt, 'guarded', shot.crit);
  }
  return hit(fight, shot.side, dmg, 'hit', shot.crit);
}

// Advance the fight to `now`: mana comes back, wind-ups and blasts that are due land (earliest first), then a
// knockout or the time limit ends it. Returns the events, in order.
function tick(fight, now) {
  if (fight.over) return [];
  const dt = Math.max(0, now - fight.last) / 1000, events = [];
  fight.last = now;
  for (const me of fight.f) me.mana = Math.min(MANA.max, me.mana + me.stats.manaRegen * dt);
  const due = [];
  for (const side of [0, 1]) { const p = fight.f[side].pending; if (p && p.at <= now) due.push({ at: p.at, side, shot: null }); }
  for (const shot of fight.shots) if (shot.at <= now) due.push({ at: shot.at, side: shot.side, shot });
  fight.shots = fight.shots.filter(s => s.at > now);
  due.sort((a, b) => a.at - b.at);
  let downAt = Infinity;
  for (const d of due) {
    const me = fight.f[d.side];
    // knocked out by an earlier hit: this wind-up never finishes (one at the very same moment still does: a draw)
    if (!d.shot && me.hp <= 0 && d.at > downAt) { me.pending = null; continue; }
    events.push(d.shot ? arrive(fight, d.shot) : land(fight, d.side));
    if (fight.f[1 - d.side].hp <= 0) downAt = Math.min(downAt, d.at);
  }
  const [a, b] = fight.f;
  if (a.hp <= 0 || b.hp <= 0) finish(fight, a.hp <= 0 && b.hp <= 0 ? null : a.hp <= 0 ? 1 : 0, a.hp <= 0 && b.hp <= 0 ? 'draw' : 'ko');
  else if (now >= fight.endsAt) {
    const pa = a.hp / a.stats.hp, pb = b.hp / b.stats.hp;
    if (Math.abs(pa - pb) <= DRAW_MARGIN) finish(fight, null, 'draw'); else finish(fight, pa > pb ? 0 : 1, 'time');
  }
  return events;
}
function finish(fight, winner, result) { Object.assign(fight, { over: true, winner, result }); }
function forfeit(fight, side) { if (!fight.over) finish(fight, 1 - side, 'forfeit'); }

// What the browsers show between events: positions, health, mana and guard, rounded.
function snapshot(fight) {
  return {
    pos: fight.f.map(x => [round2(x.pos.x), round2(x.pos.z)]),
    hp: fight.f.map(x => round1(x.hp)), mana: fight.f.map(x => Math.floor(x.mana)), guard: fight.f.map(x => x.guard),
  };
}

export { act, dist, forfeit, makeFight, move, snapshot, tick };
