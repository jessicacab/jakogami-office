import * as THREE from 'three';
import { S, W } from '../config/plan.js';
import { M } from '../render/materials.js';
import { scene } from '../render/renderer.js';
import { dynamic, scalers } from './helpers.js';

function doorLeaf(px, py, widthPx, rot, dir, mat = M.wall, fullH = 2.1, framed = false) {
  const g = new THREE.Group(); g.position.copy(W(px, py)); g.rotation.y = rot; scene.add(g);
  const w = widthPx * S; const geo = new THREE.BoxGeometry(w, 1, .04); geo.translate(dir * w / 2, .5, 0);
  const leaf = dynamic(new THREE.Mesh(geo, mat)); leaf.castShadow = true; g.add(leaf);
  if (!framed) { scalers.push(H => { leaf.scale.y = Math.min(fullH, H); }); return; }
  const frameMat = M.mullion, rails = [
    dynamic(new THREE.Mesh(new THREE.BoxGeometry(.035, 1, .065), frameMat)),
    dynamic(new THREE.Mesh(new THREE.BoxGeometry(.035, 1, .065), frameMat)),
    dynamic(new THREE.Mesh(new THREE.BoxGeometry(w, .035, .065), frameMat)),
  ];
  rails[0].position.x = dir * .018;
  rails[1].position.x = dir * (w - .018);
  rails[2].position.set(dir * w / 2, 1, 0);
  rails.forEach(r => g.add(r));
  scalers.push(H => {
    const h = Math.min(fullH, H);
    leaf.scale.y = h;
    rails[0].scale.y = rails[1].scale.y = h;
    rails[0].position.y = rails[1].position.y = h / 2;
    rails[2].position.y = h;
  });
}


function buildDoors() {
  doorLeaf(275, 405, 34, Math.PI / 2, 1, M.glass, 2.4, true);
  doorLeaf(1245, 185, 45, Math.PI / 2 - 1.15, 1, M.glass, 2.4);
  doorLeaf(1245, 275, 45, Math.PI / 2 + 1.15, -1, M.glass, 2.4);
}

export { doorLeaf, buildDoors };
