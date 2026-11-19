import { Router } from 'express';
import {
  EQUIPMENT_SLOTS,
  characterAttributes,
  marketplaceItem,
  normalizeEquipment,
} from '../../src/config/marketplace.js';

const MARKET_ERROR_CODES = new Set([
  'insufficient_funds',
  'invalid_item',
  'not_owned',
  'invalid_slot',
  'setup_required',
  'catalog_changed',
  'account_changed',
  'invalid_request',
  'service_unavailable',
]);

const ERROR_STATUS = {
  insufficient_funds: 400,
  invalid_item: 400,
  not_owned: 400,
  invalid_slot: 400,
  invalid_request: 400,
  catalog_changed: 409,
  account_changed: 409,
  setup_required: 503,
  service_unavailable: 503,
};

const ERROR_MESSAGE = {
  insufficient_funds: 'Not enough coins for this purchase.',
  invalid_item: 'That marketplace item is not available.',
  not_owned: 'You do not own that item.',
  invalid_slot: 'That equipment slot is not valid.',
  invalid_request: 'Invalid marketplace request.',
  catalog_changed: 'Marketplace catalog changed. Refresh and try again.',
  account_changed: 'Signed-in account changed. Reload and try again.',
  setup_required: 'Marketplace setup is required. Run the Marketplace SQL migrations, including the session-access update.',
  service_unavailable: 'Marketplace is temporarily unavailable.',
};

function isMissingSchema(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  const hint = String(error?.hint || '').toLowerCase();
  const blob = `${message} ${details} ${hint}`;
  if (['42P01', '42883', 'PGRST202', 'PGRST205', 'PGRST204'].includes(code)) return true;
  return /does not exist|could not find the (table|function|schema)|schema cache|office_market_/.test(blob)
    && /does not exist|could not find|schema cache|undefined/.test(blob);
}

function marketErrorCode(error) {
  if (!error) return null;
  if (error.code === 'invalid_state' || error.message === 'invalid_state') return 'service_unavailable';
  if (error.code === '42501') return 'setup_required';
  if (isMissingSchema(error)) return 'setup_required';
  const candidates = [error.message, error.details, error.hint, error.code]
    .filter(Boolean)
    .map(String);
  for (const text of candidates) {
    const trimmed = text.trim();
    if (MARKET_ERROR_CODES.has(trimmed)) return trimmed;
    for (const code of MARKET_ERROR_CODES) {
      if (trimmed === code || trimmed.endsWith(` ${code}`) || trimmed.includes(code)) return code;
    }
  }
  return null;
}

function sendMarketError(res, code, fallbackStatus = 503) {
  const resolved = MARKET_ERROR_CODES.has(code) ? code : 'service_unavailable';
  const status = ERROR_STATUS[resolved] || fallbackStatus;
  return res.status(status).json({
    error: ERROR_MESSAGE[resolved] || ERROR_MESSAGE.service_unavailable,
    code: resolved,
  });
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const err = new Error('invalid_state');
    err.code = 'invalid_state';
    throw err;
  }
  const balance = raw.balance;
  if (!Number.isSafeInteger(balance) || balance < 0) {
    const err = new Error('invalid_state');
    err.code = 'invalid_state';
    throw err;
  }
  if (!Array.isArray(raw.inventory) || raw.inventory.some(id => typeof id !== 'string')) {
    const err = new Error('invalid_state');
    err.code = 'invalid_state';
    throw err;
  }
  if (!raw.equipped || typeof raw.equipped !== 'object' || Array.isArray(raw.equipped)) {
    const err = new Error('invalid_state');
    err.code = 'invalid_state';
    throw err;
  }
  return {
    balance,
    inventory: [...new Set(raw.inventory)],
    equipped: normalizeEquipment(raw.equipped),
  };
}

function assertExactKeys(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body).every(key => allowed.has(key));
}

// Header asserts UI account matches cookie session; it never selects identity.
function assertOfficeAccount(req, res) {
  const header = req.get('x-office-account');
  if (typeof header !== 'string' || !header.trim()) {
    sendMarketError(res, 'invalid_request');
    return false;
  }
  if (header.trim() !== String(req.profile.id)) {
    sendMarketError(res, 'account_changed');
    return false;
  }
  return true;
}

async function rpcMarket(db, fn, params) {
  const { data, error } = await db.rpc(fn, params);
  if (error) throw error;
  const state = normalizeState(data);
  // Never accept browser-supplied stats: only the verified equipped IDs contribute.
  return { ...state, attributes: characterAttributes(state.equipped) };
}

function handleRouteError(res, error) {
  const code = marketErrorCode(error) || 'service_unavailable';
  return sendMarketError(res, code);
}

function marketplaceRoutes(clientFactory) {
  const r = Router();
  r.use('/marketplace', (req, res, next) => {
    // Only the token verified by requireSession is used, never a browser-supplied header.
    req.marketDb = clientFactory(req.accessToken);
    if (!req.marketDb) return sendMarketError(res, 'service_unavailable');
    next();
  });

  r.get('/marketplace', async (req, res) => {
    if (!assertOfficeAccount(req, res)) return;
    try {
      const state = await rpcMarket(req.marketDb, 'office_market_my_state', {});
      res.json(state);
    } catch (error) {
      return handleRouteError(res, error);
    }
  });

  r.post('/marketplace/purchase', async (req, res) => {
    if (!assertOfficeAccount(req, res)) return;
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use a JSON request.', code: 'invalid_request' });
    const body = req.body || {};
    if (!assertExactKeys(body, new Set(['itemId']))) return sendMarketError(res, 'invalid_request');
    const itemId = body.itemId;
    if (typeof itemId !== 'string' || !itemId.trim() || itemId.length > 64) {
      return sendMarketError(res, 'invalid_item');
    }
    const item = marketplaceItem(itemId.trim());
    if (!item) return sendMarketError(res, 'invalid_item');
    try {
      // Identity from session only. Expected price from server catalog module (never client body).
      const state = await rpcMarket(req.marketDb, 'office_market_my_purchase', {
        p_item_id: item.id,
        p_expected_price: item.price,
      });
      res.json(state);
    } catch (error) {
      return handleRouteError(res, error);
    }
  });

  r.post('/marketplace/equip', async (req, res) => {
    if (!assertOfficeAccount(req, res)) return;
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use a JSON request.', code: 'invalid_request' });
    const body = req.body || {};
    if (!assertExactKeys(body, new Set(['slot', 'itemId']))) return sendMarketError(res, 'invalid_request');
    const slot = body.slot;
    const itemId = body.itemId ?? null;
    if (typeof slot !== 'string' || !EQUIPMENT_SLOTS.includes(slot)) {
      return sendMarketError(res, 'invalid_slot');
    }
    if (itemId !== null && (typeof itemId !== 'string' || !itemId.trim() || itemId.length > 64)) {
      return sendMarketError(res, 'invalid_item');
    }
    try {
      const state = await rpcMarket(req.marketDb, 'office_market_my_equip', {
        p_slot: slot,
        p_item_id: itemId === null ? null : itemId.trim(),
      });
      res.json(state);
    } catch (error) {
      return handleRouteError(res, error);
    }
  });

  // Public appearance only for valid office profiles. Does not open wallets.
  r.get('/marketplace/equipment', async (req, res) => {
    try {
      // The weapons migration adds office_market_appearances_full (with the weapon); before it, the original one.
      let { data: rows, error } = await req.marketDb.rpc('office_market_appearances_full', {});
      if (error && isMissingSchema(error)) ({ data: rows, error } = await req.marketDb.rpc('office_market_appearances', {}));
      if (error) throw error;
      if (!Array.isArray(rows)) throw new Error('invalid_state');
      res.json({
        equipment: rows.map(row => ({
          userId: row.user_id,
          equipped: normalizeEquipment({ outfit: row.outfit, armor: row.armor, pet: row.pet, weapon: row.weapon }),
        })),
      });
    } catch (error) {
      return handleRouteError(res, error);
    }
  });

  return r;
}

export { marketplaceRoutes, isMissingSchema, marketErrorCode, normalizeState };
