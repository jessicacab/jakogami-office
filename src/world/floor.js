import * as THREE from 'three';
import { OUTER, S, wx, wz } from '../config/plan.js';
import { M } from '../render/materials.js';
import { groundMat, scene } from '../render/renderer.js';
import { rectPlane, staticRoot } from './helpers.js';


function buildFloor() {
  
  /* ================= Floor ================= */
  {
    const shape = new THREE.Shape(OUTER.map(([x, y]) => new THREE.Vector2(wx(x), -wz(y))));
    const slab = new THREE.ExtrudeGeometry(shape, { depth: .14, bevelEnabled: false });
    slab.rotateX(-Math.PI / 2); slab.translate(0, -.14, 0);
    const m = new THREE.Mesh(slab, [M.floor, M.slab]); m.receiveShadow = true; staticRoot.add(m);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
    ground.rotation.x = -Math.PI / 2; ground.position.y = -.15; ground.receiveShadow = true; scene.add(ground);
    const pad = new THREE.Mesh(new THREE.BoxGeometry((1300 - 1245) * S, .1, (270 - 190) * S), M.pad);
    pad.position.set(wx(1272.5), -.09, wz(230)); pad.receiveShadow = true; staticRoot.add(pad);
    rectPlane(55, 285, 275, 490, M.carpet);
    rectPlane(1015, 290, 1238, 495, M.wood);
  }
}

export { buildFloor };
