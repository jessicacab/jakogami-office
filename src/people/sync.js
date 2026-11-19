import { ringMats } from '../character/rig.js';
import { updateEquipment } from '../character/equipment.js';
import { sim } from '../sim/state.js';
import { applyPose } from './animation.js';

// Per-frame: pose a person's rig and place their meshes where the simulation says they are.
function syncBody(p, dt) {
  if (p.state === 'away') return;
  if (!sim.paused || p.state === 'player' || p.state === 'remote' || p.task?.duel) applyPose(p, dt); // duels and people walking live are not on the office clock
  const b = p.body; b.root.position.set(p.pos.x, 0, p.pos.z); b.root.rotation.y = p.face;
  b.ring.position.set(p.pos.x, .015, p.pos.z);
  updateEquipment(b, p.animT);
  const cat = p.state === 'walking' ? 'walk' : (p.task?.kind === 'work' && p.chatWith ? 'chat' : p.task?.cat || 'walk');
  if (b.ring.material !== ringMats[cat]) b.ring.material = ringMats[cat];
}

export { syncBody };
