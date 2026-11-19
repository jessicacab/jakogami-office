import * as THREE from 'three';
import { scene } from './renderer.js';

// Duel effects (ui/duel.js triggers them from the server's events): the Focus Blast orb flying across, a spark burst
// where a hit lands, the damage floating up, and the flash when someone leaves for (or comes back from) the arena.
// Each goes into the scene given (`into`: the arena's, or the office's by default). Short-lived; everything made here
// is disposed when it fades.
const live = []; // { obj, t, dur, update(k) }
let glow = null;

// A soft round glow, drawn once.
function glowTexture() {
  if (glow) return glow;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(.35, 'rgba(255,255,255,.65)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  glow = new THREE.CanvasTexture(c);
  return glow;
}
function sprite(color, size) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(size); s.renderOrder = 5;
  return s;
}
function add(obj, dur, update, into) {
  (into ?? scene).add(obj);
  live.push({ obj, t: 0, dur, update });
}

// A burst of light where a hit lands. `size` in metres.
function spawnBurst(pos, color = 0xffd36b, size = .5, into = null) {
  const s = sprite(color, size); s.position.copy(pos);
  add(s, size > 1 ? .7 : .35, k => { s.scale.setScalar(size * (1 + k * 1.4)); s.material.opacity = 1 - k; }, into);
}
// A glowing speck that fades fast: laid down every frame behind a blade mid-swing, or behind a bolt, it reads as a trail.
function spawnTrail(pos, color = 0xffffff, into = null, size = .16) {
  const s = sprite(color, size); s.position.copy(pos);
  add(s, .18, k => { s.material.opacity = (1 - k) * .9; s.scale.setScalar(size * (1 - k * .6)); }, into);
}
// Something fired: an orb from `from` to `to` over `dur` seconds (the hit, if any, is a separate burst). A Focus Blast
// arcs a little and is large; a gun's bolt (`bolt`) flies straight, small and fast, leaving a trail.
function spawnOrb(from, to, dur, color = 0x8cc7ea, into = null, bolt = false) {
  const size = bolt ? .2 : .38, s = sprite(color, size), a = from.clone(), b = to.clone();
  s.position.copy(a);
  add(s, Math.max(.05, dur), k => {
    s.position.lerpVectors(a, b, k);
    if (bolt) spawnTrail(s.position, color, into, .12);
    else { s.position.y += Math.sin(k * Math.PI) * .15; s.scale.setScalar(.38 + Math.sin(k * 30) * .04 + k * .2); }
  }, into);
}
// Damage (or a word: "Parry!", "Dodge") floating up from `pos`.
function spawnNumber(pos, text, color = '#ffffff', into = null) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  g.font = '800 64px Archivo, "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(20,30,40,.85)'; g.strokeText(text, 128, 50);
  g.fillStyle = color; g.fillText(text, 128, 50);
  const tex = new THREE.CanvasTexture(c), s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.set(.8, .3, 1); s.position.copy(pos); s.renderOrder = 6;
  const y = pos.y;
  add(s, .9, k => { s.position.y = y + k * .45; s.material.opacity = k < .6 ? 1 : 1 - (k - .6) / .4; }, into);
}

// Per frame.
function updateDuelFx(dt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const fx = live[i]; fx.t += dt;
    const k = Math.min(1, fx.t / fx.dur);
    fx.update(k);
    if (k >= 1) {
      live.splice(i, 1); fx.obj.removeFromParent();
      if (fx.obj.material.map !== glow) fx.obj.material.map?.dispose();
      fx.obj.material.dispose();
    }
  }
}
function clearDuelFx() { while (live.length) { live[0].t = live[0].dur; updateDuelFx(0); } }

export { clearDuelFx, spawnBurst, spawnNumber, spawnOrb, spawnTrail, updateDuelFx };
