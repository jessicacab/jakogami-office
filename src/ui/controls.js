import { goTo } from '../camera/spots.js';
import { freeCam } from '../camera/controller.js';
import { zoomAt } from '../camera/orbit.js';
import { camGoal } from '../camera/state.js';
import { FULL_H, LOW_H } from '../config/plan.js';
import { rnd } from '../core/util.js';
import { makePerson, removePerson } from '../people/factory.js';
import { roster } from '../people/roster.js';
import { labelState } from '../render/labels.js';
import { lighting, updateLight } from '../render/lighting.js';
import { camera, renderer } from '../render/renderer.js';
import { people, sim } from '../sim/state.js';
import { $ } from './dom.js';
import { select } from './person.js';
import { wall } from '../world/helpers.js';
// Fullscreen for the whole page (the HUD stays usable). The button only shows where the browser supports it.
function toggleFullscreen() {
  try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); } catch (_) {}
}
function syncFullscreen() {
  const on = !!document.fullscreenElement, b = $('fsToggle'), label = on ? 'Exit fullscreen' : 'Fullscreen';
  b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', label); b.title = label + ' (F)';
}

// Dock pop-ups (Go to, Settings, Help): one open at a time; a click elsewhere or Esc closes them.
function closePops(except) {
  let closed = false;
  document.querySelectorAll('[data-pop]').forEach(b => {
    if (b === except || b.getAttribute('aria-expanded') !== 'true') return;
    b.setAttribute('aria-expanded', 'false'); $(b.dataset.pop).hidden = true; closed = true;
  });
  return closed;
}
function initPops() {
  document.querySelectorAll('[data-pop]').forEach(b => b.onclick = () => {
    const open = b.getAttribute('aria-expanded') !== 'true';
    closePops(b); b.setAttribute('aria-expanded', String(open)); $(b.dataset.pop).hidden = !open;
  });
  addEventListener('pointerdown', e => { if (!e.target.closest('.pop-wrap')) closePops(); });
}

function setUiHidden(h) {
  document.body.classList.toggle('ui-hidden', h);
  const b = $('uiToggle'), label = h ? 'Show controls' : 'Hide controls';
  b.setAttribute('aria-pressed', String(h)); b.setAttribute('aria-label', label); b.title = label + ' (H)';
  try { localStorage.setItem('officeSimUiHidden', h ? '1' : '0'); } catch (_) {}
}


function syncLights() {
  const b = $('tLights');
  b.setAttribute('aria-pressed', String(lighting.on));
  b.textContent = lighting.on ? 'Lights on' : 'Lights off';
  b.title = lighting.on ? 'Turn office lights off' : 'Turn office lights on';
}

function toggleLights() {
  lighting.on = !lighting.on;
  updateLight(); // Apply immediately, even when the simulation is paused.
  syncLights();
  try { localStorage.setItem('officeSimLights', lighting.on ? '1' : '0'); } catch (_) {}
}

function initControls() {
  
  // Controls
  initPops();
  try { lighting.on = localStorage.getItem('officeSimLights') !== '0'; } catch (_) {}
  updateLight(); syncLights();
  $('tLights').onclick = toggleLights;
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { goTo(b.dataset.go); closePops(); });
  document.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => { const k = b.dataset.cam; if (k === 'left') { camGoal.yaw += Math.PI / 4; freeCam(); } if (k === 'right') { camGoal.yaw -= Math.PI / 4; freeCam(); } if (k === 'in') zoomAt(.82); if (k === 'out') zoomAt(1.22); });
  $('uiToggle').onclick = () => setUiHidden(!document.body.classList.contains('ui-hidden'));
  $('fsToggle').hidden = !document.fullscreenEnabled;
  $('fsToggle').onclick = toggleFullscreen;
  document.addEventListener('fullscreenchange', syncFullscreen);
  addEventListener('keydown', e => { if (e.key.toLowerCase() === 'f' && document.fullscreenEnabled && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) && !e.metaKey && !e.ctrlKey && !e.altKey) toggleFullscreen(); });
  addEventListener('keydown', e => { if (e.key.toLowerCase() === 'h' && e.target.tagName !== 'INPUT' && !e.metaKey && !e.ctrlKey) setUiHidden(!document.body.classList.contains('ui-hidden')); });
  try { if (localStorage.getItem('officeSimUiHidden') === '1') setUiHidden(true); } catch (_) {}
  $('tWalls').onclick = e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); wall.goal = on ? FULL_H : LOW_H; };
  $('tLabels').onclick = e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); labelState.on = on; };
  if (roster.list) { $('staff').max = people.length; $('staff').value = people.length; $('staffVal').textContent = people.length; }
  $('staff').oninput = e => {
    const n = +e.target.value; $('staffVal').textContent = n;
    while (people.length < n) { const p = makePerson(); if (!p) break; if (sim.t < p.leaveAt - 30 && sim.t > 7 * 60 + 50) { p.arriveAt = sim.t + rnd(.1, 4); } }
    while (people.length > n) removePerson();
  };
  addEventListener('keydown', e => { if (e.key === 'Escape') { if (!closePops()) select(null); } });
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
}

export { initControls };
