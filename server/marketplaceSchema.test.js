import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MARKETPLACE_CATALOG } from '../src/config/marketplace.js';

const sql = readFileSync(new URL('../supabase/migrations/202611090001_marketplace.sql', import.meta.url), 'utf8');
// Catalog rows may be added by later migrations (volume 2: 202611190001_marketplace_items.sql).
const seeds = sql + readFileSync(new URL('../supabase/migrations/202611190001_marketplace_items.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../supabase/migrations/202611190002_marketplace_weapons.sql', import.meta.url), 'utf8');
const literal = text => `'${text.replaceAll("'", "''")}'`;

test('SQL catalog IDs, names, slots, and prices agree with the shared marketplace catalog', () => {
  for (const item of MARKETPLACE_CATALOG) {
    const seed = `(${literal(item.id)}, ${literal(item.name)}, ${literal(item.slot)}, ${item.price},`;
    assert.ok(seeds.includes(seed), `SQL seed differs for ${item.id}`);
  }
});

test('migration is atomic, leaves Supabase auth/roles untouched, and restricts browser writes', () => {
  assert.match(sql, /\nbegin;/);
  assert.match(sql, /notify pgrst, 'reload schema';\s*commit;\s*$/);
  assert.doesNotMatch(sql, /^\s*create\s+role\b/im);
  assert.doesNotMatch(sql, /^\s*create\s+(?:schema|table).*?\bauth[.\s]/im);
  assert.match(sql, /references auth\.users \(id\) on delete cascade/i);
  for (const table of ['catalog', 'wallets', 'inventory', 'equipment', 'transactions']) {
    assert.ok(sql.includes(`revoke all on table public.office_market_${table} from authenticated;`));
    assert.ok(sql.includes(`alter table public.office_market_${table} enable row level security;`));
  }
  assert.match(sql, /revoke all on function public\.office_market_purchase\(uuid, text, integer\) from anon, authenticated/);
});

test('the volume 2 catalog migration is atomic, additive and touches only catalog rows', () => {
  const v2 = readFileSync(new URL('../supabase/migrations/202611190001_marketplace_items.sql', import.meta.url), 'utf8');
  assert.match(v2, /\nbegin;/);
  assert.match(v2, /notify pgrst, 'reload schema';\s*commit;\s*$/);
  assert.doesNotMatch(v2, /^\s*(drop|delete|truncate|update|alter|grant|revoke)\b/im);
  assert.equal((v2.match(/insert into public\.office_market_catalog/g) ?? []).length, 1);
});
