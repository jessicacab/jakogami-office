-- Synthetic data only; executed in a disposable local PostgreSQL cluster (server/duelDatabase.test.js).
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
  ('33333333-3333-3333-3333-333333333333');
insert into public.profiles values
  ('11111111-1111-1111-1111-111111111111', 'employee'),
  ('22222222-2222-2222-2222-222222222222', 'super_admin'),
  ('33333333-3333-3333-3333-333333333333', 'client');
grant usage on schema public to anon, authenticated, service_role;

\ir ../migrations/202611180001_duel.sql
-- rerunnable
\ir ../migrations/202611180001_duel.sql

-- the server writes results
set role service_role;
insert into public.office_duel_matches (challenger, opponent, winner, result, started_at) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'ko', now()),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'time', now()),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', null, 'draw', now()),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'forfeit', now());
do $$
begin
  begin
    insert into public.office_duel_matches (challenger, opponent, winner, result, started_at) values
      ('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', null, 'draw', now());
    raise exception 'self duel accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.office_duel_matches (challenger, opponent, winner, result, started_at) values
      ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'ko', now());
    raise exception 'outside winner accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.office_duel_matches (challenger, opponent, winner, result, started_at) values
      ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', null, 'ko', now());
    raise exception 'knockout without a winner accepted';
  exception when check_violation then null;
  end;
end;
$$;
reset role;

-- staff read totals; the table itself stays closed
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare
  r record;
begin
  select * into r from public.office_duel_records(array['11111111-1111-1111-1111-111111111111'::uuid]);
  assert (r.wins, r.losses, r.draws) = (2::bigint, 1::bigint, 1::bigint), 'wrong record for 1111';
  select * into r from public.office_duel_records(array['22222222-2222-2222-2222-222222222222'::uuid, '22222222-2222-2222-2222-222222222222'::uuid]);
  assert (r.wins, r.losses, r.draws) = (1::bigint, 2::bigint, 1::bigint), 'wrong record for 2222';
  assert (select count(*) from public.office_duel_records(array['22222222-2222-2222-2222-222222222222'::uuid, '22222222-2222-2222-2222-222222222222'::uuid])) = 1, 'duplicates not merged';
  select * into r from public.office_duel_records(array['33333333-3333-3333-3333-333333333333'::uuid]);
  assert (r.wins, r.losses, r.draws) = (0::bigint, 0::bigint, 0::bigint), 'no duels should be zeros';
  begin
    perform count(*) from public.office_duel_matches;
    raise exception 'table readable by authenticated';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.office_duel_matches (challenger, opponent, winner, result, started_at) values
      ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'ko', now());
    raise exception 'browser insert accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.office_duel_records(array_fill('11111111-1111-1111-1111-111111111111'::uuid, array[101]));
    raise exception 'oversized request accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
-- someone without office access
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$
begin
  perform public.office_duel_records(array['11111111-1111-1111-1111-111111111111'::uuid]);
  raise exception 'non-office caller accepted';
exception when insufficient_privilege then null;
end;
$$;
reset role;
set role anon;
do $$
begin
  perform public.office_duel_records(array['11111111-1111-1111-1111-111111111111'::uuid]);
  raise exception 'anonymous caller accepted';
exception when insufficient_privilege then null;
end;
$$;
reset role;
