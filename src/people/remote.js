import { buildBody, disposeBody } from '../character/rig.js';
import { normalizeSpec, randomSpec } from '../character/spec.js';
import { angDiff, seededRandom } from '../core/util.js';
import { people, peopleGroup } from '../sim/state.js';
import { endTask } from '../sim/tasks.js';
import { ENTRY } from '../world/entrance.js';
import { equipPerson, equipmentOf } from './equipment.js';
import { employeeById, simRole } from './roster.js';

/* ================= Coworkers walking in other browsers ================= */
// Live presence (docs/PRESENCE-SPEC.md). When someone walks around in their own browser, ui/presence.js passes their
// updates here: their employee in this office is taken over for the walk (state 'remote': the sim leaves it alone),
// or, if they are not in this office, a character is made for them ("visitor", not in `people`) wearing their gear.
// Each one glides to the latest update; when they stop, the employee goes back to its day and a visitor goes.
// A record: { p (the person), visitor, was (how the office left an employee), goal: { x, z, face }, anim, hipY }.
const remote = { byUser: new Map() };
const SNAP = 3; // metres: further than this from the update (a jump in the data), just put them there

function visitorFor(w) {
  const e = employeeById(w.userId);
  const spec = normalizeSpec(e?.character ?? randomSpec(simRole(e?.department), seededRandom(w.userId)));
  const body = buildBody(spec);
  const p = {
    id: `walk-${w.userId}`, name: w.name, role: 'Visitor', title: 'Walking around', userId: w.userId, spec, body, seat: null, photo: null,
    pos: ENTRY.clone(), face: w.face, faceGoal: w.face, state: 'remote', task: null, path: null, queue: [], walkPhase: 0, animT: 0, pose: {}, chatWith: null,
  };
  body.ring.visible = false;
  body.root.traverse(o => { if (o.isMesh) o.userData.person = p; });
  peopleGroup.add(body.root);
  equipPerson(p, equipmentOf(w.userId));
  return p;
}

// Someone's latest update: { userId, name, x, z, face, anim, hipY }.
function applyRemote(w) {
  let r = remote.byUser.get(w.userId);
  if (!r) {
    const here = people.find(q => q.userId === w.userId && !q.helper && q.state !== 'player' && !q.task?.duel);
    if (here) {
      const was = { state: here.state, visible: here.body.root.visible, ring: here.body.ring.visible };
      endTask(here);
      Object.assign(here, { state: 'remote', path: null, chatWith: null, meeting: null });
      here.body.root.visible = true;
      r = { p: here, visitor: false, was };
    } else r = { p: visitorFor(w), visitor: true, was: null };
    r.p.pos.set(w.x, 0, w.z); r.p.face = r.p.faceGoal = w.face;
    remote.byUser.set(w.userId, r);
  }
  r.goal = { x: w.x, z: w.z, face: w.face };
  r.p.task = { kind: 'remote', anim: w.anim, spot: { hipY: w.hipY ?? .53 } };
}

// They stopped walking (or left): give the employee back to its day, or let the visitor go.
function leaveRemote(userId) {
  const r = remote.byUser.get(userId); if (!r) return;
  remote.byUser.delete(userId);
  const p = r.p;
  if (r.visitor) { peopleGroup.remove(p.body.root); disposeBody(p.body); return; }
  p.task = null; p.path = null;
  if (r.was.state === 'away') { p.state = 'away'; p.body.root.visible = r.was.visible; p.body.ring.visible = r.was.ring; }
  else p.state = 'idle'; // sim/tasks.js chooseNext picks what next
}
function clearRemote() { for (const userId of [...remote.byUser.keys()]) leaveRemote(userId); }

// Per frame: glide each one to their latest position and facing; the walk cycle follows the distance covered.
function updateRemote(dt) {
  const k = 1 - Math.exp(-dt * 12);
  for (const r of remote.byUser.values()) {
    const p = r.p, g = r.goal; if (!g) continue;
    const dx = g.x - p.pos.x, dz = g.z - p.pos.z, d = Math.hypot(dx, dz);
    const step = d > SNAP ? d : d * k;
    if (d > 1e-4) { p.pos.x += dx / d * step; p.pos.z += dz / d * step; }
    p.walkPhase += step * 4.6; p.animT += dt;
    p.face += angDiff(p.face, g.face) * k; p.faceGoal = p.face;
  }
}
// Someone saved a new look while walking: a character made for them is rebuilt (an employee is restyled by the caller).
function restyleRemote(userId, spec) {
  const r = remote.byUser.get(userId); if (!r?.visitor) return;
  const p = r.p, old = p.body, body = buildBody(spec);
  body.ring.visible = false; body.root.traverse(o => { if (o.isMesh) o.userData.person = p; });
  peopleGroup.remove(old.root); disposeBody(old); peopleGroup.add(body.root);
  p.spec = spec; p.body = body; p.pose = {};
  equipPerson(p, equipmentOf(userId));
}
const remoteVisitors = () => [...remote.byUser.values()].filter(r => r.visitor).map(r => r.p);
const isRemote = p => [...remote.byUser.values()].some(r => r.p === p);

export { applyRemote, clearRemote, isRemote, leaveRemote, remoteVisitors, restyleRemote, updateRemote };
