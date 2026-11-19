import { applyEquipment } from '../character/equipment.js';
import { characterAttributes, normalizeEquipment } from '../config/marketplace.js';
import { people } from '../sim/state.js';

function equipmentKey(equipment) { return `${equipment?.outfit ?? ''}|${equipment?.armor ?? ''}|${equipment?.pet ?? ''}|${equipment?.weapon ?? ''}`; }
function equipPerson(person, equipment) {
  const clean = normalizeEquipment(equipment);
  person.attributes = characterAttributes(clean);
  if (equipmentKey(person.body.marketEquipment) === equipmentKey(clean)) return;
  applyEquipment(person.body, clean);
  person.body.root.traverse(o => { if (o.isMesh) o.userData.person = person; });
}
// Everyone's equipped gear from the last appearance refresh (ui/marketplace.js), also for people who are not among
// `people` (someone walking in from another browser: people/remote.js).
const appearance = new Map();
function applyEquipmentSnapshot(entries) {
  appearance.clear(); for (const entry of entries) appearance.set(entry.userId, entry.equipped);
  for (const person of people) if (person.userId) equipPerson(person, appearance.get(person.userId));
}
const equipmentOf = userId => appearance.get(userId) ?? null;

export { applyEquipmentSnapshot, equipPerson, equipmentKey, equipmentOf };
