const STARTING_COINS = 3000;
const ATTRIBUTE_KEYS = ['strength', 'agility', 'intelligence'];
const BASE_ATTRIBUTES = { strength: 10, agility: 10, intelligence: 10 };
const EQUIPMENT_SLOTS = ['outfit', 'armor', 'pet', 'weapon'];
const MARKETPLACE_CATALOG = [
  { id: 'outfit-tide', name: 'Tideweave Dress', slot: 'outfit', price: 450, rarity: 'Uncommon', description: 'An intelligence-focused teal tunic and skirt.', color: '#47a9ac', accent: '#bce6df', model: 'dress', attributes: { strength: 1, agility: 3, intelligence: 5 } },
  { id: 'outfit-ember', name: 'Embercoat', slot: 'outfit', price: 600, rarity: 'Rare', description: 'A balanced crimson coat with an agility edge.', color: '#ae4b51', accent: '#efc17b', model: 'coat', attributes: { strength: 3, agility: 4, intelligence: 1 } },
  { id: 'armor-sentinel', name: 'Sentinel Plate', slot: 'armor', price: 900, rarity: 'Rare', description: 'Steel shoulder plates that favor strength.', color: '#7296ac', accent: '#d1e3eb', model: 'plate', attributes: { strength: 7, agility: 1, intelligence: 0 } },
  { id: 'armor-solar', name: 'Solar Guard', slot: 'armor', price: 1200, rarity: 'Epic', description: 'Golden armor that combines strength and intelligence.', color: '#d3a34d', accent: '#a294da', model: 'plate', attributes: { strength: 8, agility: 0, intelligence: 3 } },
  { id: 'pet-sprout', name: 'Sprout Fox', slot: 'pet', price: 700, rarity: 'Uncommon', description: 'A nimble forest companion with an agility bonus.', color: '#80b58d', accent: '#e4edcc', model: 'fox', attributes: { strength: 1, agility: 5, intelligence: 1 } },
  { id: 'pet-cloud', name: 'Cloud Wisp', slot: 'pet', price: 1000, rarity: 'Rare', description: 'A floating companion with an intelligence bonus.', color: '#8cc7ea', accent: '#e2d1ff', model: 'wisp', attributes: { strength: 0, agility: 2, intelligence: 7 } },
  // Volume 2 (supabase/migrations/202611190001_marketplace_items.sql)
  { id: 'outfit-hoodie', name: 'Night Shift Hoodie', slot: 'outfit', price: 300, rarity: 'Common', description: 'A soft navy hoodie for late deploys. A little of everything.', color: '#3b4a6b', accent: '#9fb4d9', model: 'hoodie', attributes: { strength: 2, agility: 3, intelligence: 2 } },
  { id: 'outfit-track', name: 'Sprint Tracksuit', slot: 'outfit', price: 650, rarity: 'Rare', description: 'A green tracksuit with white stripes, built for speed.', color: '#2f8f6b', accent: '#f2f2f2', model: 'hoodie', attributes: { strength: 1, agility: 6, intelligence: 1 } },
  { id: 'outfit-suit', name: 'Boardroom Suit', slot: 'outfit', price: 750, rarity: 'Rare', description: 'A charcoal suit with gold trim that thinks three moves ahead.', color: '#2b2f3a', accent: '#c9a85b', model: 'coat', attributes: { strength: 2, agility: 1, intelligence: 6 } },
  { id: 'armor-vest', name: "Debugger's Vest", slot: 'armor', price: 650, rarity: 'Uncommon', description: 'A padded olive vest with pockets for everything.', color: '#5d6b4a', accent: '#d8c79a', model: 'vest', attributes: { strength: 4, agility: 3, intelligence: 1 } },
  { id: 'armor-circuit', name: 'Circuit Mail', slot: 'armor', price: 1300, rarity: 'Epic', description: 'Teal plating traced with glowing circuits.', color: '#2a6f86', accent: '#7ef0e0', model: 'vest', attributes: { strength: 4, agility: 2, intelligence: 5 } },
  { id: 'armor-obsidian', name: 'Obsidian Bulwark', slot: 'armor', price: 1400, rarity: 'Epic', description: 'Heavy black plate with a red core. Pure strength.', color: '#2c2a33', accent: '#e0524a', model: 'plate', attributes: { strength: 9, agility: 0, intelligence: 1 } },
  { id: 'pet-cat', name: 'Desk Cat', slot: 'pet', price: 550, rarity: 'Uncommon', description: 'An orange office cat who has seen every bug.', color: '#e0a15a', accent: '#fff1dc', model: 'cat', attributes: { strength: 1, agility: 3, intelligence: 2 } },
  { id: 'pet-drone', name: 'Hover Drone', slot: 'pet', price: 950, rarity: 'Rare', description: 'A quiet little quadcopter that scouts ahead.', color: '#c9d1d9', accent: '#4fb3ff', model: 'drone', attributes: { strength: 0, agility: 4, intelligence: 4 } },
  { id: 'pet-ember', name: 'Ember Wisp', slot: 'pet', price: 900, rarity: 'Rare', description: 'A warm floating spark with a strength bonus.', color: '#f08a4b', accent: '#ffd9a8', model: 'wisp', attributes: { strength: 4, agility: 1, intelligence: 3 } },
  // Weapons (supabase/migrations/202611190002_marketplace_weapons.sql): held in the right hand; each changes how your
  // duel strike works (`model` picks its rules in config/duel.js WEAPONS). The guns are stylized energy weapons.
  { id: 'weapon-katana', name: 'Hotfix Katana', slot: 'weapon', price: 1800, rarity: 'Epic', description: 'A quick blade with a little extra reach. Ships fixes, fast.', color: '#c9d3dd', accent: '#d2462f', model: 'sword', attributes: { strength: 2, agility: 4, intelligence: 0 } },
  { id: 'weapon-staff', name: 'Archive Staff', slot: 'weapon', price: 2200, rarity: 'Epic', description: 'A long oak staff with a glowing crystal. The longest melee reach.', color: '#7a5636', accent: '#8cc7ea', model: 'staff', attributes: { strength: 0, agility: 1, intelligence: 5 } },
  { id: 'weapon-hammer', name: 'Merge Conflict Hammer', slot: 'weapon', price: 2400, rarity: 'Epic', description: 'Slow to swing, hard to forget.', color: '#5a5862', accent: '#e0524a', model: 'hammer', attributes: { strength: 4, agility: 0, intelligence: 1 } },
  { id: 'weapon-greatsword', name: 'Monolith Greatsword', slot: 'weapon', price: 2600, rarity: 'Legendary', description: 'A huge two-handed blade: long reach, heavy hits, slow swings.', color: '#8a93a3', accent: '#f2c14e', model: 'greatsword', attributes: { strength: 5, agility: 0, intelligence: 0 } },
  { id: 'weapon-pistol', name: 'Pulse Pistol', slot: 'weapon', price: 2800, rarity: 'Legendary', description: 'Fires quick energy bolts across the whole helipad.', color: '#2f3640', accent: '#4fb3ff', model: 'pistol', attributes: { strength: 0, agility: 3, intelligence: 2 } },
  { id: 'weapon-rifle', name: 'Ion Rifle', slot: 'weapon', price: 4000, rarity: 'Legendary', description: 'Slower, heavier bolts from a long energy rifle.', color: '#39424e', accent: '#7ef0e0', model: 'rifle', attributes: { strength: 1, agility: 2, intelligence: 3 } },
];

function marketplaceItem(id) { return MARKETPLACE_CATALOG.find(item => item.id === id) ?? null; }
function emptyEquipment() { return { outfit: null, armor: null, pet: null, weapon: null }; }
function normalizeEquipment(raw) {
  const equipment = emptyEquipment();
  for (const slot of EQUIPMENT_SLOTS) {
    const item = marketplaceItem(raw?.[slot]);
    if (item?.slot === slot) equipment[slot] = item.id;
  }
  return equipment;
}

function characterAttributes(raw) {
  const equipped = normalizeEquipment(raw);
  const base = { ...BASE_ATTRIBUTES }, bonus = { strength: 0, agility: 0, intelligence: 0 }, total = { ...base };
  for (const slot of EQUIPMENT_SLOTS) {
    const item = marketplaceItem(equipped[slot]);
    if (!item) continue;
    for (const key of ATTRIBUTE_KEYS) bonus[key] += item.attributes[key];
  }
  for (const key of ATTRIBUTE_KEYS) total[key] += bonus[key];
  return { base, bonus, total };
}

export { ATTRIBUTE_KEYS, BASE_ATTRIBUTES, EQUIPMENT_SLOTS, MARKETPLACE_CATALOG, STARTING_COINS, characterAttributes, emptyEquipment, marketplaceItem, normalizeEquipment };
