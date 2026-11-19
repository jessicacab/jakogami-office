import './styles/reset.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/hud.css';
import './styles/controls.css';
import './styles/ledger.css';
import './styles/person.css';
import './styles/ui-toggle.css';
import './styles/search.css';
import './styles/veil.css';
import './styles/responsive.css';
import './styles/marketplace.css';
import './styles/jira.css';
import './styles/first-person.css';
import './styles/duel.css';
import './styles/creator.css';

import { bootstrap } from './bootstrap.js';
import { disposeBody } from './character/rig.js';
import { keyCam } from './camera/input.js';
import { following, setView, updateCamera, viewId } from './camera/controller.js';
import { camGoal, camState } from './camera/state.js';
import { toPx } from './config/plan.js';
import { ctl } from './player/control.js';
import { tp } from './camera/modes/thirdPerson.js';
import { findPath } from './nav/astar.js';
import { GC, GR, NAV, walkPx } from './nav/grid.js';
import { roster } from './people/roster.js';
import { fetchAttendance, fetchEmployees } from './persistence/store.js';
import { updateDizzy } from './people/dizzy.js';
import { syncBody } from './people/sync.js';
import { player } from './player/player.js';
import { buildLabels, labelGroup, labelState } from './render/labels.js';
import { updateLight } from './render/lighting.js';
import { camera, renderer, scene } from './render/renderer.js';
import { newDay, resetDay } from './sim/day.js';
import { applyAttendance, initLive, live, tickLive, usesAttendance } from './sim/live.js';
import { DAY_END } from './sim/schedule.js';
import { tickMeetings, tryMeeting } from './sim/meetings.js';
import { updateSlap } from './sim/slap.js';
import { updateDuel } from './sim/duel.js';
import { CLOCK, log, people, sim } from './sim/state.js';
import { stepPerson, updateScreens } from './sim/step.js';
import { renderUI } from './ui/ledger.js';
import { stopAttendance } from './ui/attendance.js';
import { stopMarketplace } from './ui/marketplace.js';
import { stopJira } from './ui/jira.js';
import { stopDuelUi, updateDuelUi } from './ui/duel.js';
import { stopPresence, updatePresence } from './ui/presence.js';
import { stopScoreboard } from './ui/scoreboard.js';
import { remoteVisitors, updateRemote } from './people/remote.js';
import { arenaTarget, viewing } from './ui/duelArena.js';
import { updateDuelFx } from './render/duelFx.js';
import { selRing, select, selected } from './ui/person.js';
import { ENTRY } from './world/entrance.js';
import { interactables } from './world/interactables.js';
import { updateDarts } from './world/furniture/darts.js';
import { updateDiningTv } from './world/furniture/diningTv.js';
import { updateChannels } from './world/furniture/channels.js';
import { drawGame, gameCanvas, gameMat, loungeTV } from './world/furniture/game.js';
import { updateKitchen } from './world/furniture/kitchen.js';
import { scalers, wall } from './world/helpers.js';

/* ================= Main loop ================= */
let last = 0, uiAcc = 0, frame, attendanceTimer, running = false, stopped = false;
function tick(now) {
  if (!running) return;
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  if (!sim.paused) {
    if (tickLive()) newDay();
    if (!usesAttendance() && Math.floor(sim.t) !== sim.lastMinute) { sim.lastMinute = Math.floor(sim.t); tryMeeting(); }
    if (!usesAttendance()) tickMeetings();
    if (sim.t >= DAY_END) newDay();
    for (const p of people) stepPerson(p, dt);
    const you = player.person?.id === -1 ? player.person : null; // (someone you took control of is in people)
    if (you && you.state !== 'player') stepPerson(you, dt); // your character in a Power Slap
    updateSlap(dt);
    updateScreens(); updateLight();
  }
  updateDuel(dt); // duels run on the server's clock, so they go on while the office clock is paused
  updateRemote(dt); // coworkers walking in their own browsers (people/remote.js)
  for (const p of people) syncBody(p, dt);
  if (player.person?.id === -1) syncBody(player.person, dt);
  { const m = viewing(); if (m) for (const f of m.fighters) syncBody(f, dt); } // the duel you are watching, on the rooftop
  for (const p of remoteVisitors()) syncBody(p, dt); // walking in from another browser, not in today
  if (selected) { selRing.visible = selected.state !== 'away'; selRing.position.set(selected.pos.x, .02, selected.pos.z); const s = 1 + Math.sin(now / 260) * .06; selRing.scale.set(s, s, 1); }
  const showLabels = labelState.on && !ctl.active && camState.dist > 15; if (labelGroup.visible !== showLabels) labelGroup.visible = showLabels;
  if (Math.abs(wall.goal - wall.h) > .001) { wall.h += (wall.goal - wall.h) * (1 - Math.exp(-dt * 6)); scalers.forEach(f => f(wall.h)); }
  updatePresence(now); // your own walk, for everyone else
  keyCam(dt); updateCamera(dt); updateDarts(now, dt); updateKitchen(dt); updateDizzy(dt); updateDuelFx(dt); updateDuelUi(dt);
  // The lounge TV is dedicated to the PS5 fighting game, whether or not someone is currently playing.
  { if (loungeTV.material !== gameMat) loungeTV.material = gameMat; drawGame(dt); }
  updateDiningTv(dt, people.some(q => q.state === 'doing' && (q.task?.kind === 'tv' || (q.task?.kind === 'lunch' && q.task.spot?.kind === 'dining'))));
  updateChannels(dt); // TVs someone changed the channel on (ui/interact.js)
  const arena = arenaTarget(); // in a duel (or watching one) the rooftop arena is drawn instead of the office
  renderer.render(arena ? arena.scene : scene, arena ? arena.camera : camera);
  uiAcc += dt; if (uiAcc > .25) { uiAcc = 0; renderUI(); }
  frame = requestAnimationFrame(tick);
}
// Start once the staff list and attendance are in (or the API gave up): the people in the office are the
// real employees, and in live mode only those marked in_office today.
function start(employees, attendance, profile) {
  roster.list = employees;
  initLive(roster.list ? attendance : null); // use calendar presence when it is available
  bootstrap(profile);
  if (live.attendance) attendanceTimer = setInterval(() => fetchAttendance().then(a => { if (running && a) { applyAttendance(a); resetDay(); } }), 60000);
  scalers.forEach(f => f(wall.h));
  updateLight(); setView('angle');
  camState.target.copy(camGoal.target); camState.dist = camGoal.dist * 1.25; camState.yaw = camGoal.yaw + .5; camState.pitch = camGoal.pitch;
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { if (!stopped) buildLabels(); });
  renderUI();
  running = true;
  frame = requestAnimationFrame(t => { last = t; tick(t); });
  window.__simReady = true;
  document.getElementById('veil').classList.add('gone');
  window.__sim = { sim, people, player, ctl, tp, wall, interactables, NAV, GC, GR, camGoal, camState, updateCamera, viewId, following, select, setView, gameCanvas, drawGame, findPath, walkPx, toPx, ENTRY, advance(n, dt = .05) {
    for (let i = 0; i < n; i++) { sim.t += dt * sim.speed * CLOCK; if (Math.floor(sim.t) !== sim.lastMinute) { sim.lastMinute = Math.floor(sim.t); tryMeeting(); } tickMeetings(); if (sim.t >= DAY_END) newDay(); for (const p of people) stepPerson(p, dt); updateSlap(dt); }
  }, log };
}
async function initOffice(isCurrent = () => true, profile = null) {
  const [employees, attendance] = await Promise.all([fetchEmployees(), fetchAttendance()]);
  // Missing/failed auth or employee data must never enter the generated-staff path.
  if (!Array.isArray(employees)) throw new Error('Employee roster unavailable');
  if (!isCurrent()) return;
  start(employees, attendance, profile);
}

function stopOffice() {
  if (stopped) return;
  stopped = true;
  running = false;
  cancelAnimationFrame(frame);
  clearInterval(attendanceTimer);
  stopAttendance();
  stopMarketplace();
  stopJira();
  stopPresence();
  stopScoreboard();
  stopDuelUi();
  select(null);
  for (const person of people) disposeBody(person.body);
  renderer.dispose();
  renderer.forceContextLoss();
  scene.clear();
  people.length = 0;
  roster.list = null;
  document.getElementById('stage').replaceChildren();
  document.getElementById('attList').replaceChildren();
  document.getElementById('officeMatches').replaceChildren();
  document.getElementById('officeSearchInput').value = '';
  for (const id of ['pName', 'pRole', 'pStatus', 'pMeta', 'pAttributes']) document.getElementById(id).textContent = '';
  document.getElementById('person').hidden = true;
  delete window.__sim;
  delete window.__simReady;
}

export { initOffice, stopOffice };
