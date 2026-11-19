import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../supabase/migrations/202611200001_character_looks.sql', import.meta.url), 'utf8');

test('character looks migration: atomic, additive, closed to browsers, size-limited', () => {
  assert.match(sql, /\nbegin;/);
  assert.match(sql, /notify pgrst, 'reload schema';\s*commit;\s*$/);
  assert.doesNotMatch(sql, /^\s*(drop|delete|truncate|update)\b/im);
  assert.match(sql, /alter table public\.office_character_looks enable row level security;/);
  assert.match(sql, /revoke all on table public\.office_character_looks from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant [^;]* to (anon|authenticated)/i);
  assert.match(sql, /octet_length\(spec::text\) <= 8192/);
});
