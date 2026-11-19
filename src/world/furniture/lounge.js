import { M } from '../../render/materials.js';
import { E, SO, mkSpot } from './basics.js';
import { addObs, box, frame, staticRoot } from '../helpers.js';

function sofa(x1, y1, x2, y2, face, seats, place, approaches) {
  addObs(x1, y1, x2, y2);
  const horizontal = face === SO || face === Math.PI;
  const length = horizontal ? x2 - x1 : y2 - y1;
  const depth = horizontal ? y2 - y1 : x2 - x1;
  const f = frame((x1 + x2) / 2, (y1 + y2) / 2, face);
  box(f, length * .02, .22, depth * .02, M.sofaDark, 0, .2, 0);
  box(f, length * .02 - .12, .12, depth * .02 - .14, M.sofa, 0, .37, .04);
  box(f, length * .02, .42, .16, M.sofa, 0, .55, -depth * .01 + .08);
  [-1, 1].forEach(side => box(f, .13, .3, depth * .02, M.sofaDark, side * (length * .01 - .065), .42, 0));
  seats.forEach(([px, py], i) => mkSpot('lounge', px, py, face, { sit: true, hipY: .5, place, ap: approaches[i] }));
}

function buildLounge() {
  sofa(1015, 48, 1070, 150, E,
    [[1082, 62], [1082, 98], [1082, 134]],
    'the lounge sofa', [[1092, 62], [1092, 98], [1092, 134]]);
  sofa(1095, 32, 1160, 58, SO,
    [[1105, 69], [1127, 69], [1149, 69]],
    'the TV sofa', [[1105, 80], [1127, 80], [1149, 80]]);
  box(staticRoot, .1, 1.8, 1.5, M.featureWall, 23.55, .9, 2.0);
}

export { buildLounge };
