-- Office marketplace: wallets, catalog, inventory, equipment, transactions.
-- Idempotent / rerunnable. Prices and ownership live in the database.
-- RPCs are service_role-only; the authenticated BFF is the sole caller.
-- Does not create or alter global roles (anon/authenticated/service_role already exist on Supabase).

begin;

create schema if not exists public;

-- Requires existing Supabase auth.users (do not create/alter auth schema or roles here).
-- Local verification harnesses must stub auth.users before applying this migration.

create table if not exists public.office_market_catalog (
  id text primary key,
  name text not null,
  slot text not null check (slot in ('outfit', 'armor', 'pet')),
  price integer not null check (price > 0),
  rarity text,
  description text,
  color text,
  accent text,
  model text,
  created_at timestamptz not null default now()
);

create table if not exists public.office_market_wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance integer not null check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- If table already existed without FK (earlier draft), add FK when missing.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'office_market_wallets_user_id_fkey'
      and conrelid = 'public.office_market_wallets'::regclass
  ) then
    alter table public.office_market_wallets
      add constraint office_market_wallets_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.office_market_inventory (
  user_id uuid not null references public.office_market_wallets (user_id) on delete cascade,
  item_id text not null references public.office_market_catalog (id),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists public.office_market_equipment (
  user_id uuid primary key references public.office_market_wallets (user_id) on delete cascade,
  outfit text references public.office_market_catalog (id),
  armor text references public.office_market_catalog (id),
  pet text references public.office_market_catalog (id),
  updated_at timestamptz not null default now()
);

create table if not exists public.office_market_transactions (
  id bigserial primary key,
  user_id uuid not null references public.office_market_wallets (user_id) on delete cascade,
  kind text not null check (kind in ('welcome', 'purchase')),
  item_id text references public.office_market_catalog (id),
  amount integer not null,
  balance_after integer not null check (balance_after >= 0),
  created_at timestamptz not null default now()
);

create unique index if not exists office_market_transactions_welcome_once_idx
  on public.office_market_transactions (user_id)
  where kind = 'welcome';

create index if not exists office_market_inventory_user_idx
  on public.office_market_inventory (user_id);

create index if not exists office_market_transactions_user_idx
  on public.office_market_transactions (user_id, created_at desc);

-- Seed matches src/config/marketplace.js (database owns prices).
insert into public.office_market_catalog (id, name, slot, price, rarity, description, color, accent, model)
values
  ('outfit-tide', 'Tideweave Dress', 'outfit', 450, 'Uncommon', 'A flowing teal tunic and skirt layered over your current look.', '#47a9ac', '#bce6df', 'dress'),
  ('outfit-ember', 'Embercoat', 'outfit', 600, 'Rare', 'A warm crimson coat with a gold-trimmed collar.', '#ae4b51', '#efc17b', 'coat'),
  ('armor-sentinel', 'Sentinel Plate', 'armor', 900, 'Rare', 'Steel shoulder plates and a fitted breastplate. Cosmetic only.', '#7296ac', '#d1e3eb', 'plate'),
  ('armor-solar', 'Solar Guard', 'armor', 1200, 'Epic', 'Golden armor with violet accents. Cosmetic only.', '#d3a34d', '#a294da', 'plate'),
  ('pet-sprout', 'Sprout Fox', 'pet', 700, 'Uncommon', 'A little forest fox that stays close to its companion.', '#80b58d', '#e4edcc', 'fox'),
  ('pet-cloud', 'Cloud Wisp', 'pet', 1000, 'Rare', 'A floating blue companion with an orbiting halo.', '#8cc7ea', '#e2d1ff', 'wisp')
on conflict (id) do update set
  name = excluded.name,
  slot = excluded.slot,
  price = excluded.price,
  rarity = excluded.rarity,
  description = excluded.description,
  color = excluded.color,
  accent = excluded.accent,
  model = excluded.model;

-- ---------------------------------------------------------------------------
-- Helpers / RPCs (service_role only)
-- ---------------------------------------------------------------------------

create or replace function public.office_market_raise(p_code text)
returns void
language plpgsql
as $$
begin
  raise exception '%', p_code using errcode = 'P0001';
end;
$$;

create or replace function public.office_market_ensure_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  wallet_inserted boolean := false;
begin
  if p_user_id is null then
    perform public.office_market_raise('setup_required');
  end if;

  insert into public.office_market_wallets (user_id, balance)
  values (p_user_id, 3000)
  on conflict (user_id) do nothing
  returning true into wallet_inserted;

  if coalesce(wallet_inserted, false) then
    insert into public.office_market_transactions (user_id, kind, item_id, amount, balance_after)
    values (p_user_id, 'welcome', null, 3000, 3000)
    on conflict (user_id) where kind = 'welcome' do nothing;
  end if;

  insert into public.office_market_equipment (user_id, outfit, armor, pet)
  values (p_user_id, null, null, null)
  on conflict (user_id) do nothing;
end;
$$;

create or replace function public.office_market_snapshot(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  bal integer;
  inv jsonb;
  eq_outfit text;
  eq_armor text;
  eq_pet text;
begin
  select balance into bal from public.office_market_wallets where user_id = p_user_id;
  if bal is null then
    perform public.office_market_raise('setup_required');
  end if;

  select coalesce(jsonb_agg(i.item_id order by i.acquired_at, i.item_id), '[]'::jsonb)
    into inv
  from public.office_market_inventory i
  where i.user_id = p_user_id;

  select e.outfit, e.armor, e.pet
    into eq_outfit, eq_armor, eq_pet
  from public.office_market_equipment e
  where e.user_id = p_user_id;

  return jsonb_build_object(
    'balance', bal,
    'inventory', inv,
    'equipped', jsonb_build_object(
      'outfit', eq_outfit,
      'armor', eq_armor,
      'pet', eq_pet
    )
  );
end;
$$;

create or replace function public.office_market_state(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.office_market_ensure_account(p_user_id);
  perform 1 from public.office_market_wallets where user_id = p_user_id for update;
  return public.office_market_snapshot(p_user_id);
end;
$$;

-- Drop prior purchase overloads so only the expected-price signature remains.
drop function if exists public.office_market_purchase(uuid, text);
drop function if exists public.office_market_purchase(uuid, text, integer);

create or replace function public.office_market_purchase(
  p_user_id uuid,
  p_item_id text,
  p_expected_price integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item_slot text;
  item_price integer;
  bal integer;
  already boolean;
begin
  if p_item_id is null or length(trim(p_item_id)) = 0 then
    perform public.office_market_raise('invalid_item');
  end if;

  if p_expected_price is null or p_expected_price <= 0 then
    perform public.office_market_raise('catalog_changed');
  end if;

  perform public.office_market_ensure_account(p_user_id);

  select balance into bal
  from public.office_market_wallets
  where user_id = p_user_id
  for update;

  if bal is null then
    perform public.office_market_raise('setup_required');
  end if;

  select c.slot, c.price into item_slot, item_price
  from public.office_market_catalog c
  where c.id = p_item_id;

  if item_slot is null then
    perform public.office_market_raise('invalid_item');
  end if;

  -- Server-supplied expected price must match DB catalog (UI catalog drift guard).
  if item_price is distinct from p_expected_price then
    perform public.office_market_raise('catalog_changed');
  end if;

  select exists (
    select 1 from public.office_market_inventory i
    where i.user_id = p_user_id and i.item_id = p_item_id
  ) into already;

  -- Idempotent duplicate ownership: no second charge.
  if already then
    return public.office_market_snapshot(p_user_id);
  end if;

  if bal < item_price then
    perform public.office_market_raise('insufficient_funds');
  end if;

  update public.office_market_wallets
  set balance = balance - item_price,
      updated_at = now()
  where user_id = p_user_id
  returning balance into bal;

  begin
    insert into public.office_market_inventory (user_id, item_id)
    values (p_user_id, p_item_id);
  exception
    when unique_violation then
      -- Lost a concurrent insert after debit: restore coins and treat as owned.
      update public.office_market_wallets
      set balance = balance + item_price,
          updated_at = now()
      where user_id = p_user_id;
      return public.office_market_snapshot(p_user_id);
  end;

  insert into public.office_market_transactions (user_id, kind, item_id, amount, balance_after)
  values (p_user_id, 'purchase', p_item_id, -item_price, bal);

  return public.office_market_snapshot(p_user_id);
end;
$$;

create or replace function public.office_market_equip(p_user_id uuid, p_slot text, p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item_slot text;
begin
  if p_slot is null or p_slot not in ('outfit', 'armor', 'pet') then
    perform public.office_market_raise('invalid_slot');
  end if;

  perform public.office_market_ensure_account(p_user_id);

  -- Serialize equip with wallet row lock (same account mutex as purchases).
  perform 1 from public.office_market_wallets where user_id = p_user_id for update;

  insert into public.office_market_equipment (user_id, outfit, armor, pet)
  values (p_user_id, null, null, null)
  on conflict (user_id) do nothing;

  if p_item_id is not null then
    select c.slot into item_slot
    from public.office_market_catalog c
    where c.id = p_item_id;

    if item_slot is null then
      perform public.office_market_raise('invalid_item');
    end if;

    if item_slot is distinct from p_slot then
      perform public.office_market_raise('invalid_slot');
    end if;

    if not exists (
      select 1 from public.office_market_inventory i
      where i.user_id = p_user_id and i.item_id = p_item_id
    ) then
      perform public.office_market_raise('not_owned');
    end if;
  end if;

  if p_slot = 'outfit' then
    update public.office_market_equipment
    set outfit = p_item_id, updated_at = now()
    where user_id = p_user_id;
  elsif p_slot = 'armor' then
    update public.office_market_equipment
    set armor = p_item_id, updated_at = now()
    where user_id = p_user_id;
  else
    update public.office_market_equipment
    set pet = p_item_id, updated_at = now()
    where user_id = p_user_id;
  end if;

  return public.office_market_snapshot(p_user_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------

revoke all on function public.office_market_raise(text) from public;
revoke all on function public.office_market_ensure_account(uuid) from public;
revoke all on function public.office_market_snapshot(uuid) from public;
revoke all on function public.office_market_state(uuid) from public;
revoke all on function public.office_market_purchase(uuid, text, integer) from public;
revoke all on function public.office_market_equip(uuid, text, text) from public;

revoke all on function public.office_market_raise(text) from anon, authenticated;
revoke all on function public.office_market_ensure_account(uuid) from anon, authenticated;
revoke all on function public.office_market_snapshot(uuid) from anon, authenticated;
revoke all on function public.office_market_state(uuid) from anon, authenticated;
revoke all on function public.office_market_purchase(uuid, text, integer) from anon, authenticated;
revoke all on function public.office_market_equip(uuid, text, text) from anon, authenticated;

-- Ensure any leftover 2-arg purchase overload cannot be called.
do $$
begin
  execute 'revoke all on function public.office_market_purchase(uuid, text) from public, anon, authenticated, service_role';
exception
  when undefined_function then null;
end
$$;

grant execute on function public.office_market_state(uuid) to service_role;
grant execute on function public.office_market_purchase(uuid, text, integer) to service_role;
grant execute on function public.office_market_equip(uuid, text, text) to service_role;
grant execute on function public.office_market_raise(text) to service_role;
grant execute on function public.office_market_ensure_account(uuid) to service_role;
grant execute on function public.office_market_snapshot(uuid) to service_role;

alter table public.office_market_catalog enable row level security;
alter table public.office_market_wallets enable row level security;
alter table public.office_market_inventory enable row level security;
alter table public.office_market_equipment enable row level security;
alter table public.office_market_transactions enable row level security;

drop policy if exists office_market_catalog_select_authenticated on public.office_market_catalog;
create policy office_market_catalog_select_authenticated
  on public.office_market_catalog
  for select
  to authenticated
  using (true);

drop policy if exists office_market_wallets_select_own on public.office_market_wallets;
create policy office_market_wallets_select_own
  on public.office_market_wallets
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists office_market_inventory_select_own on public.office_market_inventory;
create policy office_market_inventory_select_own
  on public.office_market_inventory
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists office_market_equipment_select_own on public.office_market_equipment;
create policy office_market_equipment_select_own
  on public.office_market_equipment
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists office_market_transactions_select_own on public.office_market_transactions;
create policy office_market_transactions_select_own
  on public.office_market_transactions
  for select
  to authenticated
  using (user_id = auth.uid());

-- Strip default privileges (including TRUNCATE/INSERT/UPDATE) before granting SELECT.
revoke all on table public.office_market_catalog from public;
revoke all on table public.office_market_wallets from public;
revoke all on table public.office_market_inventory from public;
revoke all on table public.office_market_equipment from public;
revoke all on table public.office_market_transactions from public;

revoke all on table public.office_market_catalog from anon;
revoke all on table public.office_market_wallets from anon;
revoke all on table public.office_market_inventory from anon;
revoke all on table public.office_market_equipment from anon;
revoke all on table public.office_market_transactions from anon;

revoke all on table public.office_market_catalog from authenticated;
revoke all on table public.office_market_wallets from authenticated;
revoke all on table public.office_market_inventory from authenticated;
revoke all on table public.office_market_equipment from authenticated;
revoke all on table public.office_market_transactions from authenticated;

revoke all on sequence public.office_market_transactions_id_seq from public;
revoke all on sequence public.office_market_transactions_id_seq from anon;
revoke all on sequence public.office_market_transactions_id_seq from authenticated;

grant select on table public.office_market_catalog to authenticated;
grant select on table public.office_market_wallets to authenticated;
grant select on table public.office_market_inventory to authenticated;
grant select on table public.office_market_equipment to authenticated;
grant select on table public.office_market_transactions to authenticated;

-- service_role: full DML on mutable state tables; append-only ledger is SELECT/INSERT only.
grant select, insert, update, delete on table public.office_market_catalog to service_role;
grant select, insert, update, delete on table public.office_market_wallets to service_role;
grant select, insert, update, delete on table public.office_market_inventory to service_role;
grant select, insert, update, delete on table public.office_market_equipment to service_role;
revoke all on table public.office_market_transactions from service_role;
grant select, insert on table public.office_market_transactions to service_role;
grant usage, select on sequence public.office_market_transactions_id_seq to service_role;

notify pgrst, 'reload schema';
commit;
