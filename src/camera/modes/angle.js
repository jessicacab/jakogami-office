import { camGoal, fitDist, orbitStep } from '../state.js';

// Overview from an angle.
const angleMode = {
  id: 'angle',
  enter() {
    Object.assign(camGoal, { yaw: .15, pitch: 1.25 }); camGoal.dist = fitDist(1.25);
    camGoal.target.set(12.6, 0, 5.25);
  },
  update(dt) { orbitStep(dt, 7); },
};

export { angleMode };
