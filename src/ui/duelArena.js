import * as THREE from 'three';
import { ARENA, DUEL_TIME, MOVE } from '../config/duel.js';
import { sendDuel } from '../persistence/duel.js';
import { spawnTrail } from '../render/duelFx.js';
import { renderer } from '../render/renderer.js';
import { duel } from '../sim/duel.js';
import { arena, buildArena, updateArena } from '../world/arena.js';
import { $ } from './dom.js';

/* ================= Duel: being in the arena ================= */
// Looking at a duel on the rooftop (docs/DUEL-SPEC.md, Phase 1.1): which duel you see, the arena camera, and, in your
// own duel, moving your fighter. While you are in the arena the office keeps running but is not drawn, and its
// camera keys and clicks are held back. ui/duel.js decides when to come and go; main.js asks `arenaTarget()` what to draw.
// Your movement is shown at once and sent to the server 20 times a second; it limits speed and keeps you on the pad
// (sim/duel.js pulls you back if it disagrees by a lot).
const view = {
  match: null, keys: new Set(), stick: { id: null, x: 0, y: 0, ox: 0, oy: 0 }, sentAt: 0, sent: null, trail: [],
  pos: new THREE.Vector3(), look: new THREE.Vector3(), goal: new THREE.Vector3(), aim: new THREE.Vector3(), orbit: 0, prepared: false, listeners: [],
  shake: 0, tip: new THREE.Vector3(),
};
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const OFFICE_KEYS = new Set([...MOVE_KEYS, 'q', 'e', '+', '=', '-', '_', ' ']); // the office camera's keys: not while here
const INTRO_FROM = new THREE.Vector3(-14, 12, 16); // the fly-in starts high over the corner of the roof

function listen(node, event, fn, opts) { node.addEventListener(event, fn, opts); view.listeners.push(() => node.removeEventListener(event, fn, opts)); }
const typing = e => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName);
const arenaTarget = () => (view.match && arena.scene ? arena : null);
const viewing = () => view.match;

// Make sure the arena exists and put a duel's fighters in it (called when a duel starts, for every duel).
function arenaScene() { return buildArena().scene; }

function enterArena(m) {
  arenaScene();
  view.match = m; view.keys.clear(); view.orbit = 0; view.sent = null; view.trail.length = 0;
  arena.camera.aspect = innerWidth / innerHeight; arena.camera.updateProjectionMatrix();
  document.body.classList.add('arena');
  view.pos.copy(INTRO_FROM); view.look.set(0, 1, 0);
  if (m.phase !== 'intro') aim(m, 1, true);
  showStick(false);
}
function leaveArena() {
  if (!view.match) return;
  view.match = null; view.keys.clear(); showStick(false);
  document.body.classList.remove('arena');
}

// Where the camera wants to be. Fighting: behind your shoulder, looking past you at the other one. Watching (or once
// it is over): from the side, far enough back to frame both, slowly circling at the end.
function aim(m, dt, snap = false) {
  const [a, b] = m.fighters.map(f => f.pos);
  if (m.mine !== null && m.phase !== 'end') {
    const me = m.fighters[m.mine].pos, them = m.fighters[1 - m.mine].pos;
    const dx = me.x - them.x, dz = me.z - them.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
    // up close, swing wider and higher so your own character does not hide the other one
    const near = Math.max(0, 2.5 - d), side = 1 + near * .45, up = 2.4 + near * .35;
    view.goal.set(me.x + ux * 3.3 - uz * side, up, me.z + uz * 3.3 + ux * side);
    view.aim.set(me.x + (them.x - me.x) * .75, 1.05, me.z + (them.z - me.z) * .75);
  } else {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, lx = b.x - a.x, lz = b.z - a.z, d = Math.hypot(lx, lz) || 1;
    let px = -lz / d, pz = lx / d;
    if ((view.pos.x - mx) * px + (view.pos.z - mz) * pz < 0) { px = -px; pz = -pz; } // stay on the side we are on
    if (m.phase === 'end') { view.orbit += dt * .35; const c = Math.cos(view.orbit), s = Math.sin(view.orbit); [px, pz] = [px * c - pz * s, px * s + pz * c]; }
    const far = 5 + d * .8;
    view.goal.set(mx + px * far, 2.6, mz + pz * far);
    view.aim.set(mx, 1.05, mz);
  }
  if (snap) { view.pos.copy(view.goal); view.look.copy(view.aim); }
}
function placeCamera(m, dt, introLeft) {
  aim(m, dt);
  if (m.phase === 'intro') {
    // fly in from high over the roof, easing out as the countdown ends
    const k = Math.min(1, Math.max(0, 1 - introLeft / DUEL_TIME.intro)), e = 1 - (1 - k) ** 3;
    view.pos.lerpVectors(INTRO_FROM, view.goal, e); view.look.copy(view.aim);
  } else {
    const k = 1 - Math.exp(-dt * 6);
    view.pos.lerp(view.goal, k); view.look.lerp(view.aim, k);
  }
  arena.camera.position.copy(view.pos);
  // a hit you dealt or took jolts the camera for a moment
  if (view.shake > 0) {
    view.shake = Math.max(0, view.shake - dt * 1.6);
    const a = view.shake * view.shake * 2.2;
    arena.camera.position.x += (Math.random() - .5) * a; arena.camera.position.y += (Math.random() - .5) * a;
  }
  arena.camera.lookAt(view.look);
}
function shake(amount) { if (view.match && !matchMedia('(prefers-reduced-motion: reduce)').matches) view.shake = Math.max(view.shake, amount); }

// While a blade or the staff is mid-swing (late in the wind-up, and through the follow-through), lay a trail behind its tip.
function trails(m) {
  m.fighters.forEach((f, i) => {
    const w = m.stats[i].weapon, tip = f.body.weaponTip;
    if (!tip || !w || w.kind !== 'melee' || w.model === 'fists') return;
    const late = m.wind[i] && m.wind[i].act === 'strike' && m.wind[i].t / m.wind[i].dur > .62;
    const follow = m.swing[i] !== null && m.swing[i] < .22 && m.lastAct[i] === 'strike';
    if (late || follow) spawnTrail(tip.getWorldPosition(view.tip), f.body.weaponColor ?? '#ffffff', arena.scene);
  });
}

// Your fighter, from WASD or the touch stick, locked on to the other one: W/up closes in, S backs off, A/D circle.
function steer(m, dt, now) {
  const side = m.mine, me = m.fighters[side], them = m.fighters[1 - side];
  let f = 0, r = 0;
  const k = view.keys;
  if (k.has('w') || k.has('arrowup')) f += 1; if (k.has('s') || k.has('arrowdown')) f -= 1;
  if (k.has('d') || k.has('arrowright')) r += 1; if (k.has('a') || k.has('arrowleft')) r -= 1;
  f -= view.stick.y; r += view.stick.x;
  const len = Math.hypot(f, r);
  if (len > .08) {
    const pace = (m.stagger[side] > 0 ? MOVE.stagger : m.wind[side] ? MOVE.windup : m.guard[side] ? MOVE.guard : 1) * (m.stats[side].weapon?.pace ?? 1); // guns are heavy
    const dx = them.pos.x - me.pos.x, dz = them.pos.z - me.pos.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
    const step = MOVE.speed * pace * Math.min(1, len) * dt / len;
    let x = me.pos.x + (ux * f - uz * r) * step, z = me.pos.z + (uz * f + ux * r) * step;
    const out = Math.hypot(x, z); if (out > ARENA.radius) { x *= ARENA.radius / out; z *= ARENA.radius / out; }
    const gx = x - them.pos.x, gz = z - them.pos.z, g = Math.hypot(gx, gz);
    if (g < MOVE.gap && g > 1e-6) { x = them.pos.x + gx / g * MOVE.gap; z = them.pos.z + gz / g * MOVE.gap; }
    me.pos.x = x; me.pos.z = z;
  }
  const moved = !view.sent || Math.abs(me.pos.x - view.sent.x) > .005 || Math.abs(me.pos.z - view.sent.z) > .005;
  if (moved && now - view.sentAt >= MOVE.sendMs) {
    view.sentAt = now; view.sent = { x: me.pos.x, z: me.pos.z };
    view.trail.push({ t: now, x: me.pos.x, z: me.pos.z });
    while (view.trail.length && now - view.trail[0].t > 1500) view.trail.shift();
    sendDuel('duel:move', { id: m.id, x: Math.round(me.pos.x * 100) / 100, z: Math.round(me.pos.z * 100) / 100 });
  }
}

// The server's position for you arrived (ui/duel.js, on each state update). On a real network it describes where you
// were a moment ago, so it is compared with the positions you recently sent: if it matches one, all is well; only if
// it matches none has the server corrected you (too fast, off the helipad, into the other one), and you snap to it.
// (Comparing with where you are now pulled you back constantly whenever the connection had some delay.)
function reconcile(m) {
  if (m !== view.match || m.mine === null || m.phase !== 'fight') return;
  const me = m.fighters[m.mine], g = me.goal;
  const fine = Math.hypot(me.pos.x - g.x, me.pos.z - g.z) < .6 || view.trail.some(p => Math.hypot(p.x - g.x, p.z - g.z) < .35);
  if (!fine) { me.pos.x = g.x; me.pos.z = g.z; view.trail.length = 0; }
}

// Per frame, from ui/duel.js: only the duel you look at is shown; your fighter moves; the camera follows.
function updateDuelArena(dt, now, introLeft) {
  for (const m of duel.matches) for (const f of m.fighters) { const on = m === view.match; if (f.body.root.visible !== on) f.body.root.visible = on; }
  const m = view.match; if (!m) return;
  updateArena(dt);
  if (m.mine !== null && m.phase === 'fight') steer(m, dt, now);
  trails(m);
  placeCamera(m, dt, introLeft);
  showStick(matchMedia('(pointer: coarse)').matches && m.mine !== null && m.phase === 'fight');
}

function showStick(on) {
  const st = $('stick'); if (st.hidden === !on) return;
  st.hidden = !on;
  if (!on) { view.stick.id = null; view.stick.x = view.stick.y = 0; $('knob').style.transform = ''; st.style.left = ''; st.style.bottom = ''; }
}

// Build the arena and compile its shaders while nothing is happening, so the first duel does not stall the office.
function prepareArena() {
  const go = () => { if (!view.prepared) return; buildArena(); renderer.compileAsync?.(arena.scene, arena.camera).catch(() => {}); };
  view.prepared = true;
  setTimeout(() => (window.requestIdleCallback ?? (f => f()))(go, { timeout: 4000 }), 6000);
}

function initDuelArena({ onLeave }) {
  prepareArena();
  // keys: movement is yours here, and the office camera does not get them
  listen(window, 'keydown', e => {
    if (!view.match || typing(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'escape' && view.match.mine === null) { onLeave(); return; }
    if (!OFFICE_KEYS.has(k)) return;
    if (MOVE_KEYS.has(k)) { view.keys.add(k); e.preventDefault(); }
    e.stopPropagation();
  }, true);
  listen(window, 'keyup', e => view.keys.delete(e.key.toLowerCase()));
  listen(window, 'blur', () => view.keys.clear());
  // the canvas: no office camera dragging or picking while here; on a touch screen, the left half is a move stick
  const canvas = renderer.domElement;
  listen(canvas, 'pointerdown', e => {
    if (!view.match) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const st = view.stick;
    if (e.pointerType === 'touch' && !$('stick').hidden && st.id === null && e.clientX < innerWidth * .5) {
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      Object.assign(st, { id: e.pointerId, ox: e.clientX, oy: e.clientY });
      const el = $('stick'); el.style.left = `${e.clientX - 60}px`; el.style.bottom = `${innerHeight - e.clientY - 60}px`;
    }
  }, true);
  listen(canvas, 'pointermove', e => {
    const st = view.stick; if (!view.match || e.pointerId !== st.id) return;
    e.stopImmediatePropagation();
    let dx = (e.clientX - st.ox) / 50, dy = (e.clientY - st.oy) / 50; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    st.x = dx; st.y = dy; $('knob').style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
  }, true);
  const lift = e => { const st = view.stick; if (e.pointerId === st.id) { st.id = null; st.x = st.y = 0; $('knob').style.transform = ''; } };
  listen(window, 'pointerup', lift); listen(window, 'pointercancel', lift);
  listen(canvas, 'wheel', e => { if (view.match) { e.stopImmediatePropagation(); e.preventDefault(); } }, { capture: true, passive: false });
  listen(canvas, 'contextmenu', e => e.preventDefault());
  listen(window, 'resize', () => { if (arena.camera) { arena.camera.aspect = innerWidth / innerHeight; arena.camera.updateProjectionMatrix(); } });
}
function stopDuelArena() {
  view.prepared = false;
  leaveArena();
  for (const remove of view.listeners) remove();
  view.listeners.length = 0;
}

export { arenaScene, arenaTarget, enterArena, initDuelArena, leaveArena, reconcile, shake, stopDuelArena, updateDuelArena, viewing };
