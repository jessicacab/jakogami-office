import { BASE_ATTRIBUTES, marketplaceItem } from './marketplace.js';

// Duel rules (docs/DUEL-SPEC.md), shared by the server referee (server/duel.js, server/duelEngine.js) and the
// browser (sim/duel.js, ui/duel.js). Plain data and pure functions: no Three.js, DOM or Node APIs.
// Times are in seconds unless the name says ms.

// intro: the fly-in and countdown in the arena; fight: the time limit; end: the result stays up; grace: a fighter who
// lost their connection has this long to come back before it is a forfeit.
const DUEL_TIME = { intro: 4, fight: 90, end: 5, grace: 10 };
const DUEL_MAX = 6;         // duels that can run at once (each has its own copy of the arena)
const DUEL_TICK_MS = 50;    // the server's fight clock
const DUEL_STATE_EVERY = 1; // ticks between position/health updates to the browsers (20 a second: people move)
// The rooftop helipad, in metres from its middle: fighters stay within `radius`; each starts `start` from the middle.
const ARENA = { radius: 6.5, start: 3 };
// Movement: metres a second, and the share of it while guarding, winding up or staggered. `gap`: the closest two
// fighters get. The server allows `slack` times the speed (network jitter) and at most `burst` seconds' worth at once.
const MOVE = { speed: 3.2, guard: .5, windup: .4, stagger: .3, gap: .8, slack: 1.3, burst: .3, sendMs: 50 };
const HP = 140;
// A strike lands only if the other one is within `reach` when it connects.
const STRIKE = { damage: 12, windup: .4, cooldown: 1.2, minCooldown: .9, variance: .15, reach: 1.8 };
// Guarding takes `factor` of a strike. Starting to guard at most `parry` before a strike lands parries it: no damage,
// and the striker is staggered. A guard started within `rearm` of the previous one cannot parry (no button mashing).
const GUARD = { factor: .3, bolt: .15, parry: .25, rearm: .6, stagger: 1 }; // `bolt`: a gun's bolt into a guard
// Focus Blast flies at `speed` m/s to where the other one stood when it left the hands, and hits if they are still within
// `radius` of that point.
const BLAST = { damage: 20, cost: 50, windup: .6, cooldown: 6, speed: 9, radius: .9 };
const MANA = { max: 100, start: 50, regen: 6 };
const CRIT = { base: .05, max: .15, mult: 1.5 };
const DODGE = { base: .05, max: .15 };
const DRAW_MARGIN = .02; // on time, health shares this close are a draw
// What each attribute point above 10 adds, as a share of the base value (dodge and crit: added chance). Tuned with
// the bot simulation (server/duelBalance.test.js): rerun it after changing these or the Marketplace catalog.
const PER_POINT = { hp: .005, strike: .0065, cooldown: .007, dodge: .005, crit: .0015, regen: .003, blast: .003 };
// How each weapon changes the strike (docs/DUEL-SPEC.md, Phase 1.2), by the item's `model`. Melee: `reach` (metres),
// `windup` (seconds), `dmg` and `cooldown` as multiples of the fists'. Guns fire a bolt instead: `speed` (m/s), and it
// hits if the target is within `radius` of where they stood when it left; `pace` (guns are heavy: you move slower, so
// a melee fighter can catch you). Tuned with the bot simulation (server/duelBalance.test.js).
const WEAPONS = {
  fists: { kind: 'melee', reach: 1.8, windup: .4, dmg: 1, cooldown: 1, verb: 'Strike' },
  sword: { kind: 'melee', reach: 2.2, windup: .4, dmg: 1.1, cooldown: 1, verb: 'Slash' },
  staff: { kind: 'melee', reach: 2.6, windup: .45, dmg: 1.1, cooldown: 1, verb: 'Swing' },
  hammer: { kind: 'melee', reach: 2, windup: .6, dmg: 1.3, cooldown: 1.4, verb: 'Smash' },
  greatsword: { kind: 'melee', reach: 2.5, windup: .6, dmg: 1.25, cooldown: 1.4, verb: 'Cleave' },
  pistol: { kind: 'gun', windup: .25, dmg: .75, cooldown: 1.2, speed: 14, radius: .45, pace: .85, verb: 'Shoot' },
  rifle: { kind: 'gun', windup: .55, dmg: 1.15, cooldown: 1.8, speed: 16, radius: .45, pace: .8, verb: 'Shoot' },
};
const weaponOf = id => WEAPONS[marketplaceItem(id)?.slot === 'weapon' ? marketplaceItem(id).model : 'fists'] ?? WEAPONS.fists;

const DUEL_LIMITS = { inviteMs: 20000, spacingMs: 5000, repeatMs: 5 * 60000, maxInvites: 50, inputsPerSec: 20, movesPerSec: 30 };
const DUEL_ACTS = ['strike', 'guardOn', 'guardOff', 'blast', 'jump'];
// A jump (Space): in the air for `air` seconds, `height` metres at the top; once every `cooldown` seconds. Anything fired
// (a Focus Blast or a gun's bolt) that arrives while you are in the air flies under you; melee still hits. No striking,
// casting or guarding in the air.
const JUMP = { air: .55, height: .75, cooldown: 1.3 };
const DUEL_RESULTS = ['ko', 'time', 'forfeit', 'draw'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = v => (Number.isFinite(v) ? v : 10);

// Combat numbers from attribute totals ({ strength, agility, intelligence }, characterAttributes().total) and the
// equipped weapon's id (null: fists). Each point above 10 adds a little; gear should tilt a fight, not decide it
// (the balance test checks this).
function duelStats(total = BASE_ATTRIBUTES, weaponId = null) {
  const s = num(total?.strength) - 10, a = num(total?.agility) - 10, i = num(total?.intelligence) - 10;
  return {
    hp: Math.round(HP * (1 + PER_POINT.hp * s)),
    strike: STRIKE.damage * (1 + PER_POINT.strike * s),
    strikeCooldown: clamp(STRIKE.cooldown * (1 - PER_POINT.cooldown * a), STRIKE.minCooldown, STRIKE.cooldown),
    dodge: clamp(DODGE.base + PER_POINT.dodge * a, 0, DODGE.max),
    crit: clamp(CRIT.base + PER_POINT.crit * i, 0, CRIT.max),
    manaRegen: MANA.regen * (1 + PER_POINT.regen * i),
    blast: BLAST.damage * (1 + PER_POINT.blast * i),
    weapon: { model: marketplaceItem(weaponId)?.slot === 'weapon' ? marketplaceItem(weaponId).model : 'fists', ...weaponOf(weaponId) },
  };
}

export {
  ARENA, BLAST, CRIT, DODGE, DRAW_MARGIN, DUEL_ACTS, DUEL_LIMITS, DUEL_MAX, DUEL_RESULTS, DUEL_STATE_EVERY, DUEL_TICK_MS,
  DUEL_TIME, GUARD, HP, JUMP, MANA, MOVE, PER_POINT, STRIKE, WEAPONS, duelStats,
};
