import { S, wx, wz } from '../../config/plan.js';
import { M } from '../../render/materials.js';
import { E, SO, WST, mkSpot, woodChair } from './basics.js';
import { addObs, box, cyl, frame, staticRoot } from '../helpers.js';
import { interactables } from '../interactables.js';

const BUCKET = { mesh: null, carrier: null };
const KITCHEN = { doors: [], spots: [] };
function cabinetRun(x1, y1, x2, y2, upper = true) {
  const cx = wx((x1 + x2) / 2), cz = wz((y1 + y2) / 2);
  const w = (x2 - x1) * S, d = (y2 - y1) * S;
  addObs(x1, y1, x2, y2);
  box(staticRoot, w, .86, d, M.white, cx, .43, cz);
  box(staticRoot, w + .04, .05, d + .04, M.dark, cx, .885, cz);
  const horizontal = Math.abs(x2 - x1) > Math.abs(y2 - y1);
  const span = horizontal ? w : d;
  for (let i = 1; i < Math.round(span / .62); i++) {
    if (horizontal) box(staticRoot, .014, .72, d + .006, M.steel, cx - w / 2 + i * .62, .43, cz);
    else box(staticRoot, w + .006, .72, .014, M.steel, cx, .43, cz - d / 2 + i * .62);
  }
  if (!upper) return;
  const inset = .06;
  box(staticRoot, w, .64, Math.max(.22, d - inset), M.white, cx, 1.72, cz);
  for (let i = 1; i < Math.round(span / .62); i++) {
    if (horizontal) box(staticRoot, .014, .54, Math.max(.225, d - inset + .006), M.steel, cx - w / 2 + i * .62, 1.72, cz);
    else box(staticRoot, Math.max(.225, w - inset + .006), .54, .014, M.steel, cx, 1.72, cz - d / 2 + i * .62);
  }
}

function waterDispenser(x, y) {
  const f = frame(x, y, SO);
  box(f, .42, .78, .38, M.dark, 0, .39, 0);
  box(f, .25, .18, .24, M.monitor, 0, .72, .12);
  cyl(f, .15, .13, .34, M.waterBottle, 0, 1.04, 0, 16);
  box(f, .035, .08, .035, M.red, -.07, .62, .21);
  box(f, .035, .08, .035, M.white, .07, .62, .21);
  addObs(x - 12, y - 12, x + 12, y + 12);
}

function blackFridge(x, y) {
  addObs(x - 13, y - 16, x + 13, y + 16);
  box(staticRoot, .5, 1.8, .62, M.dark, wx(x), .9, wz(y));
  box(staticRoot, .44, .72, .018, M.monitor, wx(x), 1.42, wz(y + 16), false);
  box(staticRoot, .44, .72, .018, M.monitor, wx(x), .66, wz(y + 16), false);
  box(staticRoot, .025, .52, .025, M.steel, wx(x + 8), 1.12, wz(y + 17), false);
}

function buildKitchen() {
  // An L-shaped kitchenette: white cabinets and dark counters along the closed walls.
  cabinetRun(1018, 318, 1050, 492);
  cabinetRun(1048, 460, 1218, 492);
  mkSpot('counter', 1080, 448, SO, { place: 'the kitchen counter' });
  mkSpot('counter', 1140, 448, SO, { place: 'the kitchen counter' });

  // Sink and faucet set into the rear counter.
  box(staticRoot, .55, .035, .34, M.steel, wx(1110), .92, wz(474), false);
  cyl(staticRoot, .025, .025, .28, M.steel, wx(1110), 1.07, wz(481), 8);
  box(staticRoot, .03, .03, .14, M.steel, wx(1110), 1.2, wz(486));
  mkSpot('sink', 1095, 448, SO, { place: 'the kitchen sink' });
  mkSpot('sink', 1130, 448, SO, { place: 'the kitchen sink' });

  blackFridge(1195, 405);
  waterDispenser(1188, 338);

  // The central dining table seats six, like the real kitchen.
  const table = [1070, 352, 1160, 390], tx = wx((table[0] + table[2]) / 2), tz = wz((table[1] + table[3]) / 2);
  addObs(...table);
  box(staticRoot, (table[2] - table[0]) * S, .055, (table[3] - table[1]) * S, M.dark, tx, .72, tz);
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([x, z]) => {
    box(staticRoot, .05, .7, .05, M.dark, tx + x * ((table[2] - table[0]) * S / 2 - .07), .35, tz + z * ((table[3] - table[1]) * S / 2 - .07));
  });
  [[1085, 338, SO], [1115, 338, SO], [1145, 338, SO], [1085, 404, Math.PI], [1115, 404, Math.PI], [1145, 404, Math.PI]].forEach(([x, y, face]) => {
    mkSpot('dining', x, y, face, { sit: true, hipY: .52, place: 'the kitchen table' });
    const f = frame(x, y, face); woodChair(f);
  });
  const firstTable = interactables.of('slap').length / 2;
  [[1054, 371, E], [1176, 371, WST]].forEach(([x, y, face], i) => {
    mkSpot('slap', x, y, face, { place: 'the kitchen table' }).table = firstTable + Math.floor(i / 2);
  });
  mkSpot('snack', 1180, 392, SO, { place: 'the fridge' });
}

function updateKitchen() {}

export { BUCKET, buildKitchen, updateKitchen };
