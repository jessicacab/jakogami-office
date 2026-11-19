-- Duel results (docs/DUEL-SPEC.md). Run in the SAME Supabase project as the dashboard, after the Marketplace
-- migrations. Additive and rerunnable: it never removes or changes existing data.
-- Only the Office Floor server (secret key) writes results. Signed-in office staff read win/loss/draw totals through
-- office_duel_records; nobody reads or writes the table directly from a browser.
begin;

create table if not exists public.office_duel_matches (
  id uuid primary key default gen_random_uuid(),
  challenger uuid not null references auth.users (id) on delete cascade,
  opponent uuid not null references auth.users (id) on delete cascade,
  winner uuid references auth.users (id) on delete cascade,
  result text not null check (result in ('ko', 'time', 'forfeit', 'draw')),
  challenger_attributes jsonb not null default '{}'::jsonb,
  opponent_attributes jsonb not null default '{}'::jsonb,
  started_at timestamptz not null,
  ended_at timestamptz not null default now(),
  constraint office_duel_matches_two_people check (challenger <> opponent),
  constraint office_duel_matches_winner_fought check (winner is null or winner = challenger or winner = opponent),
  constraint office_duel_matches_draw_no_winner check ((result = 'draw') = (winner is null))
);

create index if not exists office_duel_matches_challenger_idx on public.office_duel_matches (challenger);
create index if not exists office_duel_matches_opponent_idx on public.office_duel_matches (opponent);

alter table public.office_duel_matches enable row level security;
revoke all on table public.office_duel_matches from public, anon, authenticated;
grant select, insert on table public.office_duel_matches to service_role;

-- Totals for up to 100 people. The caller must be signed-in office staff (employee or super_admin).
create or replace function public.office_duel_records(p_user_ids uuid[])
returns table (user_id uuid, wins bigint, losses bigint, draws bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or not exists (
    select 1 from public.profiles p
    where p.id = caller and p.role in ('employee', 'super_admin')
  ) then
    raise exception 'Office account access required' using errcode = '42501';
  end if;
  if coalesce(array_length(p_user_ids, 1), 0) > 100 then
    raise exception 'At most 100 users' using errcode = '22023';
  end if;
  return query
    select u.id,
      count(m.id) filter (where m.winner = u.id),
      count(m.id) filter (where m.winner is not null and m.winner <> u.id),
      count(m.id) filter (where m.result = 'draw')
    from (select distinct x as id from unnest(coalesce(p_user_ids, '{}'::uuid[])) as x) u
    left join public.office_duel_matches m on m.challenger = u.id or m.opponent = u.id
    group by u.id;
end;
$$;

revoke all on function public.office_duel_records(uuid[]) from public, anon, authenticated;
grant execute on function public.office_duel_records(uuid[]) to authenticated;

notify pgrst, 'reload schema';
commit;
