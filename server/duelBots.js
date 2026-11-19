import { characterAttributes } from '../src/config/marketplace.js';
import { BLAST, DUEL_TICK_MS, MOVE, WEAPONS, duelStats } from '../src/config/duel.js';
import { act, dist, makeFight, move, tick } from './duelEngine.js';

// Bot fighters for the balance test (duelBalance.test.js): they play a whole duel against the real engine, moving
// and all, so a change to the rules or the catalog shows up as a change in who wins. Not used by the running app.
// Skill, as chances when they see something coming: `parry` timing a parry against a strike (or deflecting a bolt),
// `space` stepping out of
// reach instead, `block` at least holding a guard, `sidestep` getting out of a blast's way. `react`: how late (ms) a
// plain block comes; `hesitate`: the most (ms) they wait before attacking again (people do not press buttons in
// lockstep; without it, fights turn on who needs one hit fewer).
const SKILL = {
  novice: { parry: .05, space: .05, block: .15, sidestep: .2, react: 260, hesitate: 600 },
  average: { parry: .25, space: .2, block: .35, sidestep: .5, react: 200, hesitate: 400 },
  skilled: { parry: .5, space: .35, block: .5, sidestep: .8, react: 150, hesitate: 250 },
};
const build = equipment => duelStats(characterAttributes(equipment).total, equipment.weapon ?? null);
// Full sets from the current catalog (src/config/marketplace.js), one per attribute focus.
const BUILDS = {
  base: build({}),
  strength: build({ outfit: 'outfit-ember', armor: 'armor-solar', pet: 'pet-sprout' }),
  agility: build({ outfit: 'outfit-ember', armor: 'armor-sentinel', pet: 'pet-sprout' }),
  intelligence: build({ outfit: 'outfit-tide', armor: 'armor-solar', pet: 'pet-cloud' }),
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function play(fight, side, bot, skill, now, rng) {
  const me = fight.f[side], them = fight.f[1 - side], d = Math.max(1e-6, dist(me.pos, them.pos));
  const mine = me.stats.weapon ?? WEAPONS.fists, theirs = them.stats.weapon ?? WEAPONS.fists;
  // something fired at me: maybe step out of its way (bolts are faster: harder), else guard against a bolt
  for (const s of fight.shots) if (s.side !== side && bot.shot !== s) {
    bot.shot = s;
    const speed = s.kind === 'bolt' ? them.stats.weapon.speed : BLAST.speed; // the faster it flies, the harder to get out of the way
    bot.dodge = rng() < skill.sidestep * Math.min(1, BLAST.speed / speed) ? { until: s.at, dir: rng() < .5 ? 1 : -1 } : null;
    if (!bot.dodge && s.kind === 'bolt') { // stand and deflect it with a timed guard, or at least block
      if (rng() < skill.parry) bot.plan = { on: s.at - 40 - rng() * 180, off: s.at + 120 };
      else if (rng() < skill.block) bot.plan = { on: Math.min(s.at, now + skill.react), off: s.at + 60 };
    }
  }
  // a melee strike winding up (seen a tick late, like a person): parry, step back out of reach, or block
  const p = them.pending;
  if (p?.kind === 'strike' && theirs.kind === 'melee' && bot.seen !== p.at && p.at - theirs.windup * 1000 < now) {
    bot.seen = p.at;
    if (rng() < skill.parry) bot.plan = { on: p.at - 40 - rng() * 180, off: p.at + 120 };
    else if (rng() < skill.space) bot.back = p.at + 100;
    else if (rng() < skill.block) bot.plan = { on: Math.min(p.at, now + skill.react), off: p.at + 120 };
  }
  // where to go this tick: sideways out of something fired, back out of reach, in to striking range, or (with a gun)
  // keep a good distance
  const step = MOVE.speed * DUEL_TICK_MS / 1000, ux = (them.pos.x - me.pos.x) / d, uz = (them.pos.z - me.pos.z) / d;
  let tx = me.pos.x, tz = me.pos.z;
  const closer = mine.kind === 'gun' ? d > 6 : d > mine.reach * .75, further = mine.kind === 'gun' && d < 4;
  if (bot.dodge && now < bot.dodge.until) {
    // out of the way sideways; with a melee weapon and out of reach, diagonally forward (still closing in)
    const fwd = mine.kind === 'melee' && d > mine.reach ? .6 : 0, side = Math.sqrt(1 - fwd * fwd);
    tx += (-uz * bot.dodge.dir * side + ux * fwd) * step; tz += (ux * bot.dodge.dir * side + uz * fwd) * step;
  }
  else if ((bot.back && now < bot.back) || further) { tx -= ux * step; tz -= uz * step; }
  else if (closer) { tx += ux * step; tz += uz * step; }
  move(fight, side, tx, tz, now);
  if (bot.plan) {
    if (now >= bot.plan.off) { act(fight, side, 'guardOff', now); bot.plan = null; }
    else if (now >= bot.plan.on && !me.guard) act(fight, side, 'guardOn', now);
    return;
  }
  if (me.pending || now < me.staggerUntil) return;
  if (bot.waitUntil === undefined) bot.waitUntil = now + rng() * skill.hesitate;
  if (now < bot.waitUntil) return;
  const inRange = mine.kind === 'gun' ? d <= 9 : d <= mine.reach * .95;
  const ev = (me.mana >= BLAST.cost && act(fight, side, 'blast', now)) || (inRange && act(fight, side, 'strike', now));
  if (ev) bot.waitUntil = undefined;
}

// One duel between two bots: { winner, result, hp }.
function simulate(statsA, statsB, skillA, skillB, seed) {
  const rng = mulberry32(seed), botRng = mulberry32(seed * 7919 + 1), fight = makeFight(statsA, statsB, 0, rng);
  const bots = [{}, {}];
  for (let now = 0, n = 0; !fight.over; now += DUEL_TICK_MS, n++) {
    // take turns at going first, so neither bot always gets a move in before the other
    const first = n % 2;
    play(fight, first, bots[first], first ? skillB : skillA, now, botRng);
    play(fight, 1 - first, bots[1 - first], first ? skillA : skillB, now, botRng);
    tick(fight, now);
  }
  return { winner: fight.winner, result: fight.result, hp: fight.f.map(f => f.hp) };
}

// Share of `n` seeded duels that A wins, draws, and that end in a knockout.
function winRate(statsA, statsB, skillA, skillB, n = 2000, seed = 1) {
  let won = 0, drawn = 0, ko = 0;
  for (let i = 0; i < n; i++) {
    const r = simulate(statsA, statsB, skillA, skillB, seed + i);
    if (r.winner === 0) won++; if (r.winner === null) drawn++; if (r.result === 'ko') ko++;
  }
  return { win: won / n, draw: drawn / n, ko: ko / n };
}

export { BUILDS, SKILL, mulberry32, simulate, winRate };
