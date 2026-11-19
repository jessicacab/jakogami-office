-- Marketplace weapons: a fourth equipment slot, `weapon`, and six weapons (docs/DUEL-SPEC.md, Phase 1.2).
-- Run after 202611090001, 202611090002 and 202611190001 in the SAME Supabase project. Additive and rerunnable:
-- nobody's coins, inventory or equipment change. It widens the catalog's slot check, adds an equipment column, and
-- updates office_market_snapshot and office_market_equip to know the new slot (same signatures). The original
-- office_market_appearances is left as it is; office_market_appearances_full adds the weapon.
-- If you ever rerun 202611090001_marketplace.sql, run this one again afterwards (that file restores the 3-slot functions).
begin;

-- the catalog accepts weapons
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.office_market_catalog'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%slot%'
  loop
    execute format('alter table public.office_market_catalog drop constraint %I', c.conname);
  end loop;
end
$$;
alter table public.office_market_catalog
  add constraint office_market_catalog_slot_check check (slot in ('outfit', 'armor', 'pet', 'weapon'));

-- what each account holds
alter table public.office_market_equipment
  add column if not exists weapon text references public.office_market_catalog (id);

insert into public.office_market_catalog (id, name, slot, price, rarity, description, color, accent, model)
values
  ('weapon-katana', 'Hotfix Katana', 'weapon', 1800, 'Epic', 'A quick blade with a little extra reach. Ships fixes, fast.', '#c9d3dd', '#d2462f', 'sword'),
  ('weapon-staff', 'Archive Staff', 'weapon', 2200, 'Epic', 'A long oak staff with a glowing crystal. The longest melee reach.', '#7a5636', '#8cc7ea', 'staff'),
  ('weapon-hammer', 'Merge Conflict Hammer', 'weapon', 2400, 'Epic', 'Slow to swing, hard to forget.', '#5a5862', '#e0524a', 'hammer'),
  ('weapon-greatsword', 'Monolith Greatsword', 'weapon', 2600, 'Legendary', 'A huge two-handed blade: long reach, heavy hits, slow swings.', '#8a93a3', '#f2c14e', 'greatsword'),
  ('weapon-pistol', 'Pulse Pistol', 'weapon', 2800, 'Legendary', 'Fires quick energy bolts across the whole helipad.', '#2f3640', '#4fb3ff', 'pistol'),
  ('weapon-rifle', 'Ion Rifle', 'weapon', 4000, 'Legendary', 'Slower, heavier bolts from a long energy rifle.', '#39424e', '#7ef0e0', 'rifle')
on conflict (id) do update set
  name = excluded.name,
  slot = excluded.slot,
  price = excluded.price,
  rarity = excluded.rarity,
  description = excluded.description,
  color = excluded.color,
  accent = excluded.accent,
  model = excluded.model;

-- the account snapshot includes the weapon
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
  eq_weapon text;
begin
  select balance into bal from public.office_market_wallets where user_id = p_user_id;
  if bal is null then
    perform public.office_market_raise('setup_required');
  end if;

  select coalesce(jsonb_agg(i.item_id order by i.acquired_at, i.item_id), '[]'::jsonb)
    into inv
  from public.office_market_inventory i
  where i.user_id = p_user_id;

  select e.outfit, e.armor, e.pet, e.weapon
    into eq_outfit, eq_armor, eq_pet, eq_weapon
  from public.office_market_equipment e
  where e.user_id = p_user_id;

  return jsonb_build_object(
    'balance', bal,
    'inventory', inv,
    'equipped', jsonb_build_object(
      'outfit', eq_outfit,
      'armor', eq_armor,
      'pet', eq_pet,
      'weapon', eq_weapon
    )
  );
end;
$$;

-- equipping accepts the weapon slot (ownership and slot checks unchanged)
create or replace function public.office_market_equip(p_user_id uuid, p_slot text, p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item_slot text;
begin
  if p_slot is null or p_slot not in ('outfit', 'armor', 'pet', 'weapon') then
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
  elsif p_slot = 'weapon' then
    update public.office_market_equipment
    set weapon = p_item_id, updated_at = now()
    where user_id = p_user_id;
  else
    update public.office_market_equipment
    set pet = p_item_id, updated_at = now()
    where user_id = p_user_id;
  end if;

  return public.office_market_snapshot(p_user_id);
end;
$$;

-- Share appearance IDs only, now with the weapon. No wallet initialization or private state reads.
create or replace function public.office_market_appearances_full()
returns table (user_id uuid, outfit text, armor text, pet text, weapon text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.office_market_session_user();
  return query
    select p.id, e.outfit, e.armor, e.pet, e.weapon
    from public.profiles p
    left join public.office_market_equipment e on e.user_id = p.id
    where p.role in ('employee', 'super_admin');
end;
$$;

revoke all on function public.office_market_appearances_full() from public, anon, authenticated;
grant execute on function public.office_market_appearances_full() to authenticated;
-- (office_market_snapshot and office_market_equip keep their existing grants: service role only)

notify pgrst, 'reload schema';
commit;
