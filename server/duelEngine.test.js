import assert from 'node:assert/strict';
import test from 'node:test';
import { ARENA, BLAST, DUEL_TIME, GUARD, HP, MANA, MOVE, STRIKE, duelStats } from '../src/config/duel.js';
import { characterAttributes } from '../src/config/marketplace.js';
import { act, forfeit, makeFight, move, snapshot, tick } from './duelEngine.js';

const base = duelStats();
// rng returning queued values (then .5): [crit roll, dodge roll, variance roll] per strike
const queue = (...values) => () => (values.length ? values.shift() : .5);
const NO_LUCK = [.99, .99, .5]; // no crit, no dodge, no variance
const W = STRIKE.windup * 1000;
// a fight with the two fighters face to face, within reach
function close(...args) { const f = makeFight(...args); f.f[0].pos = { x: -.6, z: 0 }; f.f[1].pos = { x: .6, z: 0 }; return f; }

test('duelStats: base attributes give the base numbers; gear raises them within caps', () => {
  assert.deepEqual({ hp: base.hp, strike: base.strike, cd: base.strikeCooldown }, { hp: HP, strike: STRIKE.damage, cd: STRIKE.cooldown });
  const geared = duelStats(characterAttributes({ outfit: 'outfit-ember', armor: 'armor-solar', pet: 'pet-sprout' }).total);
  assert.ok(geared.hp > base.hp && geared.strike > base.strike && geared.strikeCooldown < base.strikeCooldown);
  const extreme = duelStats({ strength: 500, agility: 500, intelligence: 500 });
  assert.equal(extreme.strikeCooldown, STRIKE.minCooldown);
  assert.ok(extreme.dodge <= .15 && extreme.crit <= .15);
  assert.deepEqual(duelStats({ strength: 'x' }), base); // bad input falls back to 10
});

test('a strike winds up, lands for its damage, and respects its cooldown', () => {
  const f = close(base, base, 0, queue(...NO_LUCK));
  assert.deepEqual(act(f, 0, 'strike', 0), { who: 0, kind: 'windup', act: 'strike', ms: W });
  assert.equal(act(f, 0, 'strike', 10), null, 'already winding up');
  assert.deepEqual(tick(f, W - 1), []);
  const [hit] = tick(f, W);
  assert.deepEqual(hit, { who: 0, kind: 'hit', dmg: STRIKE.damage, crit: false });
  assert.equal(f.f[1].hp, HP - STRIKE.damage);
  assert.equal(act(f, 0, 'strike', W + 1), null, 'cooling down');
  assert.ok(act(f, 0, 'strike', base.strikeCooldown * 1000));
});

test('guard takes a share; a timed parry takes nothing and staggers the striker', () => {
  let f = close(base, base, 0, queue(...NO_LUCK));
  act(f, 1, 'guardOn', 0); act(f, 0, 'strike', 1000);
  assert.equal(tick(f, 1000 + W)[0].kind, 'guarded', 'guard held long before: no parry');
  assert.equal(f.f[1].hp, HP - STRIKE.damage * GUARD.factor);

  f = close(base, base, 0, queue(...NO_LUCK));
  act(f, 0, 'strike', 0); act(f, 1, 'guardOn', W - 100);
  const [parry] = tick(f, W);
  assert.equal(parry.kind, 'parry');
  assert.equal(f.f[1].hp, HP);
  assert.equal(act(f, 0, 'strike', W + 900), null, 'staggered');
  assert.equal(act(f, 0, 'guardOn', W + 900), null, 'staggered');
});

test('guard mashing cannot parry; a guard after the impact time does not count', () => {
  let f = close(base, base, 0, queue(...NO_LUCK));
  act(f, 1, 'guardOn', 0); act(f, 1, 'guardOff', 50);
  act(f, 0, 'strike', 0); act(f, 1, 'guardOn', W - 50); // re-guard 350 ms after the last one: not re-armed
  assert.equal(tick(f, W)[0].kind, 'guarded');

  f = close(base, base, 0, queue(...NO_LUCK));
  act(f, 0, 'strike', 0); act(f, 1, 'guardOn', W + 20); // same server tick, but after the impact
  assert.equal(tick(f, W + 40)[0].kind, 'hit');
});

test('cannot strike while guarding or guard while winding up', () => {
  const f = close(base, base, 0, queue());
  act(f, 0, 'guardOn', 0);
  assert.equal(act(f, 0, 'strike', 10), null);
  act(f, 0, 'guardOff', 20);
  assert.ok(act(f, 0, 'strike', 30));
  assert.equal(act(f, 0, 'guardOn', 40), null);
});

test('a blast costs mana, ignores guard and dodge, and has its own cooldown', () => {
  const f = close(base, { ...base, dodge: 1 }, 0, queue(.99));
  act(f, 1, 'guardOn', 0);
  assert.ok(act(f, 0, 'blast', 0));
  assert.equal(f.f[0].mana, MANA.start - BLAST.cost);
  const [fire] = tick(f, BLAST.windup * 1000);
  assert.equal(fire.kind, 'fire');
  const [blast] = tick(f, BLAST.windup * 1000 + fire.ms + 1); // (ms is rounded)
  assert.equal(blast.kind, 'blast');
  assert.equal(f.f[1].hp, HP - BLAST.damage);
  assert.equal(act(f, 0, 'blast', 5000), null, 'cooldown');
  const empty = makeFight(base, base, 0);
  empty.f[0].mana = BLAST.cost - 1;
  assert.equal(act(empty, 0, 'blast', 0), null, 'not enough mana');
});

test('dodge and crit come from the rolls', () => {
  let f = close(base, base, 0, queue(.99, 0));
  act(f, 0, 'strike', 0);
  assert.equal(tick(f, W)[0].kind, 'dodge');
  f = close(base, base, 0, queue(0, .99, .5));
  act(f, 0, 'strike', 0);
  const [crit] = tick(f, W);
  assert.equal(crit.crit, true);
  assert.equal(crit.dmg, STRIKE.damage * 1.5);
});

test('knockout ends it; the earlier hit wins; exact same moment is a draw', () => {
  let f = close(base, base, 0, queue(...NO_LUCK, ...NO_LUCK));
  f.f[1].hp = 5; f.f[0].hp = 5;
  act(f, 0, 'strike', 0); act(f, 1, 'strike', 10);
  const events = tick(f, 500);
  assert.equal(events.length, 1, 'the knocked-out fighter never lands');
  assert.deepEqual([f.over, f.winner, f.result], [true, 0, 'ko']);

  f = close(base, base, 0, queue(...NO_LUCK, ...NO_LUCK));
  f.f[1].hp = 5; f.f[0].hp = 5;
  act(f, 0, 'strike', 0); act(f, 1, 'strike', 0);
  tick(f, W);
  assert.deepEqual([f.winner, f.result], [null, 'draw']);
});

test('time limit: higher health share wins, close is a draw; forfeit', () => {
  const end = DUEL_TIME.fight * 1000;
  let f = makeFight(base, base, 0);
  f.f[0].hp = 100; f.f[1].hp = 90;
  tick(f, end);
  assert.deepEqual([f.winner, f.result], [0, 'time']);
  f = makeFight(base, base, 0);
  f.f[0].hp = 100; f.f[1].hp = 99;
  tick(f, end);
  assert.deepEqual([f.winner, f.result], [null, 'draw']);
  f = makeFight(base, base, 0);
  forfeit(f, 0);
  assert.deepEqual([f.winner, f.result], [1, 'forfeit']);
  assert.equal(act(f, 1, 'strike', 1), null);
});

test('mana regenerates up to the cap; snapshot is rounded', () => {
  const f = makeFight(base, base, 0);
  tick(f, 1000);
  assert.equal(snapshot(f).mana[0], Math.floor(MANA.start + base.manaRegen));
  tick(f, 60000);
  assert.equal(snapshot(f).mana[0], MANA.max);
  assert.deepEqual(snapshot(f).guard, [false, false]);
});

test('a strike out of reach misses; stepping back out of reach during the wind-up makes it miss', () => {
  let f = makeFight(base, base, 0, queue(...NO_LUCK)); // they start ARENA.start each side of the middle
  act(f, 0, 'strike', 0);
  assert.deepEqual(tick(f, W), [{ who: 0, kind: 'miss' }]);
  f = close(base, base, 0, queue(...NO_LUCK));
  act(f, 0, 'strike', 0);
  for (let t = 50; t <= W; t += 50) move(f, 1, f.f[1].pos.x + MOVE.speed * .05, 0, t);
  assert.equal(tick(f, W)[0].kind, 'miss');
});

test('movement is limited by speed, slower while guarding, kept on the helipad and apart', () => {
  const f = makeFight(base, base, 0);
  assert.equal(move(f, 0, 0, 0, 1000), true, 'three metres in one go is corrected');
  assert.ok(Math.abs(f.f[0].pos.x + ARENA.start - MOVE.speed * MOVE.burst) < 1e-9, 'at most the burst allowance');
  const g = makeFight(base, base, 0);
  let t = 0;
  for (; t < 1000; t += 50) move(g, 0, g.f[0].pos.x - 1, 0, t + 50);
  const free = -ARENA.start - g.f[0].pos.x;
  assert.ok(free > MOVE.speed * .9 && free < MOVE.speed * MOVE.slack + .01, `moved ${free} m in a second`);
  const h = makeFight(base, base, 0);
  act(h, 0, 'guardOn', 0);
  for (t = 0; t < 1000; t += 50) move(h, 0, h.f[0].pos.x - 1, 0, t + 50);
  assert.ok(-ARENA.start - h.f[0].pos.x < free * .6, 'guarding is slower');
  for (t = 1000; t < 6000; t += 50) move(g, 0, g.f[0].pos.x - 1, 0, t + 50);
  assert.ok(Math.hypot(g.f[0].pos.x, g.f[0].pos.z) <= ARENA.radius + 1e-9, 'stays on the helipad');
  for (t = 6000; t < 12000; t += 50) move(g, 0, g.f[1].pos.x, 0, t + 50);
  assert.ok(Math.abs(g.f[0].pos.x - g.f[1].pos.x) >= MOVE.gap - 1e-9, 'cannot walk into the other one');
  assert.equal(move(g, 0, NaN, 0, 13000), false);
});

test('a blast flies to where they stood: staying put is a hit, moving away makes it fizzle', () => {
  let f = makeFight(base, base, 0, queue(.99));
  act(f, 0, 'blast', 0);
  const [fire] = tick(f, BLAST.windup * 1000);
  assert.equal(fire.kind, 'fire');
  assert.equal(fire.ms, Math.round(ARENA.start * 2 / BLAST.speed * 1000));
  const [blast] = tick(f, BLAST.windup * 1000 + fire.ms + 1);
  assert.deepEqual([blast.kind, f.f[1].hp], ['blast', HP - BLAST.damage]);

  f = makeFight(base, base, 0, queue(.99));
  act(f, 0, 'blast', 0);
  const [shot] = tick(f, BLAST.windup * 1000);
  for (let t = BLAST.windup * 1000 + 50; t <= BLAST.windup * 1000 + shot.ms; t += 50) move(f, 1, ARENA.start, f.f[1].pos.z + 1, t);
  const [miss] = tick(f, BLAST.windup * 1000 + shot.ms + 1);
  assert.deepEqual([miss.kind, f.f[1].hp], ['fizzle', HP]);
});

test('snapshot carries positions', () => {
  assert.deepEqual(snapshot(makeFight(base, base, 0)).pos, [[-ARENA.start, 0], [ARENA.start, 0]]);
});

test('weapons: a sword reaches further than fists; heavy weapons wind up longer and hit harder', async () => {
  const { WEAPONS } = await import('../src/config/duel.js');
  const sword = duelStats(undefined, 'weapon-katana'), hammer = duelStats(undefined, 'weapon-hammer');
  let f = makeFight(sword, base, 0, queue(...NO_LUCK));
  f.f[0].pos = { x: 0, z: 0 }; f.f[1].pos = { x: 2.1, z: 0 }; // out of a fist's reach, inside a sword's
  act(f, 0, 'strike', 0);
  const [slash] = tick(f, WEAPONS.sword.windup * 1000);
  assert.equal(slash.kind, 'hit');
  assert.equal(slash.dmg, Math.round(STRIKE.damage * WEAPONS.sword.dmg * 10) / 10);
  f = close(hammer, base, 0, queue(...NO_LUCK));
  assert.equal(act(f, 0, 'strike', 0).ms, WEAPONS.hammer.windup * 1000);
  assert.deepEqual(tick(f, W), [], 'still winding up');
  assert.equal(tick(f, WEAPONS.hammer.windup * 1000)[0].dmg, Math.round(STRIKE.damage * WEAPONS.hammer.dmg * 10) / 10);
});

test('guns: a bolt flies, can be guarded (mostly stopped), deflected by a timed guard, or sidestepped; guns are heavy', async () => {
  const { GUARD, WEAPONS } = await import('../src/config/duel.js');
  const pistol = duelStats(undefined, 'weapon-pistol'), P = WEAPONS.pistol;
  let f = makeFight(pistol, base, 0, queue(...NO_LUCK, .99, .5)); // 6 m apart: far out of any melee reach
  act(f, 0, 'strike', 0);
  const [fire] = tick(f, P.windup * 1000);
  assert.deepEqual([fire.kind, fire.act], ['fire', 'bolt']);
  const [hit] = tick(f, P.windup * 1000 + fire.ms + 1);
  assert.equal(hit.kind, 'hit');
  assert.equal(hit.dmg, Math.round(STRIKE.damage * P.dmg * 10) / 10);

  f = makeFight(pistol, base, 0, queue(...NO_LUCK, .99, .5));
  act(f, 1, 'guardOn', 0); act(f, 0, 'strike', 0);
  const [g] = tick(f, P.windup * 1000); const [guarded] = tick(f, P.windup * 1000 + g.ms + 1);
  assert.equal(guarded.kind, 'guarded');
  assert.equal(guarded.dmg, Math.round(STRIKE.damage * P.dmg * GUARD.bolt * 10) / 10);

  f = makeFight(pistol, base, 0, queue(...NO_LUCK));
  act(f, 0, 'strike', 0);
  const [p] = tick(f, P.windup * 1000), arrives = P.windup * 1000 + p.ms + 1;
  act(f, 1, 'guardOn', arrives - 100);
  const [deflect] = tick(f, arrives);
  assert.deepEqual([deflect.kind, f.f[1].hp], ['parry', HP]);
  assert.equal(act(f, 0, 'strike', arrives + 500), null, 'the shooter is staggered');

  f = makeFight(pistol, base, 0);
  for (let t = 50; t <= 1000; t += 50) move(f, 0, f.f[0].pos.x - 1, 0, t);
  const moved = -ARENA.start - f.f[0].pos.x;
  assert.ok(moved < MOVE.speed * MOVE.slack * P.pace + .01, `a pistol slows you: ${moved}`);
});

test('jump: clears a blast or a bolt that arrives mid-air; melee still hits; no acting mid-air; cooldown', async () => {
  const { JUMP, WEAPONS } = await import('../src/config/duel.js');
  let f = makeFight(base, base, 0, queue(.99));
  act(f, 0, 'blast', 0);
  const [fire] = tick(f, BLAST.windup * 1000), arrives = BLAST.windup * 1000 + fire.ms + 1;
  assert.deepEqual(act(f, 1, 'jump', arrives - 200), { who: 1, kind: 'jump', ms: JUMP.air * 1000 });
  assert.deepEqual(tick(f, arrives)[0], { who: 0, kind: 'fizzle', act: 'blast', jumped: true });
  assert.equal(f.f[1].hp, HP);
  assert.equal(act(f, 1, 'strike', arrives), null, 'no striking mid-air');
  assert.equal(act(f, 1, 'guardOn', arrives), null, 'no guarding mid-air');
  assert.equal(act(f, 1, 'jump', arrives - 200 + JUMP.air * 1000 + 10), null, 'cooldown');
  assert.ok(act(f, 1, 'jump', arrives - 200 + JUMP.cooldown * 1000));

  const pistol = duelStats(undefined, 'weapon-pistol');
  f = makeFight(pistol, base, 0, queue(...NO_LUCK));
  act(f, 0, 'strike', 0);
  const [bolt] = tick(f, WEAPONS.pistol.windup * 1000);
  act(f, 1, 'jump', WEAPONS.pistol.windup * 1000 + 50);
  assert.equal(tick(f, WEAPONS.pistol.windup * 1000 + bolt.ms + 1)[0].jumped, true);

  f = close(base, base, 0, queue(...NO_LUCK));
  act(f, 1, 'jump', 0); act(f, 0, 'strike', 0);
  assert.equal(tick(f, W)[0].kind, 'hit', 'melee hits you in the air');
});
