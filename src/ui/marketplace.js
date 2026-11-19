import { normalizeSpec, randomSpec } from '../character/spec.js';
import { ATTRIBUTE_KEYS, EQUIPMENT_SLOTS, MARKETPLACE_CATALOG, characterAttributes, marketplaceItem } from '../config/marketplace.js';
import { seededRandom } from '../core/util.js';
import { roster, simRole } from '../people/roster.js';
import { equipItem, fetchMarketEquipment, fetchMarketplace, purchaseItem } from '../persistence/marketplace.js';
import { $ } from './dom.js';
import { itemState, previewEquipment } from './marketplaceModel.js';

const market = { profile: null, account: null, preview: null, previewPromise: null, filter: 'all', tryOn: null, pending: null, busy: false, loading: false, error: '', status: '', active: false, generation: 0, revision: 0, loadPromise: null, timer: null, listeners: [], dependencies: null };
const SLOT_NAMES = { outfit: 'Outfit', armor: 'Armor', pet: 'Pet', weapon: 'Weapon' };
const ATTRIBUTE_NAMES = { strength: 'Strength', agility: 'Agility', intelligence: 'Intelligence' };
const ATTRIBUTE_SHORT = { strength: 'STR', agility: 'AGI', intelligence: 'INT' };
const coins = value => value.toLocaleString('en-US');
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderAttributes() {
  const actual = market.account ? characterAttributes(market.account.equipped) : null;
  const shown = actual ? characterAttributes(previewEquipment(market.account, market.tryOn)) : null;
  $('marketAttributesMode').textContent = market.tryOn ? 'Try-on projection' : 'Equipped stats';
  $('marketAttributes').replaceChildren(...ATTRIBUTE_KEYS.map(key => {
    const node = el('div', `market-attribute market-stat-${key}`);
    node.append(el('span', '', ATTRIBUTE_NAMES[key]), el('strong', '', shown ? String(shown.total[key]) : '—'));
    node.append(el('small', '', shown ? `${shown.base[key]} base + ${shown.bonus[key]} gear` : 'Inventory not loaded'));
    if (shown && market.tryOn) {
      const delta = shown.total[key] - actual.total[key];
      node.append(el('em', delta < 0 ? 'is-negative' : '', `${delta >= 0 ? '+' : ''}${delta} vs equipped`));
    }
    return node;
  }));
}
function button(text, action, itemId, primary = false) {
  const b = el('button', primary ? 'btn primary' : 'btn', text);
  b.type = 'button'; b.dataset.marketAction = action;
  if (itemId) b.dataset.itemId = itemId;
  b.disabled = market.busy || market.loading;
  return b;
}
function illustration(item) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('aria-hidden', 'true');
  const shape = (tag, attrs) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  };
  const color = item.color, accent = item.accent;
  if (item.slot === 'weapon') {
    const metal = { fill: color, stroke: accent, 'stroke-width': 2 }, glow = { fill: accent };
    if (item.model === 'staff') {
      shape('path', { d: 'm28 88 40-62', stroke: color, 'stroke-width': 7, 'stroke-linecap': 'round' });
      shape('path', { d: 'm70 8 9 13-9 13-9-13Z', ...glow }); shape('circle', { cx: 66, cy: 30, r: 6, fill: 'none', stroke: accent, 'stroke-width': 3 });
    } else if (item.model === 'hammer') {
      shape('path', { d: 'm30 86 30-44', stroke: '#2a2630', 'stroke-width': 7, 'stroke-linecap': 'round' });
      shape('path', { d: 'm46 26 26 18-12 18-26-18Z', ...metal }); shape('path', { d: 'm42 32 26 18', stroke: accent, 'stroke-width': 4 });
    } else if (item.model === 'pistol') {
      shape('path', { d: 'M18 38h58v14H44l-6 30H24l6-30H18Z', ...metal }); shape('rect', { x: 26, y: 41, width: 44, height: 4, ...glow });
      shape('circle', { cx: 80, cy: 45, r: 5, ...glow });
    } else if (item.model === 'rifle') {
      shape('path', { d: 'M8 44h60v12H40l-4 22H26l3-22H8Z', ...metal }); shape('rect', { x: 66, y: 46, width: 24, height: 7, ...metal });
      for (const x of [30, 40, 50]) shape('rect', { x, y: 41, width: 5, height: 18, ...glow });
      shape('circle', { cx: 92, cy: 49, r: 4, ...glow });
    } else {
      const big = item.model === 'greatsword';
      shape('path', { d: big ? 'm70 8 10 10-44 50-10-10Z' : 'm72 10 7 7-40 44-7-7Z', ...metal });
      shape('path', { d: big ? 'm22 62 16 16M24 84l8-8' : 'm26 58 14 14M27 80l7-7', stroke: accent, 'stroke-width': 5, 'stroke-linecap': 'round' });
      shape('path', { d: big ? 'm73 14-38 42' : 'm74 15-34 38', stroke: accent, 'stroke-width': 2, opacity: .8 });
    }
  } else if (item.model === 'hoodie') {
    shape('path', { d: 'M33 22 16 40l11 11 8-7-3 40h36l-3-40 8 7 11-11-17-18Q50 6 33 22Z', fill: color, stroke: accent, 'stroke-width': 2 });
    shape('path', { d: 'M38 22Q50 34 62 22M45 30v12m10-12v12M37 62h26v12H37Z', fill: 'none', stroke: accent, 'stroke-width': 3 });
  } else if (item.slot === 'outfit') {
    shape('path', { d: 'M33 17 18 32l12 13 8-8-9 49h42l-9-49 8 8 12-13-15-15-17 8Z', fill: color, stroke: accent, 'stroke-width': 2 });
    shape('path', { d: 'M43 18 50 30l7-12M50 30v49M32 73h36', fill: 'none', stroke: accent, 'stroke-width': 3 });
  } else if (item.model === 'vest') {
    shape('path', { d: 'M34 16h10l6 10 6-10h10l6 18-4 50H32l-4-50Z', fill: color, stroke: accent, 'stroke-width': 2 });
    shape('path', { d: 'M50 26v58M34 56h12v10H34Zm20 0h12v10H54ZM30 78h40', fill: 'none', stroke: accent, 'stroke-width': 3 });
  } else if (item.slot === 'armor') {
    shape('path', { d: 'm31 25 19 6 19-6 6 49-25 14-25-14Z', fill: color, stroke: accent, 'stroke-width': 2 });
    shape('path', { d: 'm30 20-20 8 2 22 22-4 3-16m33-10 20 8-2 22-22-4-3-16', fill: color, stroke: accent, 'stroke-width': 3 });
    shape('path', { d: 'm50 38 10 13-10 13-10-13Z', fill: accent });
  } else if (item.model === 'fox') {
    shape('path', { d: 'M27 56Q4 22 13 78q18 14 30-4', fill: accent });
    shape('ellipse', { cx: 55, cy: 66, rx: 25, ry: 20, fill: color });
    shape('path', { d: 'm32 42 4-29 17 15 19-15 8 29-22 21Z', fill: color, stroke: accent, 'stroke-width': 2 });
    shape('path', { d: 'm39 46 19 5 15-6-15 18Z', fill: accent });
    shape('circle', { cx: 47, cy: 39, r: 3, fill: '#24323c' }); shape('circle', { cx: 67, cy: 39, r: 3, fill: '#24323c' });
  } else if (item.model === 'cat') {
    shape('path', { d: 'M72 70Q92 60 84 36', fill: 'none', stroke: color, 'stroke-width': 7, 'stroke-linecap': 'round' });
    shape('ellipse', { cx: 52, cy: 70, rx: 24, ry: 16, fill: color });
    shape('path', { d: 'M28 50 30 20l12 12h16l12-12 2 30Q50 66 28 50Z', fill: color, stroke: accent, 'stroke-width': 2 });
    shape('circle', { cx: 42, cy: 42, r: 3, fill: '#24323c' }); shape('circle', { cx: 58, cy: 42, r: 3, fill: '#24323c' });
    shape('path', { d: 'm47 50 3 3 3-3', fill: 'none', stroke: accent, 'stroke-width': 2 });
  } else if (item.model === 'drone') {
    shape('path', { d: 'm22 30 56 40M78 30 22 70', stroke: color, 'stroke-width': 6 });
    for (const [cx, cy] of [[22, 28], [78, 28], [22, 72], [78, 72]]) shape('ellipse', { cx, cy, rx: 15, ry: 4, fill: accent, opacity: .8 });
    shape('rect', { x: 36, y: 40, width: 28, height: 20, rx: 6, fill: color, stroke: accent, 'stroke-width': 2 });
    shape('circle', { cx: 50, cy: 50, r: 4, fill: accent });
  } else {
    shape('circle', { cx: 50, cy: 54, r: 26, fill: color, stroke: accent, 'stroke-width': 2 });
    shape('ellipse', { cx: 50, cy: 20, rx: 29, ry: 8, fill: 'none', stroke: accent, 'stroke-width': 4 });
    shape('circle', { cx: 41, cy: 51, r: 4, fill: '#24323c' }); shape('circle', { cx: 59, cy: 51, r: 4, fill: '#24323c' });
    shape('path', { d: 'm25 77 7 9m42-10-5 9', stroke: accent, 'stroke-width': 3 });
  }
  return svg;
}
function itemCard(item) {
  const state = itemState(market.account, item.id);
  const card = el('article', 'market-item' + (state.equipped ? ' is-equipped' : ''));
  card.style.setProperty('--item-color', item.color);
  const art = el('div', 'market-item-art'); art.append(illustration(item));
  if (state.owned) art.append(el('span', 'market-item-tag', state.equipped ? 'EQUIPPED' : 'OWNED'));
  const content = el('div', 'market-item-content'), meta = el('div', 'market-item-meta');
  meta.append(el('span', '', SLOT_NAMES[item.slot]), el('span', '', item.rarity));
  const price = el('div', 'market-item-price', coins(item.price) + ' '); price.append(el('small', '', 'coins'));
  const actions = el('div', 'market-item-actions');
  const attributes = el('div', 'market-item-attributes');
  for (const key of ATTRIBUTE_KEYS) {
    const stat = el('span', `market-stat-${key}`);
    stat.setAttribute('title', ATTRIBUTE_NAMES[key]);
    stat.append(el('strong', '', `+${item.attributes[key]}`), el('small', '', ATTRIBUTE_SHORT[key]));
    attributes.append(stat);
  }
  actions.append(button('Try on', 'preview', item.id));
  const action = button(state.owned ? (state.equipped ? 'Unequip' : 'Equip') : 'Buy item', state.owned ? 'equip' : 'buy', item.id, true);
  if (!state.owned && !state.canBuy) {
    action.disabled = true;
    action.textContent = market.account ? 'Not enough coins' : 'Unavailable';
  }
  actions.append(action);
  content.append(meta, el('h4', '', item.name), el('p', '', item.description), attributes, price, actions);
  card.append(art, content); return card;
}
function render() {
  renderAttributes();
  $('marketBalance').textContent = market.account ? coins(market.account.balance) : '—';
  $('marketError').hidden = !market.error; $('marketError').textContent = market.error;
  $('marketStatus').textContent = market.loading ? 'Loading your collection…' : market.status;
  $('marketRefresh').disabled = market.busy || market.loading;
  $('marketConfirm').hidden = !market.pending;
  $('marketConfirmBuy').disabled = market.busy || !market.pending;
  $('marketCancelBuy').disabled = market.busy;
  if (market.pending) {
    const item = marketplaceItem(market.pending);
    $('marketConfirmTitle').textContent = `Buy ${item.name}?`;
    $('marketConfirmText').textContent = `${coins(item.price)} coins · Balance after purchase: ${coins(market.account.balance - item.price)} coins.`;
  }
  const items = MARKETPLACE_CATALOG.filter(item => market.filter === 'all' || item.slot === market.filter || (market.filter === 'owned' && market.account?.inventory.includes(item.id)));
  $('marketGrid').replaceChildren(...items.map(itemCard));
  if (!items.length) $('marketGrid').append(el('div', 'market-empty', 'Your collection starts here. Buy an item to keep it in your inventory.'));
  $('marketSlots').replaceChildren(...EQUIPMENT_SLOTS.map(slot => {
    const row = el('div', 'market-slot'), info = el('div'), item = marketplaceItem(market.account?.equipped[slot]);
    info.append(el('small', '', SLOT_NAMES[slot]), el('strong', '', item?.name ?? 'Not equipped')); row.append(info);
    if (item) {
      const remove = button('Remove', 'unequip', item.id);
      remove.setAttribute('aria-label', `Unequip ${item.name}`); row.append(remove);
    }
    return row;
  }));
}
function preview() {
  $('marketPreviewBadge').textContent = market.tryOn ? 'Try-on only' : 'Equipped';
  $('marketResetPreview').hidden = !market.tryOn;
  market.preview?.equip(previewEquipment(market.account, market.tryOn));
  renderAttributes();
}
function applyOwnEquipment() {
  const person = market.dependencies.people.find(p => p.userId === market.profile?.id);
  if (person && market.account) market.dependencies.equipPerson(person, market.account.equipped);
  if (market.account) market.dependencies.equipSelf(market.account.equipped); // your own walking character
}
function errorMessage(error) {
  return error.code === 'setup_required'
    ? 'Marketplace setup is required. Run supabase/migrations/202611090001_marketplace.sql and then 202611090002_marketplace_session_access.sql in the Supabase SQL Editor, then refresh this collection.'
    : error.message || 'Marketplace is unavailable. Please retry.';
}
async function refreshAppearance() {
  const generation = market.generation, revision = market.revision;
  try {
    const entries = await market.dependencies.api.fetchMarketEquipment();
    if (!market.active || generation !== market.generation || revision !== market.revision) return;
    market.dependencies.applyEquipmentSnapshot(entries);
    // A local confirmed equip is more recent than an in-flight public appearance snapshot.
    applyOwnEquipment();
  } catch (_) { /* Missing setup must not stop the office. The Marketplace itself displays setup errors. */ }
}
async function refreshAccount() {
  if (!market.active || market.busy) return;
  if (market.loadPromise) return market.loadPromise;
  const generation = market.generation, revision = market.revision;
  market.loading = true; market.pending = null; market.error = ''; render();
  market.loadPromise = (async () => {
    try {
      const account = await market.dependencies.api.fetchMarketplace(market.profile.id);
      if (!market.active || generation !== market.generation || revision !== market.revision) return;
      market.account = account; market.pending = null; market.status = 'Your collection is up to date.';
      applyOwnEquipment(); preview();
    } catch (error) {
      if (!market.active || generation !== market.generation) return;
      market.error = errorMessage(error); market.status = '';
    } finally {
      if (generation === market.generation) { market.loading = false; market.loadPromise = null; if (market.active) render(); }
    }
  })();
  return market.loadPromise;
}
async function transact(kind, item) {
  if (!market.active || market.busy || market.loading || !market.account || !item) return;
  if (kind === 'purchase' && !itemState(market.account, item.id).canBuy) return;
  market.busy = true; market.error = ''; market.status = kind === 'purchase' ? 'Completing purchase…' : 'Saving equipment…';
  market.revision++;
  const generation = market.generation;
  render();
  try {
    const account = kind === 'purchase' ? await market.dependencies.api.purchaseItem(item.id, market.profile.id) : await market.dependencies.api.equipItem(item.slot, item.id, market.profile.id);
    if (!market.active || generation !== market.generation) return;
    market.account = account; market.pending = null; market.tryOn = null;
    market.status = kind === 'purchase' ? `${item.name} is now in your inventory. Equip it when you're ready.` : `${item.name} equipped.`;
    applyOwnEquipment(); preview();
  } catch (error) {
    if (!market.active || generation !== market.generation) return;
    market.error = errorMessage(error); market.status = '';
    // Never infer success or deduct coins locally after an ambiguous network failure.
    market.pending = null;
  } finally {
    if (generation === market.generation) { market.busy = false; if (market.active) render(); }
  }
}
async function unequip(item) {
  if (!market.active || market.busy || market.loading || !market.account || !item) return;
  market.busy = true; market.revision++; market.error = ''; market.pending = null; render();
  const generation = market.generation;
  try {
    const account = await market.dependencies.api.equipItem(item.slot, null, market.profile.id);
    if (!market.active || generation !== market.generation) return;
    market.account = account; market.tryOn = null; market.status = `${item.name} unequipped.`;
    applyOwnEquipment(); preview();
  } catch (error) { if (market.active && generation === market.generation) market.error = errorMessage(error); }
  finally { if (generation === market.generation) { market.busy = false; if (market.active) render(); } }
}
function handleAction(event) {
  const target = event.target.closest('[data-market-action]');
  if (!target || market.busy || market.loading) return;
  const item = marketplaceItem(target.dataset.itemId); if (!item) return;
  if (target.dataset.marketAction === 'preview') { market.tryOn = item.id; preview(); return; }
  if (target.dataset.marketAction === 'buy') {
    if (!itemState(market.account, item.id).canBuy) return;
    market.pending = item.id; render(); $('marketConfirmBuy').focus(); return;
  }
  if (target.dataset.marketAction === 'unequip' || itemState(market.account, item.id).equipped) unequip(item);
  else transact('equip', item);
}
function baseSpec() {
  const person = market.dependencies.people.find(p => p.userId === market.profile.id);
  const employee = roster.list?.find(e => e.userId === market.profile.id);
  return normalizeSpec(person?.spec ?? employee?.character ?? randomSpec(simRole(employee?.department), seededRandom(market.profile.id)));
}
function open() {
  if (!market.active || $('marketDialog').open) return;
  $('marketDialog').showModal();
  $('marketAccountName').textContent = market.profile.full_name || 'Your character';
  if (!market.preview && !market.previewPromise) {
    const generation = market.generation, spec = baseSpec(), dependencies = market.dependencies, host = $('marketPreview');
    market.previewPromise = Promise.resolve().then(() => {
      if (!market.active || generation !== market.generation) return null;
      return dependencies.makePreview(host, spec);
    }).then(made => {
      if (!made) return;
      if (!market.active || generation !== market.generation) { made.dispose(); return; }
      market.preview = made; $('marketPreviewFallback').hidden = true;
      preview(); if ($('marketDialog').open) made.start();
    }).catch(() => {
      if (market.active && generation === market.generation) $('marketPreviewFallback').textContent = '3D preview is unavailable on this device. Your purchases and equipment still work.';
    }).finally(() => { if (generation === market.generation) market.previewPromise = null; });
  }
  preview(); market.preview?.start(); refreshAccount();
}
function listen(node, event, handler) {
  node.addEventListener(event, handler);
  market.listeners.push(() => node.removeEventListener(event, handler));
}
function initMarketplace(profile, {
  people = [], equipPerson = () => {}, applyEquipmentSnapshot = () => {}, equipSelf = () => {},
  api = { equipItem, fetchMarketEquipment, fetchMarketplace, purchaseItem },
  makePreview = async (host, spec) => (await import('../character/marketPreview.js')).makeMarketPreview(host, spec),
  timers = { setInterval: (callback, delay) => window.setInterval(callback, delay), clearInterval: id => window.clearInterval(id) },
} = {}) {
  if (!profile?.id) { $('marketplaceBtn').disabled = true; return; }
  market.active = true; market.profile = profile; market.generation++;
  market.dependencies = { people, equipPerson, applyEquipmentSnapshot, equipSelf, api, makePreview, timers };
  market.busy = false; market.loading = false; market.filter = 'all'; market.error = ''; market.status = '';
  listen($('marketplaceBtn'), 'click', open);
  listen($('marketClose'), 'click', () => $('marketDialog').close());
  listen($('marketDialog'), 'close', () => {
    market.preview?.stop(); market.tryOn = null; market.pending = null;
    if (market.active) $('marketplaceBtn').focus();
  });
  listen($('marketDialog'), 'keydown', event => event.stopPropagation());
  listen($('marketDialog'), 'click', handleAction);
  listen($('marketRefresh'), 'click', () => { refreshAccount(); refreshAppearance(); });
  listen(window, 'office-wallet-changed', refreshAccount);
  listen($('marketConfirmBuy'), 'click', () => transact('purchase', marketplaceItem(market.pending)));
  listen($('marketCancelBuy'), 'click', () => { market.pending = null; render(); });
  listen($('marketResetPreview'), 'click', () => { market.tryOn = null; preview(); });
  for (const b of document.querySelectorAll('[data-market-filter]')) listen(b, 'click', () => {
    market.filter = b.dataset.marketFilter;
    document.querySelectorAll('[data-market-filter]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === b)));
    render();
  });
  refreshAccount(); refreshAppearance();
  market.timer = timers.setInterval(refreshAppearance, 60000);
}
function stopMarketplace() {
  market.active = false; market.generation++;
  market.dependencies?.timers.clearInterval(market.timer);
  for (const remove of market.listeners) remove();
  market.listeners.length = 0;
  if ($('marketDialog').open) $('marketDialog').close();
  market.preview?.dispose();
  market.preview = null; market.account = null; market.profile = null;
  market.pending = null; market.tryOn = null; market.loadPromise = null; market.previewPromise = null;
  $('marketBalance').textContent = '—'; $('marketAccountName').textContent = '';
  $('marketGrid').replaceChildren(); $('marketSlots').replaceChildren();
  $('marketAttributes').replaceChildren();
}

export { initMarketplace, stopMarketplace };
