import { buildBody, disposeBody } from '../character/rig.js';
import { DEFAULT_SPEC, normalizeSpec, randomSpec } from '../character/spec.js';
import { seededRandom } from '../core/util.js';
import { equipPerson } from '../people/equipment.js';
import { employeeById, simRole } from '../people/roster.js';
import { loadLocalSpec, saveLocalSpec } from '../persistence/store.js';
import { slap, slapTakeOver } from '../sim/slap.js';
import { people, peopleGroup } from '../sim/state.js';
import { endTask, goExit } from '../sim/tasks.js';
import { ENTRY } from '../world/entrance.js';
import { N } from '../world/furniture/basics.js';

// The player's character. Same rig and animation as the NPCs, but it is not in the NPC list:
// no seat, no schedule, never picked by the simulation. It appears at the entrance the first
// time it is needed and then stays where it was left. Its look is made in the character lab
// (ui/creator.js) and kept in this browser.
// You can also take control of someone in the office (takeControl): `person` is then them and `own` your own
// character, hidden until you let go.
// `lookAt`: who is in the middle of the screen while walking around (player/prompts.js); `aim`: a TV or whiteboard there,
// within reach, that E uses (ui/interact.js).
// `self`: the signed-in user (initPlayer) and their equipped Marketplace gear, which their own character wears.
const player = { person: null, own: null, spec: normalizeSpec(DEFAULT_SPEC), sitting: null, moving: false, lookAt: null, aim: null };
const self = { userId: null, equipment: null };
const PROPS = ['mug', 'phone', 'pad', 'putter', 'guitar', 'bucket', 'rag', 'mop'];

function makeBody(spec) {
  const body = buildBody(spec);
  body.ring.visible = false; // the activity ring is for NPCs
  peopleGroup.add(body.root);
  return body;
}

function spawnPlayer() {
  if (player.person) return player.person;
  const p = {
    id: -1, name: 'You', role: 'You', spec: player.spec, body: makeBody(player.spec),
    pos: ENTRY.clone(), face: N, faceGoal: N, state: 'player', task: null, chatWith: null,
    walkPhase: 0, animT: 0, pose: {}, userId: self.userId,
  };
  if (self.equipment) equipPerson(p, self.equipment);
  player.person = p;
  return p;
}
// Walk as yourself (the dock's Walk, or your own duel): your employee in this office, taken over where they are (or,
// not in today, coming in through the front door), else your own character with your look and gear.
function walkAsSelf() {
  const me = self.userId ? people.find(p => p.userId === self.userId && !p.helper) : null;
  if (!me) { if (player.person?.controlled) releaseControl(); return spawnPlayer(); }
  if (me.state === 'away' && !me.controlled && !me.task?.duel) {
    me.pos.copy(ENTRY); me.face = me.faceGoal = Math.PI; me.body.root.visible = me.body.ring.visible = true; me.cameIn = true;
  }
  takeControl(me);
  return me;
}
// Your gear changed (Marketplace): your own character wears it too.
function setSelfEquipment(equipment) {
  self.equipment = equipment;
  const p = player.person?.id === -1 ? player.person : player.own?.id === -1 ? player.own : null;
  if (p) equipPerson(p, equipment);
}

// Change how the player looks. Accepts any raw spec; invalid parts fall back. Returns the clean spec.
function setPlayerSpec(raw) {
  player.spec = normalizeSpec(raw);
  const p = player.person?.id === -1 ? player.person : player.own; if (!p) return player.spec;
  const old = p.body, body = makeBody(player.spec);
  body.root.visible = old.root.visible;
  for (const k of PROPS) body[k].visible = old[k].visible; // keep what an activity put in the hands
  peopleGroup.remove(old.root); disposeBody(old);
  p.spec = player.spec; p.body = body;
  if (self.equipment) equipPerson(p, self.equipment); // keep your gear on
  return player.spec;
}

// Walk as someone in the office instead of as your own character (ui/person.js "Take control", Simulate only; or
// a side of a fight, ui/slap.js). They stop what they were doing (a fight goes on, with you slapping for them).
function takeControl(p) {
  if (player.person === p) return;
  releaseControl();
  player.own = player.person; if (player.own) player.own.body.root.visible = false;
  if (!p.task?.slap && !p.task?.duel) { endTask(p); Object.assign(p, { state: 'player', task: null, path: null, queue: [] }); }
  for (const m of slap.matches) { const side = m.fighters?.indexOf(p) ?? -1; if (side >= 0) slapTakeOver(m, side); }
  p.controlled = true; player.person = p; player.sitting = null; player.moving = false;
}
// Let go of whoever you control (leaving first/third person): they get on with their day, and your own
// character is back where you left it.
function releaseControl() {
  const p = player.person; if (!p?.controlled) return;
  p.controlled = false;
  if (p.state === 'player') { p.state = 'idle'; p.task = null; } // sim/tasks.js chooseNext picks what next
  if (p.cameIn && p.state === 'idle') goExit(p); // not in today: they came in only because you walked as them
  p.cameIn = false;
  for (const m of slap.matches) { const side = m.fighters?.indexOf(p) ?? -1; if (side >= 0 && m.mine === side) slapTakeOver(m, null); }
  player.person = player.own; player.own = null;
  if (player.person) player.person.body.root.visible = true;
}

// Keep the look between visits, in this browser.
function savePlayerSpec() { saveLocalSpec(player.spec); }
// Your own character looks like your employee (their saved look, or the generated one they have in the office);
// without a staff record, the look saved in this browser.
function initPlayer(profile) {
  self.userId = profile?.id ?? null;
  const e = self.userId ? employeeById(self.userId) : null;
  if (e) { player.spec = normalizeSpec(e.character ?? randomSpec(simRole(e.department), seededRandom(e.userId))); return; }
  const saved = loadLocalSpec();
  if (saved) player.spec = normalizeSpec(saved);
}

export { initPlayer, player, releaseControl, savePlayerSpec, self, setPlayerSpec, setSelfEquipment, spawnPlayer, takeControl, walkAsSelf };
