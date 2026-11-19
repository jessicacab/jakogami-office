-- Synthetic data only; executed in a disposable local PostgreSQL cluster.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
create table public.profiles (id uuid primary key references auth.users(id), role text not null);
insert into auth.users values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');
insert into public.profiles values
  ('11111111-1111-1111-1111-111111111111', 'employee'),
  ('22222222-2222-2222-2222-222222222222', 'super_admin'),
  ('33333333-3333-3333-3333-333333333333', 'client'),
  ('44444444-4444-4444-4444-444444444444', 'employee');
alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;
create policy profiles_own on public.profiles to authenticated using (id = auth.uid());

\ir ../migrations/202611090001_marketplace.sql
\ir ../migrations/202611090002_marketplace_session_access.sql
\ir ../migrations/202611190001_marketplace_items.sql
\ir ../migrations/202611190001_marketplace_items.sql
\ir ../migrations/202611190002_marketplace_weapons.sql
\ir ../migrations/202611190002_marketplace_weapons.sql

set role anon;
do $$
begin
  begin
    perform public.office_market_my_state();
    raise exception 'anonymous state access succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.office_market_my_purchase('outfit-tide', 450);
    raise exception 'anonymous purchase succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.office_market_appearances();
    raise exception 'anonymous appearance access succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set role authenticated;
do $$
begin
  -- Even an authenticated role cannot proceed without a valid account claim.
  begin
    perform public.office_market_my_state();
    raise exception 'missing identity accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
begin
  begin
    perform public.office_market_my_state();
    raise exception 'non-office account accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.office_market_appearances();
    raise exception 'non-office viewer accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare
  result jsonb;
begin
  assert (select count(*) from public.office_market_appearances()) = 3, 'office appearances missing';
  result := public.office_market_my_state();
  assert (result->>'balance')::integer = 3000, 'welcome credit missing';
  result := public.office_market_my_purchase('outfit-tide', 450);
  assert (result->>'balance')::integer = 2550, 'purchase balance incorrect';
  result := public.office_market_my_purchase('outfit-tide', 450);
  assert (result->>'balance')::integer = 2550, 'duplicate charged twice';
  result := public.office_market_my_equip('outfit', 'outfit-tide');
  assert result->'equipped'->>'outfit' = 'outfit-tide', 'equip did not persist';
  begin
    perform public.office_market_my_purchase('pet-cloud', 1);
    raise exception 'forged price accepted';
  exception when raise_exception then
    if sqlerrm <> 'catalog_changed' then raise; end if;
  end;
  begin
    perform public.office_market_my_equip('pet', 'pet-cloud');
    raise exception 'unowned item equipped';
  exception when raise_exception then
    if sqlerrm <> 'not_owned' then raise; end if;
  end;
  begin
    perform public.office_market_state('22222222-2222-2222-2222-222222222222');
    raise exception 'other account state opened';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.office_market_purchase('22222222-2222-2222-2222-222222222222', 'pet-cloud', 1000);
    raise exception 'other account purchase allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.office_market_snapshot('22222222-2222-2222-2222-222222222222');
    raise exception 'private snapshot allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.office_market_session_user();
    raise exception 'private identity helper allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.office_market_wallets set balance = 999999;
    raise exception 'direct wallet update allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.office_market_inventory (user_id, item_id)
    values (auth.uid(), 'pet-cloud');
    raise exception 'direct inventory insert allowed';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
do $$
begin
  assert (select count(*) from public.office_market_wallets) = 1, 'appearance initialized wallets';
  assert (select count(*) from public.office_market_transactions where kind = 'welcome') = 1, 'duplicate welcome credit';
end;
$$;

-- Rerun both scripts after real purchases; they must preserve balances and ownership.
\ir ../migrations/202611090001_marketplace.sql
\ir ../migrations/202611090002_marketplace_session_access.sql
\ir ../migrations/202611190001_marketplace_items.sql
\ir ../migrations/202611190001_marketplace_items.sql
\ir ../migrations/202611190002_marketplace_weapons.sql
\ir ../migrations/202611190002_marketplace_weapons.sql
\ir ../migrations/202611090002_marketplace_session_access.sql
\ir ../migrations/202611190001_marketplace_items.sql
\ir ../migrations/202611190001_marketplace_items.sql
\ir ../migrations/202611190002_marketplace_weapons.sql
\ir ../migrations/202611190002_marketplace_weapons.sql

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare
  result jsonb;
begin
  result := public.office_market_my_state();
  assert (result->>'balance')::integer = 3000, 'other account balance incorrect';
  assert result->'inventory' = '[]'::jsonb, 'inventory crossed accounts';
  assert (select count(*) from public.office_market_wallets) = 1, 'wallet RLS leaked other account';
  assert (select count(*) from public.office_market_inventory) = 0, 'inventory RLS leaked other account';
  assert (select outfit from public.office_market_appearances()
    where user_id = '11111111-1111-1111-1111-111111111111') = 'outfit-tide', 'other viewer cannot see appearance';
end;
$$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare
  result jsonb;
begin
  result := public.office_market_my_state();
  assert (result->>'balance')::integer = 2550, 'rerun refilled coins';
  assert result->'inventory' = '["outfit-tide"]'::jsonb, 'rerun changed inventory';
  assert result->'equipped'->>'outfit' = 'outfit-tide', 'rerun changed equipment';
  perform public.office_market_my_purchase('armor-solar', 1200);
  perform public.office_market_my_purchase('pet-cloud', 1000);
  begin
    perform public.office_market_my_purchase('armor-sentinel', 900);
    raise exception 'overspending accepted';
  exception when raise_exception then
    if sqlerrm <> 'insufficient_funds' then raise; end if;
  end;
  result := public.office_market_my_state();
  assert (result->>'balance')::integer = 350, 'failed purchase changed balance';
  result := public.office_market_my_equip('outfit', null);
  assert result->'equipped'->>'outfit' is null, 'unequip failed';
end;
$$;
reset role;
do $$
begin
  assert (select count(*) from public.office_market_wallets) = 2, 'unexpected wallet initialization';
  assert not exists (select 1 from public.office_market_wallets where balance < 0), 'negative balance';
  assert (select count(*) from public.office_market_transactions where kind = 'welcome') = 2, 'welcome credits repeated';
end;
$$;

-- volume 2 items are in the catalog and can be bought at their catalog price
reset role;
do $$
begin
  assert (select count(*) from public.office_market_catalog) = 21, 'catalog should have 21 items';
  assert (select count(*) from public.office_market_catalog where slot = 'weapon') = 6, 'six weapons';
  assert (select price from public.office_market_catalog where id = 'outfit-hoodie') = 300, 'hoodie price';
end;
$$;
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
declare
  result jsonb;
begin
  result := public.office_market_my_purchase('pet-drone', 950);
  assert result->'inventory' ? 'pet-drone', 'new item not bought';
  result := public.office_market_my_equip('pet', 'pet-drone');
  assert result->'equipped'->>'pet' = 'pet-drone', 'new item not equipped';
end;
$$;
reset role;

-- weapons: buy and equip one; it shows in the shared appearance; the wrong slot and unowned weapons are refused
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
declare
  result jsonb;
begin
  result := public.office_market_my_purchase('weapon-katana', 1800);
  assert result->'inventory' ? 'weapon-katana', 'weapon not bought';
  assert (result->>'balance')::integer = 3000 - 950 - 1800, 'weapon price not charged';
  result := public.office_market_my_equip('weapon', 'weapon-katana');
  assert result->'equipped'->>'weapon' = 'weapon-katana', 'weapon not equipped';
  begin
    perform public.office_market_my_equip('pet', 'weapon-katana');
    raise exception 'weapon equipped in the pet slot';
  exception when raise_exception then
    if sqlerrm <> 'invalid_slot' then raise; end if;
  end;
  begin
    perform public.office_market_my_equip('weapon', 'weapon-rifle');
    raise exception 'unowned weapon equipped';
  exception when raise_exception then
    if sqlerrm <> 'not_owned' then raise; end if;
  end;
  assert (select weapon from public.office_market_appearances_full()
    where user_id = '44444444-4444-4444-4444-444444444444') = 'weapon-katana', 'weapon not in the shared appearance';
  assert (select count(*) from public.office_market_appearances()) > 0, 'the original appearance function still works';
end;
$$;
reset role;
