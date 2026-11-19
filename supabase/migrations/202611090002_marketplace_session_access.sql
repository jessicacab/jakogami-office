-- Run after 202611090001_marketplace.sql in the SAME Supabase project.
-- Uses the existing signed-in session, not a new API key.
-- Additive and rerunnable: no wallet resets, inventory changes, or attendance changes.
begin;

-- Private identity helper: wrappers run as their owner, but auth.uid() still
-- reads the caller's verified JWT claims. Never accept an account UUID from callers.
create or replace function public.office_market_session_user()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  account_id uuid := auth.uid();
begin
  if account_id is null or not exists (
    select 1 from public.profiles p
    where p.id = account_id and p.role in ('employee', 'super_admin')
  ) then
    raise exception 'Office account access required' using errcode = '42501';
  end if;
  return account_id;
end;
$$;

create or replace function public.office_market_my_state()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return public.office_market_state(public.office_market_session_user());
end;
$$;

create or replace function public.office_market_my_purchase(
  p_item_id text,
  p_expected_price integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return public.office_market_purchase(
    public.office_market_session_user(), p_item_id, p_expected_price
  );
end;
$$;

create or replace function public.office_market_my_equip(p_slot text, p_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  return public.office_market_equip(
    public.office_market_session_user(), p_slot, p_item_id
  );
end;
$$;

-- Share appearance IDs only. No wallet initialization or private state reads.
create or replace function public.office_market_appearances()
returns table (user_id uuid, outfit text, armor text, pet text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform public.office_market_session_user();
  return query
    select p.id, e.outfit, e.armor, e.pet
    from public.profiles p
    left join public.office_market_equipment e on e.user_id = p.id
    where p.role in ('employee', 'super_admin');
end;
$$;

-- Explicitly remove PUBLIC/default grants before allowing authenticated callers.
revoke all on function public.office_market_session_user() from public, anon, authenticated;
revoke all on function public.office_market_my_state() from public, anon, authenticated;
revoke all on function public.office_market_my_purchase(text, integer) from public, anon, authenticated;
revoke all on function public.office_market_my_equip(text, text) from public, anon, authenticated;
revoke all on function public.office_market_appearances() from public, anon, authenticated;

grant execute on function public.office_market_my_state() to authenticated;
grant execute on function public.office_market_my_purchase(text, integer) to authenticated;
grant execute on function public.office_market_my_equip(text, text) to authenticated;
grant execute on function public.office_market_appearances() to authenticated;

-- Existing UUID-taking transaction functions remain private/service-only.
-- No anonymous function access or direct table writes are added.
notify pgrst, 'reload schema';
commit;
