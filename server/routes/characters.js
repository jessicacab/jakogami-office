import { Router } from 'express';
import { normalizeSpec } from '../../src/character/spec.js';
import { isMissingSchema } from './marketplace.js';

// Your own character's look (docs: README, "My character"). The account is always the verified session's: nobody can
// save someone else's look. The look is cleaned with the same rules the browser uses (character/spec.js) before it is
// stored, and everyone online is told so they see it at once (`onSaved`, the realtime connection).
function characterRoutes(db, onSaved = () => {}) {
  const r = Router();
  r.put('/characters/me', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'spec') || !body.spec || typeof body.spec !== 'object') {
      return res.status(400).json({ error: 'Send your character as { spec }.' });
    }
    const spec = normalizeSpec(body.spec);
    try {
      const { error } = await db.from('office_character_looks').upsert({ user_id: req.profile.id, spec, updated_at: new Date().toISOString() });
      if (error) throw error;
    } catch (error) {
      if (isMissingSchema(error) || error?.code === '42501') return res.status(503).json({ error: 'Saving characters needs setup: run supabase/migrations/202611200001_character_looks.sql.', code: 'setup_required' });
      return res.status(503).json({ error: 'Your character could not be saved right now. Try again in a moment.' });
    }
    onSaved(req.profile.id, spec);
    res.json({ spec });
  });
  return r;
}

// Everyone's saved looks, for the staff list: Map userId → spec. Missing table (not set up yet): no looks.
async function savedLooks(db) {
  try {
    const { data, error } = await db.from('office_character_looks').select('user_id, spec');
    if (error) return new Map();
    return new Map((data ?? []).map(row => [row.user_id, normalizeSpec(row.spec)]));
  } catch (_) { return new Map(); }
}

export { characterRoutes, savedLooks };
