import { Router } from 'express';
import { isMissingSchema } from './marketplace.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 100;

// Duel records (wins, losses, draws) for people shown in the office. Read with the signed-in user's own session
// through office_duel_records (supabase/migrations/202611180001_duel.sql), which checks the caller is office staff.
function duelRoutes(clientFactory) {
  const r = Router();
  r.get('/duel/records', async (req, res) => {
    const ids = [...new Set(String(req.query.ids ?? '').split(',').map(s => s.trim()).filter(Boolean))];
    if (!ids.length || ids.length > MAX_IDS || !ids.every(id => UUID.test(id))) return res.status(400).json({ error: 'Invalid duel record request.' });
    const db = clientFactory(req.accessToken);
    if (!db) return res.status(503).json({ error: 'Duel records are temporarily unavailable.' });
    try {
      const { data, error } = await db.rpc('office_duel_records', { p_user_ids: ids });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('invalid_state');
      res.json({ records: data.map(row => ({ userId: row.user_id, wins: Number(row.wins) || 0, losses: Number(row.losses) || 0, draws: Number(row.draws) || 0 })) });
    } catch (error) {
      if (isMissingSchema(error) || error?.code === '42501') return res.status(503).json({ error: 'Duel records need setup: run supabase/migrations/202611180001_duel.sql.', code: 'setup_required' });
      res.status(503).json({ error: 'Duel records are temporarily unavailable.' });
    }
  });
  return r;
}

export { duelRoutes };
