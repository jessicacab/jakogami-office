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
function applyEquipmentSnapshot(entries) {
  const byId = new Map(entries.map(entry => [entry.userId, entry.equipped]));
  for (const person of people) if (person.userId) equipPerson(person, byId.get(person.userId));
}

export { applyEquipmentSnapshot, equipPerson, equipmentKey };
