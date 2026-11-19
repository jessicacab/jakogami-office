import { emptyEquipment, marketplaceItem, normalizeEquipment } from '../config/marketplace.js';

function itemState(account, itemId) {
  const item = marketplaceItem(itemId), owned = !!account?.inventory.includes(itemId);
  return {
    owned, equipped: !!item && account?.equipped[item.slot] === itemId,
    canBuy: !!item && !!account && !owned && account.balance >= item.price,
  };
}
function previewEquipment(account, itemId) {
  const equipped = normalizeEquipment(account?.equipped ?? emptyEquipment()), item = marketplaceItem(itemId);
  if (item) equipped[item.slot] = item.id;
  return equipped;
}

export { itemState, previewEquipment };
