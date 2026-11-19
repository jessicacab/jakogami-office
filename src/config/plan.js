import * as THREE from 'three';

/* ================= Plan coordinates (sketch pixels) → metres ================= */
const S = 0.02, OX = 0, OY = 0;
const wx = px => (px - OX) * S, wz = py => (py - OY) * S;
const W = (px, py) => new THREE.Vector3(wx(px), 0, wz(py));
const toPx = v => [v.x / S + OX, v.z / S + OY];

const FRONT_Y = 230;
const OUTER = [[18, 15], [1245, 15], [1245, 510], [18, 510]];
const WALLS = [
  [18, 15, 1245, 15], [18, 15, 18, 510], [18, 510, 1245, 510],
  [1245, 15, 1245, 185], [1245, 275, 1245, 510],
  // Kitchen: opaque walls on the left and bottom, with its upper side open to the office.
  [1015, 290, 1015, 495], [1015, 495, 1238, 495],
];
const GLASS_WALLS = [
  [55, 285, 275, 285],
  [55, 285, 55, 490], [55, 490, 275, 490],
  [275, 285, 275, 365], [275, 405, 275, 490],
];
const WALL_T = 4.8, FULL_H = 2.7, LOW_H = 1.1;

export { FRONT_Y, FULL_H, GLASS_WALLS, LOW_H, OUTER, OX, OY, S, W, WALLS, WALL_T, toPx, wx, wz };
