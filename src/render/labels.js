import * as THREE from 'three';
import { toPx, wx, wz } from '../config/plan.js';
import { scene } from './renderer.js';
import { ISLANDS } from '../world/furniture/desks.js';

/* ================= Labels ================= */
const labelGroup = new THREE.Group();
const labelState = { on: true };
function label(text, px, py, y = 3.0, scale = 1) {
  const c = document.createElement('canvas'); let g = c.getContext('2d');
  const font = '600 38px Archivo, "Helvetica Neue", Arial, sans-serif', track = 5;
  const str = text.toUpperCase();
  const setup = () => { g.font = font; g.textBaseline = 'middle'; if ('letterSpacing' in g) g.letterSpacing = track + 'px'; };
  setup();
  // measure with the same tracking we draw with; fall back to adding it by hand
  let tw = g.measureText(str).width; if (!('letterSpacing' in g)) tw += track * str.length;
  c.width = Math.ceil(tw + 64); c.height = 70; g = c.getContext('2d'); setup();
  g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.roundRect(2, 2, c.width - 4, 66, 33); g.fill();
  g.strokeStyle = 'rgba(37,50,61,.18)'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#25323d';
  if ('letterSpacing' in g) g.fillText(str, 32 + track / 2, 37);
  else { let x = 32; for (const ch of str) { g.fillText(ch, x, 37); x += g.measureText(ch).width + track; } }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true }));
  const h = .55 * scale; sp.scale.set(h * c.width / c.height, h, 1); sp.position.set(wx(px), y, wz(py)); sp.renderOrder = 10;
  labelGroup.add(sp);
}
function buildLabels() {
  ISLANDS.filter(d => ['A', 'B', 'C', 'D'].includes(d.name.at(-1))).forEach(d => {
    const [px, py] = toPx(new THREE.Vector3(d.cx, 0, d.cz)); label(d.name, px, py, 1.8);
  });
  label('Workstations', 245, 110, 1.8, .8);
  label('Management office', 165, 390, 2.4, .85);
  label('Kitchen', 1125, 385, 2.4, .85);
  label('Lounge', 1084, 180, 1.8, .85);
  label('Entrance', 1275, 230, 1.2);
}


function initLabels() {
  scene.add(labelGroup);
}

export { buildLabels, labelGroup, labelState, initLabels };
