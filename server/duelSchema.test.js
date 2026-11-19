import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DUEL_RESULTS } from '../src/config/duel.js';

const sql = readFileSync(new URL('../supabase/migrations/202611180001_duel.sql', import.meta.url), 'utf8');

test('duel migration is atomic, additive, and closed to browsers except the records function', () => {
  assert.match(sql, /\nbegin;/);
  assert.match(sql, /notify pgrst, 'reload schema';\s*commit;\s*$/);
  assert.doesNotMatch(sql, /^\s*(drop|truncate|delete)\b/im);
  assert.doesNotMatch(sql, /^\s*create\s+role\b/im);
  assert.match(sql, /alter table public\.office_duel_matches enable row level security;/);
  assert.match(sql, /revoke all on table public\.office_duel_matches from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant [^;]* on table public\.office_duel_matches to (anon|authenticated)/i);
  assert.match(sql, /grant execute on function public\.office_duel_records\(uuid\[\]\) to authenticated;/);
  assert.match(sql, /security definer\s+set search_path = pg_catalog, pg_temp/);
});

test('result values in SQL match the shared rules', () => {
  const values = sql.match(/result in \(([^)]*)\)/)[1].split(',').map(s => s.trim().replaceAll("'", ''));
  assert.deepEqual(values, DUEL_RESULTS);
});
