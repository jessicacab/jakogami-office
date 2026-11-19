import { ATTRIBUTE_KEYS, EQUIPMENT_SLOTS, characterAttributes, marketplaceItem, normalizeEquipment } from '../config/marketplace.js';

function validateMarketState(raw) {
  if (!raw || !Number.isSafeInteger(raw.balance) || raw.balance < 0 || !Array.isArray(raw.inventory)) {
    throw new Error('The marketplace returned an invalid account state. Please retry.');
  }
  const inventory = [...new Set(raw.inventory.filter(id => typeof id === 'string' && marketplaceItem(id)))];
  const equipped = normalizeEquipment(raw.equipped);
  for (const slot of EQUIPMENT_SLOTS) if (equipped[slot] && !inventory.includes(equipped[slot])) {
    throw new Error('The marketplace inventory could not be verified. Please retry.');
  }
  const attributes = characterAttributes(equipped);
  if (raw.attributes && ['base', 'bonus', 'total'].some(part => ATTRIBUTE_KEYS.some(key => raw.attributes[part]?.[key] !== attributes[part][key]))) {
    throw new Error('Character attributes are out of date. Reload to update the item catalog.');
  }
  return { balance: raw.balance, inventory, equipped, attributes };
}

async function marketRequest(path = '', body, expectedAccount) {
  const response = await fetch('/api/marketplace' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(expectedAccount ? { 'X-Office-Account': expectedAccount } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('Marketplace is unavailable. Please retry.'); }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('office-auth-lost'));
    if (data.code === 'account_changed') window.dispatchEvent(new Event('office-account-changed'));
    const error = new Error(data.error || 'Marketplace is unavailable. Please retry.');
    error.code = data.code; error.status = response.status;
    throw error;
  }
  return data;
}
async function fetchMarketplace(accountId) { return validateMarketState(await marketRequest('', undefined, accountId)); }
async function purchaseItem(itemId, accountId) { return validateMarketState(await marketRequest('/purchase', { itemId }, accountId)); }
async function equipItem(slot, itemId, accountId) { return validateMarketState(await marketRequest('/equip', { slot, itemId }, accountId)); }
async function fetchMarketEquipment() {
  const data = await marketRequest('/equipment');
  if (!Array.isArray(data.equipment)) throw new Error('Equipment could not be loaded.');
  return data.equipment.filter(entry => typeof entry.userId === 'string').map(entry => ({
    userId: entry.userId, equipped: normalizeEquipment(entry.equipped),
  }));
}

export { equipItem, fetchMarketEquipment, fetchMarketplace, purchaseItem, validateMarketState };
