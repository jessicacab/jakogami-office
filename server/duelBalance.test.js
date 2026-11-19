import assert from 'node:assert/strict';
import test from 'node:test';
import { characterAttributes, MARKETPLACE_CATALOG } from '../src/config/marketplace.js';
import { duelStats } from '../src/config/duel.js';
import { BUILDS, SKILL, winRate } from './duelBots.js';

// Balance targets from docs/DUEL-SPEC.md, checked with seeded bot duels against the real engine. A draw counts half.
const N = 1500;
const score = (a, b, sa, sb, n = N) => { const r = winRate(a, b, sa, sb, n); return r.win + r.draw / 2; };
const GEARED = ['strength', 'agility', 'intelligence'];

test('a mirror match is even', () => {
  const s = score(BUILDS.base, BUILDS.base, SKILL.average, SKILL.average);
  assert.ok(Math.abs(s - .5) < .04, `mirror ${s}`);
});

test('equally skilled: a full gear set wins clearly but not always (about 65-70%)', () => {
  for (const build of GEARED) {
    const s = score(BUILDS[build], BUILDS.base, SKILL.average, SKILL.average);
    assert.ok(s >= .58 && s <= .75, `${build} gear vs base: ${s}`);
  }
});

test('a better player in base gear usually beats a geared average player', () => {
  for (const build of GEARED) {
    const s = score(BUILDS.base, BUILDS[build], SKILL.skilled, SKILL.average);
    assert.ok(s > .55, `skilled base vs average ${build}: ${s}`);
  }
});

test('no build dominates the others', () => {
  for (const [a, b] of [['strength', 'agility'], ['strength', 'intelligence'], ['agility', 'intelligence']]) {
    const s = score(BUILDS[a], BUILDS[b], SKILL.average, SKILL.average);
    assert.ok(s >= .4 && s <= .6, `${a} vs ${b}: ${s}`);
  }
});

test('every full gear set in the catalog stays within reach of skill', () => {
  // Fewer duels per set (there are many sets), so the limits are a little looser than the targets above.
  const ids = slot => MARKETPLACE_CATALOG.filter(i => i.slot === slot).map(i => i.id);
  for (const outfit of ids('outfit')) for (const armor of ids('armor')) for (const pet of ids('pet')) {
    const set = duelStats(characterAttributes({ outfit, armor, pet }).total), name = `${outfit} + ${armor} + ${pet}`;
    const gear = score(set, BUILDS.base, SKILL.average, SKILL.average, 150);
    assert.ok(gear <= .8, `${name} beats base gear too often: ${gear}`);
    const skill = score(BUILDS.base, set, SKILL.skilled, SKILL.average, 150);
    assert.ok(skill > .45, `a skilled player in base gear cannot keep up with ${name}: ${skill}`);
  }
});

// Weapons (Phase 1.2). With equal skill: any weapon is an edge over fists but not a sure win, and no weapon hard-counters
// another. Skill still decides: a skilled wielder beats an average fist-fighter far more often than a novice does. A
// skilled player in base gear keeps a real chance against a full set with a melee weapon; guns favour the shooter's
// skill over the target's, so that check is for melee weapons only.
const weaponIds = MARKETPLACE_CATALOG.filter(i => i.slot === 'weapon').map(i => i.id);
const armed = (id, kit = {}) => duelStats(characterAttributes({ ...kit, weapon: id }).total, id);
const KIT = { outfit: 'outfit-ember', armor: 'armor-solar', pet: 'pet-ember' };

test('each weapon alone is an edge over fists, and skill decides how much', () => {
  for (const id of weaponIds) {
    const w = armed(id), even = score(w, BUILDS.base, SKILL.average, SKILL.average, 300);
    assert.ok(even >= .45 && even <= .72, `${id} vs fists: ${even}`);
    const novice = score(w, BUILDS.base, SKILL.novice, SKILL.average, 300), skilled = score(w, BUILDS.base, SKILL.skilled, SKILL.average, 300);
    assert.ok(skilled - novice >= .4, `${id}: skill barely matters (${novice} to ${skilled})`);
  }
});

test('no weapon hard-counters another', () => {
  for (let i = 0; i < weaponIds.length; i++) for (let j = i + 1; j < weaponIds.length; j++) {
    const s = score(armed(weaponIds[i]), armed(weaponIds[j]), SKILL.average, SKILL.average, 300);
    assert.ok(s >= .25 && s <= .8, `${weaponIds[i]} vs ${weaponIds[j]}: ${s}`);
  }
});

test('a full set with a weapon is strong but not certain; melee kits stay within reach of skill', () => {
  for (const id of weaponIds) {
    const kit = armed(id, KIT), gear = score(kit, BUILDS.base, SKILL.average, SKILL.average, 300);
    assert.ok(gear <= .92, `${id} with a full set vs base: ${gear}`);
    if (kit.weapon.kind === 'melee') {
      const skill = score(BUILDS.base, kit, SKILL.skilled, SKILL.average, 300);
      assert.ok(skill >= .5, `skilled base vs ${id} with a full set: ${skill}`);
    }
  }
});
