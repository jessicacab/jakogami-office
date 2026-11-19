-- Office Jira coin rewards: policy, connections, durable jobs, signed worker RPCs.
-- Additive / rerunnable. Does not alter login, attendance, or marketplace purchase semantics.
-- No secrets are embedded as SQL literals. Worker signing secret lives in Vault.
-- Does not create or alter global roles (anon/authenticated/service_role already exist on Supabase).

begin;

create schema if not exists public;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Ledger kind: preserve welcome/purchase; add jira_reward
-- ---------------------------------------------------------------------------

do $$
declare
  con_name text;
begin
  select c.conname into con_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'office_market_transactions'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%kind%';

  if con_name is not null then
    execute format('alter table public.office_market_transactions drop constraint %I', con_name);
  end if;

  alter table public.office_market_transactions
    add constraint office_market_transactions_kind_check
    check (kind in ('welcome', 'purchase', 'jira_reward'));
exception
  when duplicate_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- Policy (single-row, admin-edited via direct SQL; clients select only)
-- ---------------------------------------------------------------------------

create table if not exists public.office_jira_policy (
  id integer primary key check (id = 1),
  version integer not null default 1 check (version >= 1),
  config jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.office_jira_policy (id, version, config, updated_at)
values (
  1,
  1,
  jsonb_build_object(
    'enabled', false,
    'baseCoins', jsonb_build_object(
      'trivial', 100,
      'small', 200,
      'moderate', 350,
      'complex', 500,
      'very_complex', 750
    ),
    'priorityMultipliers', '{}'::jsonb,
    'withinEstimateMultiplier', 1.1,
    'perIssueCap', 1200,
    'dailyCap', 2000,
    'doneStatusIds', '[]'::jsonb,
    'excludedResolutionIds', '[]'::jsonb,
    'allowedResolutionIds', '[]'::jsonb,
    'projectKeys', '[]'::jsonb,
    'recheckSeconds', 300
  ),
  now()
)
on conflict (id) do nothing;

create or replace function public.office_jira_policy_validate(p_config jsonb)
returns void
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k text;
  v numeric;
  base jsonb;
  mult jsonb;
  arr jsonb;
  n integer;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'jira_policy_invalid' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_config->'enabled') <> 'boolean' then
    raise exception 'jira_policy_invalid' using errcode = 'P0001';
  end if;

  base := p_config->'baseCoins';
  if base is null or jsonb_typeof(base) <> 'object' then
    raise exception 'jira_policy_invalid' using errcode = 'P0001';
  end if;

  foreach k in array array['trivial', 'small', 'moderate', 'complex', 'very_complex']
  loop
    if jsonb_typeof(base->k) <> 'number' then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
    v := (base->>k)::numeric;
    if v <> trunc(v) or v < 0 or v > 100000 then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
  end loop;

  mult := p_config->'priorityMultipliers';
  if mult is null or jsonb_typeof(mult) <> 'object' then
    raise exception 'jira_policy_invalid' using errcode = 'P0001';
  end if;
  for k, v in
    select key, value::text::numeric
    from jsonb_each(mult)
  loop
    if jsonb_typeof(mult->k) <> 'number' then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
    if v < 0 or v > 10 then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
  end loop;

  if jsonb_typeof(p_config->'withinEstimateMultiplier') <> 'number' then
    raise exception 'jira_policy_invalid' using errcode = 'P0001';
  end if;
  v := (p_config->>'withinEstimateMultiplier')::numeric;
  if v < 0 or v > 10 then
    raise exception 'jira_policy_invalid' using errcode = 'P0001';
  end if;

  foreach k in array array['perIssueCap', 'dailyCap', 'recheckSeconds']
  loop
    if jsonb_typeof(p_config->k) <> 'number' then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
    v := (p_config->>k)::numeric;
    if v <> trunc(v) or v < 0 or v > 1000000 then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
  end loop;

  foreach k in array array[
    'doneStatusIds', 'excludedResolutionIds', 'allowedResolutionIds', 'projectKeys'
  ]
  loop
    arr := p_config->k;
    if arr is null or jsonb_typeof(arr) <> 'array' then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
    n := jsonb_array_length(arr);
    -- element type checks (strings only)
    if exists (
      select 1
      from jsonb_array_elements(arr) e
      where jsonb_typeof(e) <> 'string'
    ) then
      raise exception 'jira_policy_invalid' using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

create or replace function public.office_jira_policy_before_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.id is distinct from 1 then
    raise exception 'jira_policy_invalid' using errcode = 'P0001';
  end if;

  perform public.office_jira_policy_validate(new.config);

  if tg_op = 'UPDATE' then
    if new.version < old.version then
      raise exception 'jira_policy_version_regress' using errcode = 'P0001';
    end if;
    -- Auto-increment version only when config actually changes and caller did not bump.
    if new.config is distinct from old.config then
      if new.version is not distinct from old.version then
        new.version := old.version + 1;
      end if;
    else
      -- No config edit: keep version stable unless explicitly increased (forbidden without change)
      if new.version is distinct from old.version and new.config is not distinct from old.config then
        -- Allow no-op updates of updated_at only; reject bare version bumps without config change
        if new.version <> old.version then
          raise exception 'jira_policy_version_without_edit' using errcode = 'P0001';
        end if;
      end if;
    end if;
    new.updated_at := now();
  else
    if new.version is null or new.version < 1 then
      new.version := 1;
    end if;
    new.updated_at := coalesce(new.updated_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists office_jira_policy_before_write on public.office_jira_policy;
create trigger office_jira_policy_before_write
  before insert or update on public.office_jira_policy
  for each row execute function public.office_jira_policy_before_write();

-- ---------------------------------------------------------------------------
-- Connections (encrypted tokens only; DB-owned timestamps/version fence)
-- ---------------------------------------------------------------------------

create table if not exists public.office_jira_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  cloud_id text not null,
  account_id text not null,
  encrypted_tokens text not null,
  connection_version bigint not null default 1 check (connection_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint office_jira_connections_cloud_account_unique unique (cloud_id, account_id)
);

create index if not exists office_jira_connections_account_idx
  on public.office_jira_connections (account_id);

-- ---------------------------------------------------------------------------
-- Durable jobs
-- ---------------------------------------------------------------------------

create table if not exists public.office_jira_jobs (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  issue_key text not null,
  state text not null,
  analysis jsonb,
  reason text,
  connection_version bigint,
  lease_token text,
  lease_expires_at timestamptz,
  next_check_at timestamptz not null default now(),
  awarded_amount integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint office_jira_jobs_state_check check (
    state in (
      'queued', 'processing', 'waiting', 'needs_review',
      'failed', 'awarded', 'cancelled'
    )
  ),
  constraint office_jira_jobs_issue_key_check check (
    issue_key ~ '^[A-Z][A-Z0-9]+-[1-9][0-9]*$'
  )
);

create index if not exists office_jira_jobs_user_idx
  on public.office_jira_jobs (user_id, created_at desc);

create index if not exists office_jira_jobs_claim_idx
  on public.office_jira_jobs (state, next_check_at, lease_expires_at)
  where state in ('queued', 'waiting', 'processing');

-- ---------------------------------------------------------------------------
-- Immutable global reward uniqueness (cloud site + Jira issue id)
-- ---------------------------------------------------------------------------

create table if not exists public.office_jira_rewards (
  id bigserial primary key,
  cloud_id text not null,
  issue_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id bigint references public.office_jira_jobs (id) on delete set null,
  amount integer not null check (amount >= 0),
  policy_version integer not null,
  policy_snapshot jsonb not null,
  analysis jsonb,
  explanation text,
  created_at timestamptz not null default now(),
  constraint office_jira_rewards_cloud_issue_unique unique (cloud_id, issue_id)
);

create index if not exists office_jira_rewards_user_day_idx
  on public.office_jira_rewards (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Vault helpers (Supabase Vault when present; local harness may stub)
-- Secret name is fixed; value never appears as a migration literal.
-- ---------------------------------------------------------------------------

create or replace function public.office_jira_vault_secret_name()
returns text
language sql
immutable
as $$ select 'office_jira_worker_hmac'::text $$;

create or replace function public.office_jira_store_worker_secret(p_secret text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, vault, extensions, pg_temp
as $$
declare
  secret_name text := public.office_jira_vault_secret_name();
  existing_id uuid;
begin
  if p_secret is null or length(p_secret) < 32 then
    raise exception 'jira_bootstrap_invalid_secret' using errcode = 'P0001';
  end if;

  -- Prefer Supabase vault.create_secret / update when available.
  if to_regprocedure('vault.create_secret(text, text, text)') is not null then
    select s.id into existing_id
    from vault.secrets s
    where s.name = secret_name
    limit 1;

    if existing_id is null then
      perform vault.create_secret(p_secret, secret_name, 'Office Jira worker HMAC secret');
    elsif to_regprocedure('vault.update_secret(uuid, text, text, text)') is not null then
      perform vault.update_secret(existing_id, p_secret, secret_name, 'Office Jira worker HMAC secret');
    else
      update vault.secrets
      set secret = p_secret
      where id = existing_id;
    end if;
    return;
  end if;

  -- Fallback table used by local tests / environments without vault extension.
  create table if not exists public.office_jira_vault_fallback (
    name text primary key,
    secret text not null,
    updated_at timestamptz not null default now()
  );

  insert into public.office_jira_vault_fallback (name, secret, updated_at)
  values (secret_name, p_secret, now())
  on conflict (name) do update
    set secret = excluded.secret,
        updated_at = now();
end;
$$;

create or replace function public.office_jira_read_worker_secret()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, vault, extensions, pg_temp
as $$
declare
  secret_name text := public.office_jira_vault_secret_name();
  s text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    select ds.decrypted_secret into s
    from vault.decrypted_secrets ds
    where ds.name = secret_name
    limit 1;
    if s is not null then
      return s;
    end if;
  end if;

  if to_regclass('public.office_jira_vault_fallback') is not null then
    select f.secret into s
    from public.office_jira_vault_fallback f
    where f.name = secret_name
    limit 1;
  end if;

  return s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.office_jira_raise(p_code text)
returns void
language plpgsql
as $$
begin
  raise exception '%', p_code using errcode = 'P0001';
end;
$$;

create or replace function public.office_jira_session_user()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
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

create or replace function public.office_jira_hmac_hex(p_payload text, p_secret text)
returns text
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select encode(extensions.hmac(convert_to(p_payload, 'UTF8'), convert_to(p_secret, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function public.office_jira_verify_signature(p_payload text, p_signature text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  secret text;
  expected text;
  payload jsonb;
  exp_at bigint;
  now_epoch bigint := floor(extract(epoch from now()))::bigint;
  action text;
begin
  if p_payload is null or p_signature is null then
    perform public.office_jira_raise('jira_sig_invalid');
  end if;

  if p_signature !~ '^[0-9a-f]{64}$' then
    perform public.office_jira_raise('jira_sig_invalid');
  end if;

  secret := public.office_jira_read_worker_secret();
  if secret is null then
    perform public.office_jira_raise('jira_not_bootstrapped');
  end if;

  expected := public.office_jira_hmac_hex(p_payload, secret);
  if expected is distinct from lower(p_signature) then
    perform public.office_jira_raise('jira_sig_invalid');
  end if;

  begin
    payload := p_payload::jsonb;
  exception
    when others then
      perform public.office_jira_raise('jira_payload_invalid');
  end;

  if jsonb_typeof(payload) <> 'object' then
    perform public.office_jira_raise('jira_payload_invalid');
  end if;

  action := payload->>'action';
  if action is null or length(action) = 0 then
    perform public.office_jira_raise('jira_payload_invalid');
  end if;

  begin
    exp_at := (payload->>'expiresAt')::bigint;
  exception
    when others then
      perform public.office_jira_raise('jira_payload_expired');
  end;

  if exp_at is null then
    perform public.office_jira_raise('jira_payload_expired');
  end if;

  -- Must be in the future and at most 5 minutes ahead.
  if exp_at <= now_epoch or exp_at > now_epoch + 300 then
    perform public.office_jira_raise('jira_payload_expired');
  end if;

  -- Soft size cap on payload.
  if octet_length(p_payload) > 65536 then
    perform public.office_jira_raise('jira_payload_invalid');
  end if;

  return payload;
end;
$$;

create or replace function public.office_jira_project_from_key(p_issue_key text)
returns text
language sql
immutable
as $$
  select split_part(p_issue_key, '-', 1)
$$;

create or replace function public.office_jira_job_public(j public.office_jira_jobs)
returns jsonb
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'id', j.id,
    'issueKey', j.issue_key,
    'state', j.state,
    'analysis', j.analysis,
    'reason', j.reason,
    'awardedAmount', j.awarded_amount,
    'nextCheckAt', j.next_check_at,
    'createdAt', j.created_at,
    'updatedAt', j.updated_at
  )
$$;

create or replace function public.office_jira_policy_public()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v integer;
  c jsonb;
begin
  select p.version, p.config into v, c
  from public.office_jira_policy p
  where p.id = 1;

  if v is null then
    perform public.office_jira_raise('jira_policy_missing');
  end if;

  return jsonb_build_object(
    'version', v,
    'config', c
  );
end;
$$;

create or replace function public.office_jira_manila_day_start(ts timestamptz default now())
returns timestamptz
language sql
stable
as $$
  select ((ts at time zone 'Asia/Manila')::date::timestamp at time zone 'Asia/Manila')
$$;

create or replace function public.office_jira_manila_next_day(ts timestamptz default now())
returns timestamptz
language sql
stable
as $$
  select public.office_jira_manila_day_start(ts) + interval '1 day'
$$;

create or replace function public.office_jira_compute_amount(
  p_config jsonb,
  p_complexity text,
  p_priority_id text,
  p_within_estimate boolean
)
returns integer
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  base numeric;
  pmult numeric;
  tmult numeric;
  cap integer;
  amount numeric;
begin
  if p_config is null or coalesce((p_config->>'enabled')::boolean, false) is not true then
    return null;
  end if;

  -- Fail closed: required allowlists / maps must be non-empty for automatic awards.
  if jsonb_array_length(coalesce(p_config->'allowedResolutionIds', '[]'::jsonb)) < 1
     or jsonb_array_length(coalesce(p_config->'doneStatusIds', '[]'::jsonb)) < 1
     or jsonb_array_length(coalesce(p_config->'projectKeys', '[]'::jsonb)) < 1
     or p_config->'priorityMultipliers' is null
     or p_config->'priorityMultipliers' = '{}'::jsonb
  then
    return null;
  end if;

  if p_complexity is null or p_priority_id is null or p_within_estimate is null then
    return null;
  end if;

  if jsonb_typeof(p_config->'baseCoins'->p_complexity) <> 'number' then
    return null;
  end if;
  base := (p_config->'baseCoins'->>p_complexity)::numeric;

  if jsonb_typeof(p_config->'priorityMultipliers'->p_priority_id) <> 'number' then
    return null;
  end if;
  pmult := (p_config->'priorityMultipliers'->>p_priority_id)::numeric;

  tmult := case
    when p_within_estimate then (p_config->>'withinEstimateMultiplier')::numeric
    else 1.0
  end;

  cap := (p_config->>'perIssueCap')::integer;
  if cap is null or cap < 0 then
    return null;
  end if;
  if cap = 0 then
    return 0;
  end if;

  amount := round(base * pmult * tmult);
  if amount < 0 then
    amount := 0;
  end if;
  if amount > cap then
    amount := cap;
  end if;

  return amount::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authenticated user RPCs
-- ---------------------------------------------------------------------------

create or replace function public.office_jira_status()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  uid uuid;
  conn public.office_jira_connections%rowtype;
  jobs jsonb;
  pol jsonb;
begin
  uid := public.office_jira_session_user();

  select * into conn
  from public.office_jira_connections c
  where c.user_id = uid;

  select coalesce(jsonb_agg(public.office_jira_job_public(j) order by j.created_at desc, j.id desc), '[]'::jsonb)
    into jobs
  from public.office_jira_jobs j
  where j.user_id = uid
    and j.state <> 'cancelled';

  pol := public.office_jira_policy_public();

  return jsonb_build_object(
    'connected', conn.user_id is not null,
    'accountId', conn.account_id,
    'jobs', jobs,
    'policy', pol->'config',
    'policyVersion', (pol->>'version')::integer
  );
end;
$$;

create or replace function public.office_jira_submit(p_issue_key text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  uid uuid;
  key text;
  conn public.office_jira_connections%rowtype;
  job public.office_jira_jobs%rowtype;
begin
  uid := public.office_jira_session_user();

  if p_issue_key is null then
    perform public.office_jira_raise('jira_issue_key_invalid');
  end if;
  key := upper(trim(p_issue_key));
  if key !~ '^[A-Z][A-Z0-9]+-[1-9][0-9]*$' then
    perform public.office_jira_raise('jira_issue_key_invalid');
  end if;

  select * into conn
  from public.office_jira_connections c
  where c.user_id = uid;

  if conn.user_id is null then
    perform public.office_jira_raise('jira_not_connected');
  end if;

  -- Do not open a parallel job that bypasses waiting backoff / review gates.
  if exists (
    select 1 from public.office_jira_jobs j
    where j.user_id = uid
      and j.issue_key = key
      and j.state in ('queued', 'processing', 'waiting', 'needs_review')
  ) then
    perform public.office_jira_raise('jira_job_active');
  end if;

  -- Terminal failed requires explicit resubmit (allowed here). Awarded assessments do not reroll.
  if exists (
    select 1 from public.office_jira_jobs j
    where j.user_id = uid
      and j.issue_key = key
      and j.state = 'awarded'
  ) then
    perform public.office_jira_raise('jira_already_awarded');
  end if;

  -- Another account already earned coins for this ticket: refuse now instead of after analysis.
  if exists (
    select 1 from public.office_jira_jobs j
    where j.issue_key = key
      and j.state = 'awarded'
  ) then
    perform public.office_jira_raise('jira_already_claimed');
  end if;

  insert into public.office_jira_jobs (
    user_id, issue_key, state, connection_version, next_check_at
  ) values (
    uid, key, 'queued', conn.connection_version, now()
  )
  returning * into job;

  return public.office_jira_job_public(job);
end;
$$;

create or replace function public.office_jira_disconnect()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  uid uuid;
  removed boolean := false;
begin
  uid := public.office_jira_session_user();

  delete from public.office_jira_connections c
  where c.user_id = uid
  returning true into removed;

  -- Cancel unpaid / non-terminal reward jobs; awarded stays immutable.
  update public.office_jira_jobs j
  set state = 'cancelled',
      lease_token = null,
      lease_expires_at = null,
      reason = coalesce(j.reason, 'disconnected'),
      updated_at = now(),
      -- bump stored connection fence so in-flight leases cannot finish/award
      connection_version = coalesce(j.connection_version, 0) + 1
  where j.user_id = uid
    and j.state in ('queued', 'processing', 'waiting', 'needs_review', 'failed');

  return jsonb_build_object('ok', true, 'disconnected', coalesce(removed, false));
end;
$$;

create or replace function public.office_jira_bootstrap(p_secret text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  previous text;
begin
  if uid is null or not exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'super_admin'
  ) then
    raise exception 'Office super_admin access required' using errcode = '42501';
  end if;

  -- Rotation note: parent AES key is derived from the same env secret as the HMAC
  -- secret. Rotating invalidates ciphertext; users must reconnect Jira.
  -- Old signed payloads cannot call bootstrap (bootstrap is session super_admin only).
  previous := public.office_jira_read_worker_secret();
  perform public.office_jira_store_worker_secret(p_secret);

  -- Fail loudly if the secret cannot be read back (e.g. Vault decryption unavailable);
  -- otherwise setup "succeeds" and every worker call fails with jira_not_bootstrapped.
  if public.office_jira_read_worker_secret() is distinct from p_secret then
    raise exception 'jira_vault_unreadable' using errcode = 'P0001';
  end if;

  if previous is not null and previous is distinct from p_secret then
    delete from public.office_jira_connections;
    update public.office_jira_jobs j
    set state = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        reason = 'secret_rotated',
        connection_version = coalesce(j.connection_version, 0) + 1,
        updated_at = now()
    where j.state in ('queued', 'processing', 'waiting', 'needs_review', 'failed');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Signed worker RPC (cryptographically protected; helpers remain private)
-- Documented assumption: token refresh is single-worker sequential per process.
-- DB claim uses SKIP LOCKED + per-job lease to avoid multi-worker job races.
-- Token ciphertext updates should still be serialized by the worker process.
-- ---------------------------------------------------------------------------

create or replace function public.office_jira_worker_policy()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  pol jsonb;
begin
  pol := public.office_jira_policy_public();
  return jsonb_build_object(
    'config', pol->'config',
    'version', (pol->>'version')::integer
  );
end;
$$;

create or replace function public.office_jira_worker_connect(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  uid uuid;
  cloud text;
  acct text;
  tokens text;
  existing_owner uuid;
  cur public.office_jira_connections%rowtype;
begin
  begin
    uid := (p->>'userId')::uuid;
  exception when others then
    perform public.office_jira_raise('jira_connect_invalid');
  end;

  cloud := nullif(trim(p->>'cloudId'), '');
  acct := nullif(trim(p->>'accountId'), '');
  tokens := p->>'encryptedTokens';

  if uid is null or cloud is null or acct is null or tokens is null or length(tokens) = 0 then
    perform public.office_jira_raise('jira_connect_invalid');
  end if;

  if not exists (
    select 1 from public.profiles pr
    where pr.id = uid and pr.role in ('employee', 'super_admin')
  ) then
    perform public.office_jira_raise('jira_connect_invalid');
  end if;

  select c.user_id into existing_owner
  from public.office_jira_connections c
  where c.cloud_id = cloud and c.account_id = acct;

  if existing_owner is not null and existing_owner is distinct from uid then
    perform public.office_jira_raise('jira_identity_taken');
  end if;

  select * into cur from public.office_jira_connections c where c.user_id = uid;

  if cur.user_id is null then
    insert into public.office_jira_connections (
      user_id, cloud_id, account_id, encrypted_tokens, connection_version, created_at, updated_at
    ) values (
      uid, cloud, acct, tokens, 1, now(), now()
    );
  else
    update public.office_jira_connections c
    set cloud_id = cloud,
        account_id = acct,
        encrypted_tokens = tokens,
        connection_version = c.connection_version + 1,
        updated_at = now()
    where c.user_id = uid;

    -- Invalidate open leases tied to the previous connection version.
    update public.office_jira_jobs j
    set lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    where j.user_id = uid
      and j.state in ('queued', 'processing', 'waiting')
      and j.connection_version is distinct from (
        select connection_version from public.office_jira_connections where user_id = uid
      );
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.office_jira_worker_connection(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  uid uuid;
  cur public.office_jira_connections%rowtype;
begin
  begin
    uid := (p->>'userId')::uuid;
  exception when others then
    perform public.office_jira_raise('jira_connection_invalid');
  end;

  if uid is null then
    return null;
  end if;

  select * into cur from public.office_jira_connections c where c.user_id = uid;
  if cur.user_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'userId', cur.user_id,
    'cloudId', cur.cloud_id,
    'accountId', cur.account_id,
    'encryptedTokens', cur.encrypted_tokens
  );
end;
$$;

create or replace function public.office_jira_worker_save_tokens(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  uid uuid;
  tokens text;
begin
  begin
    uid := (p->>'userId')::uuid;
  exception when others then
    perform public.office_jira_raise('jira_save_tokens_invalid');
  end;
  tokens := p->>'encryptedTokens';

  if uid is null or tokens is null or length(tokens) = 0 then
    perform public.office_jira_raise('jira_save_tokens_invalid');
  end if;

  update public.office_jira_connections c
  set encrypted_tokens = tokens,
      updated_at = now()
  where c.user_id = uid;

  if not found then
    perform public.office_jira_raise('jira_not_connected');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.office_jira_worker_claim(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  lease_seconds integer := 180;
  job_id bigint;
  tok text;
  j public.office_jira_jobs%rowtype;
  conn public.office_jira_connections%rowtype;
begin
  -- Pick one due job: queued/waiting ready, or processing with expired lease.
  select j0.id into job_id
  from public.office_jira_jobs j0
  join public.office_jira_connections c0 on c0.user_id = j0.user_id
  where (
      (j0.state in ('queued', 'waiting') and j0.next_check_at <= now())
      or (j0.state = 'processing' and j0.lease_expires_at is not null and j0.lease_expires_at < now())
    )
    and j0.connection_version is not distinct from c0.connection_version
  order by j0.next_check_at asc, j0.id asc
  for update of j0 skip locked
  limit 1;

  if job_id is null then
    return null;
  end if;

  tok := encode(extensions.gen_random_bytes(16), 'hex');

  update public.office_jira_jobs jb
  set state = 'processing',
      lease_token = tok,
      lease_expires_at = now() + make_interval(secs => lease_seconds),
      updated_at = now()
  where jb.id = job_id
  returning * into j;

  select * into conn
  from public.office_jira_connections c
  where c.user_id = j.user_id;

  if conn.user_id is null then
    update public.office_jira_jobs
    set state = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        reason = 'disconnected',
        updated_at = now()
    where id = job_id;
    return null;
  end if;

  return jsonb_build_object(
    'id', j.id,
    'userId', j.user_id,
    'issueKey', j.issue_key,
    'cloudId', conn.cloud_id,
    'accountId', conn.account_id,
    'encryptedTokens', conn.encrypted_tokens,
    'analysis', j.analysis,
    'leaseToken', tok
  );
end;
$$;

create or replace function public.office_jira_worker_finish(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  job_id bigint;
  tok text;
  new_state text;
  v_analysis jsonb;
  v_reason text;
  j public.office_jira_jobs%rowtype;
  conn_ver bigint;
  recheck integer;
  pol jsonb;
begin
  begin
    job_id := (p->>'jobId')::bigint;
  exception when others then
    perform public.office_jira_raise('jira_finish_invalid');
  end;
  tok := p->>'leaseToken';
  new_state := p->>'state';
  v_analysis := p->'analysis';
  v_reason := left(coalesce(p->>'reason', ''), 500);

  if job_id is null or tok is null or new_state is null
     or new_state not in ('waiting', 'needs_review', 'failed') then
    perform public.office_jira_raise('jira_finish_invalid');
  end if;

  select * into j
  from public.office_jira_jobs
  where id = job_id
  for update;

  if j.id is null then
    perform public.office_jira_raise('jira_job_not_found');
  end if;

  if j.state = 'cancelled' or j.state = 'awarded' then
    perform public.office_jira_raise('jira_job_fenced');
  end if;

  if j.lease_token is distinct from tok
     or j.lease_expires_at is null
     or j.lease_expires_at < now() then
    perform public.office_jira_raise('jira_lease_invalid');
  end if;

  select c.connection_version into conn_ver
  from public.office_jira_connections c
  where c.user_id = j.user_id;

  if conn_ver is null or conn_ver is distinct from j.connection_version then
    update public.office_jira_jobs
    set state = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        reason = 'disconnected',
        updated_at = now()
    where id = job_id
    returning * into j;
    return public.office_jira_job_public(j);
  end if;

  pol := public.office_jira_policy_public();
  recheck := greatest(30, least(86400, coalesce((pol->'config'->>'recheckSeconds')::integer, 300)));

  update public.office_jira_jobs
  set state = new_state,
      analysis = coalesce(v_analysis, j.analysis),
      reason = nullif(v_reason, ''),
      lease_token = null,
      lease_expires_at = null,
      next_check_at = case
        when new_state = 'waiting' then now() + make_interval(secs => recheck)
        else now()
      end,
      updated_at = now()
  where id = job_id
  returning * into j;

  return public.office_jira_job_public(j);
end;
$$;

create or replace function public.office_jira_worker_award(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict use_variable
declare
  job_id bigint;
  tok text;
  issue_id text;
  cloud_id text;
  analysis jsonb;
  policy_version integer;
  complexity text;
  priority_id text;
  within_estimate boolean;
  eligible boolean;
  completed boolean;
  status_id text;
  resolution_id text;
  j public.office_jira_jobs%rowtype;
  conn public.office_jira_connections%rowtype;
  pol_ver integer;
  pol_cfg jsonb;
  project_key text;
  amount integer;
  daily_cap integer;
  daily_sum integer;
  bal integer;
  prior public.office_jira_rewards%rowtype;
  explanation text;
  snap jsonb;
begin
  begin
    job_id := (p->>'jobId')::bigint;
    policy_version := (p->>'policyVersion')::integer;
    within_estimate := (p->>'withinEstimate')::boolean;
    eligible := (p->>'eligible')::boolean;
    completed := (p->>'completed')::boolean;
  exception when others then
    perform public.office_jira_raise('jira_award_invalid');
  end;

  tok := p->>'leaseToken';
  issue_id := nullif(trim(p->>'issueId'), '');
  cloud_id := nullif(trim(p->>'cloudId'), '');
  analysis := p->'analysis';
  complexity := nullif(trim(p->>'complexity'), '');
  priority_id := nullif(trim(p->>'priorityId'), '');
  status_id := nullif(trim(p->>'statusId'), '');
  resolution_id := nullif(trim(p->>'resolutionId'), '');

  if job_id is null or tok is null or issue_id is null or cloud_id is null
     or policy_version is null or complexity is null or priority_id is null
     or within_estimate is null or eligible is null or completed is null
     or status_id is null or resolution_id is null then
    perform public.office_jira_raise('jira_award_invalid');
  end if;

  -- Attestation must affirm eligibility + completion; SQL still re-validates policy.
  if eligible is not true or completed is not true then
    perform public.office_jira_raise('jira_award_ineligible');
  end if;

  select * into j
  from public.office_jira_jobs
  where id = job_id
  for update;

  if j.id is null then
    perform public.office_jira_raise('jira_job_not_found');
  end if;

  -- Always clear a bad lease path so jobs are not stuck forever.
  if j.state = 'cancelled' then
    perform public.office_jira_raise('jira_job_fenced');
  end if;

  if j.state = 'awarded' then
    select * into prior from public.office_jira_rewards r where r.job_id = j.id limit 1;
    return jsonb_build_object(
      'awarded', true,
      'amount', coalesce(j.awarded_amount, prior.amount, 0),
      'balance', (select balance from public.office_market_wallets w where w.user_id = j.user_id),
      'duplicate', true
    );
  end if;

  if j.lease_token is distinct from tok
     or j.lease_expires_at is null
     or j.lease_expires_at < now() then
    update public.office_jira_jobs
    set lease_token = null,
        lease_expires_at = null,
        state = case when state = 'processing' then 'waiting' else state end,
        next_check_at = least(next_check_at, now()),
        updated_at = now()
    where id = job_id;
    perform public.office_jira_raise('jira_lease_invalid');
  end if;

  select * into conn
  from public.office_jira_connections c
  where c.user_id = j.user_id
  for update;

  if conn.user_id is null
     or conn.connection_version is distinct from j.connection_version
     or conn.cloud_id is distinct from cloud_id then
    update public.office_jira_jobs
    set state = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        reason = 'disconnected',
        updated_at = now()
    where id = job_id;
    perform public.office_jira_raise('jira_job_fenced');
  end if;

  -- Reject disabled / demoted office profiles (fail closed).
  if not exists (
    select 1 from public.profiles pr
    where pr.id = j.user_id and pr.role in ('employee', 'super_admin')
  ) then
    update public.office_jira_jobs
    set state = 'cancelled',
        lease_token = null,
        lease_expires_at = null,
        reason = 'profile_ineligible',
        updated_at = now()
    where id = job_id;
    perform public.office_jira_raise('jira_profile_ineligible');
  end if;

  select p.version, p.config into pol_ver, pol_cfg
  from public.office_jira_policy p
  where p.id = 1
  for share;

  if pol_ver is null then
    update public.office_jira_jobs
    set lease_token = null, lease_expires_at = null,
        state = 'waiting', next_check_at = now() + interval '5 minutes', updated_at = now()
    where id = job_id;
    perform public.office_jira_raise('jira_policy_missing');
  end if;

  -- Stale policy: release lease and retry later (do not award).
  if policy_version is distinct from pol_ver then
    update public.office_jira_jobs
    set lease_token = null,
        lease_expires_at = null,
        state = 'waiting',
        next_check_at = now() + interval '30 seconds',
        reason = 'stale_policy',
        updated_at = now()
    where id = job_id;
    return jsonb_build_object(
      'awarded', false,
      'amount', 0,
      'reason', 'stale_policy',
      'policyVersion', pol_ver
    );
  end if;

  if coalesce((pol_cfg->>'enabled')::boolean, false) is not true then
    update public.office_jira_jobs
    set lease_token = null, lease_expires_at = null,
        state = 'waiting', next_check_at = now() + interval '5 minutes',
        reason = 'policy_disabled', updated_at = now()
    where id = job_id;
    return jsonb_build_object('awarded', false, 'amount', 0, 'reason', 'policy_disabled');
  end if;

  project_key := public.office_jira_project_from_key(j.issue_key);
  if not exists (
    select 1 from jsonb_array_elements_text(coalesce(pol_cfg->'projectKeys', '[]'::jsonb)) pk
    where pk = project_key
  ) then
    update public.office_jira_jobs
    set state = 'needs_review', lease_token = null, lease_expires_at = null,
        reason = 'project_not_allowed', updated_at = now()
    where id = job_id;
    return jsonb_build_object('awarded', false, 'amount', 0, 'reason', 'project_not_allowed');
  end if;

  if not exists (
    select 1 from jsonb_array_elements_text(coalesce(pol_cfg->'doneStatusIds', '[]'::jsonb)) s
    where s = status_id
  ) then
    update public.office_jira_jobs
    set state = 'waiting', lease_token = null, lease_expires_at = null,
        reason = 'status_not_done',
        next_check_at = now() + make_interval(secs => greatest(30, coalesce((pol_cfg->>'recheckSeconds')::integer, 300))),
        updated_at = now()
    where id = job_id;
    return jsonb_build_object('awarded', false, 'amount', 0, 'reason', 'status_not_done');
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(coalesce(pol_cfg->'excludedResolutionIds', '[]'::jsonb)) r
    where r = resolution_id
  ) then
    update public.office_jira_jobs
    set state = 'failed', lease_token = null, lease_expires_at = null,
        reason = 'resolution_excluded', updated_at = now()
    where id = job_id;
    return jsonb_build_object('awarded', false, 'amount', 0, 'reason', 'resolution_excluded');
  end if;

  if not exists (
    select 1 from jsonb_array_elements_text(coalesce(pol_cfg->'allowedResolutionIds', '[]'::jsonb)) r
    where r = resolution_id
  ) then
    update public.office_jira_jobs
    set state = 'needs_review', lease_token = null, lease_expires_at = null,
        reason = 'resolution_not_allowed', updated_at = now()
    where id = job_id;
    return jsonb_build_object('awarded', false, 'amount', 0, 'reason', 'resolution_not_allowed');
  end if;

  amount := public.office_jira_compute_amount(pol_cfg, complexity, priority_id, within_estimate);
  if amount is null then
    update public.office_jira_jobs
    set state = 'needs_review', lease_token = null, lease_expires_at = null,
        reason = 'policy_incomplete', updated_at = now()
    where id = job_id;
    return jsonb_build_object('awarded', false, 'amount', 0, 'reason', 'policy_incomplete');
  end if;

  -- Global dedup: same Jira issue never pays twice across accounts.
  select * into prior
  from public.office_jira_rewards r
  where r.cloud_id = cloud_id and r.issue_id = issue_id;

  if prior.id is not null then
    update public.office_jira_jobs
    set state = case when prior.user_id = j.user_id then 'awarded' else 'failed' end,
        awarded_amount = case when prior.user_id = j.user_id then prior.amount else null end,
        lease_token = null,
        lease_expires_at = null,
        reason = case when prior.user_id = j.user_id then 'already_awarded' else 'already_awarded_other' end,
        analysis = coalesce(analysis, j.analysis),
        updated_at = now()
    where id = job_id;

    if prior.user_id = j.user_id then
      return jsonb_build_object(
        'awarded', true,
        'amount', prior.amount,
        'balance', (select balance from public.office_market_wallets w where w.user_id = j.user_id),
        'duplicate', true
      );
    end if;

    -- Do not leak which other account received the credit.
    return jsonb_build_object(
      'awarded', false,
      'amount', 0,
      'reason', 'already_awarded_other',
      'duplicate', true
    );
  end if;

  daily_cap := coalesce((pol_cfg->>'dailyCap')::integer, 0);
  if daily_cap = 0 and amount > 0 then
    -- Cap of zero means no automatic credits.
    amount := 0;
  end if;

  if amount > 0 and daily_cap > 0 then
    select coalesce(sum(r.amount), 0)::integer into daily_sum
    from public.office_jira_rewards r
    where r.user_id = j.user_id
      and r.created_at >= public.office_jira_manila_day_start(now())
      and r.created_at < public.office_jira_manila_next_day(now());

    if daily_sum + amount > daily_cap then
      update public.office_jira_jobs
      set state = 'waiting',
          lease_token = null,
          lease_expires_at = null,
          reason = 'daily_cap',
          next_check_at = public.office_jira_manila_next_day(now()),
          analysis = coalesce(analysis, j.analysis),
          updated_at = now()
      where id = job_id;
      return jsonb_build_object(
        'awarded', false,
        'amount', 0,
        'reason', 'daily_cap',
        'nextCheckAt', public.office_jira_manila_next_day(now())
      );
    end if;
  end if;

  -- Ensure wallet exists (welcome path unchanged).
  perform public.office_market_ensure_account(j.user_id);

  select balance into bal
  from public.office_market_wallets w
  where w.user_id = j.user_id
  for update;

  if bal is null then
    update public.office_jira_jobs
    set lease_token = null, lease_expires_at = null, state = 'waiting',
        next_check_at = now() + interval '1 minute', updated_at = now()
    where id = job_id;
    perform public.office_jira_raise('setup_required');
  end if;

  snap := jsonb_build_object('version', pol_ver, 'config', pol_cfg);
  explanation := format(
    'complexity=%s priority=%s withinEstimate=%s basePolicyVersion=%s amount=%s',
    complexity, priority_id, within_estimate, pol_ver, amount
  );

  begin
    insert into public.office_jira_rewards (
      cloud_id, issue_id, user_id, job_id, amount,
      policy_version, policy_snapshot, analysis, explanation
    ) values (
      cloud_id, issue_id, j.user_id, j.id, amount,
      pol_ver, snap, analysis, explanation
    );
  exception
    when unique_violation then
      -- Lost race to another account/job.
      select * into prior
      from public.office_jira_rewards r
      where r.cloud_id = cloud_id and r.issue_id = issue_id;

      update public.office_jira_jobs
      set state = case when prior.user_id = j.user_id then 'awarded' else 'failed' end,
          awarded_amount = case when prior.user_id = j.user_id then prior.amount else null end,
          lease_token = null,
          lease_expires_at = null,
          reason = case when prior.user_id = j.user_id then 'already_awarded' else 'already_awarded_other' end,
          updated_at = now()
      where id = job_id;

      if prior.user_id = j.user_id then
        return jsonb_build_object(
          'awarded', true,
          'amount', prior.amount,
          'balance', (select balance from public.office_market_wallets w where w.user_id = j.user_id),
          'duplicate', true
        );
      end if;
      return jsonb_build_object(
        'awarded', false,
        'amount', 0,
        'reason', 'already_awarded_other',
        'duplicate', true
      );
  end;

  if amount > 0 then
    update public.office_market_wallets w
    set balance = balance + amount,
        updated_at = now()
    where w.user_id = j.user_id
    returning balance into bal;

    insert into public.office_market_transactions (user_id, kind, item_id, amount, balance_after)
    values (j.user_id, 'jira_reward', null, amount, bal);
  else
    select balance into bal from public.office_market_wallets w where w.user_id = j.user_id;
  end if;

  update public.office_jira_jobs
  set state = 'awarded',
      awarded_amount = amount,
      analysis = coalesce(analysis, j.analysis),
      lease_token = null,
      lease_expires_at = null,
      reason = null,
      updated_at = now()
  where id = job_id;

  return jsonb_build_object(
    'awarded', true,
    'amount', amount,
    'balance', bal,
    'duplicate', false,
    'policyVersion', pol_ver
  );
exception
  when others then
    -- Ensure lease is not held forever on unexpected failures.
    begin
      update public.office_jira_jobs
      set lease_token = null,
          lease_expires_at = null,
          state = case when state in ('awarded', 'cancelled', 'failed', 'needs_review') then state else 'waiting' end,
          next_check_at = least(coalesce(next_check_at, now()), now() + interval '1 minute'),
          updated_at = now()
      where id = job_id
        and lease_token is not null;
    exception when others then
      null;
    end;
    raise;
end;
$$;

-- Paid AI analysis guard. Each fresh (uncached) analysis must reserve a slot first.
-- Limits are fixed here (not policy-editable) so a bad policy edit cannot remove the spend bound:
--   5 per job lifetime, 25 per account per Manila day, 500 across the site per Manila day.
create table if not exists public.office_jira_ai_reservations (
  id bigserial primary key,
  job_id bigint not null references public.office_jira_jobs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists office_jira_ai_reservations_user_idx
  on public.office_jira_ai_reservations (user_id, created_at);
create index if not exists office_jira_ai_reservations_job_idx
  on public.office_jira_ai_reservations (job_id);
create index if not exists office_jira_ai_reservations_day_idx
  on public.office_jira_ai_reservations (created_at);

create or replace function public.office_jira_worker_reserve_ai(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  job_id bigint;
  tok text;
  j public.office_jira_jobs%rowtype;
  conn_ver bigint;
  day_start timestamptz := public.office_jira_manila_day_start(now());
  day_end timestamptz := public.office_jira_manila_next_day(now());
  per_job integer;
  per_user integer;
  per_site integer;
begin
  begin
    job_id := (p->>'jobId')::bigint;
  exception when others then
    perform public.office_jira_raise('jira_reserve_invalid');
  end;
  tok := p->>'leaseToken';
  if job_id is null or tok is null then
    perform public.office_jira_raise('jira_reserve_invalid');
  end if;

  select * into j from public.office_jira_jobs where id = job_id for update;
  if j.id is null then
    perform public.office_jira_raise('jira_job_not_found');
  end if;
  if j.state in ('cancelled', 'awarded') then
    perform public.office_jira_raise('jira_job_fenced');
  end if;
  if j.state <> 'processing' or j.lease_token is distinct from tok
     or j.lease_expires_at is null or j.lease_expires_at < now() then
    perform public.office_jira_raise('jira_lease_invalid');
  end if;

  select c.connection_version into conn_ver
  from public.office_jira_connections c
  where c.user_id = j.user_id;
  if conn_ver is null or conn_ver is distinct from j.connection_version then
    perform public.office_jira_raise('jira_job_fenced');
  end if;

  -- Serialize the site-wide count so concurrent workers cannot overshoot the cap.
  perform pg_advisory_xact_lock(hashtext('office_jira_ai_reservations'));

  select count(*)::integer into per_job
  from public.office_jira_ai_reservations r where r.job_id = j.id;
  select count(*)::integer into per_user
  from public.office_jira_ai_reservations r
  where r.user_id = j.user_id and r.created_at >= day_start and r.created_at < day_end;
  select count(*)::integer into per_site
  from public.office_jira_ai_reservations r
  where r.created_at >= day_start and r.created_at < day_end;

  if per_job >= 5 then
    return jsonb_build_object('allowed', false, 'reason', 'job_limit');
  end if;
  if per_user >= 25 then
    return jsonb_build_object('allowed', false, 'reason', 'account_daily_limit');
  end if;
  if per_site >= 500 then
    return jsonb_build_object('allowed', false, 'reason', 'site_daily_limit');
  end if;

  insert into public.office_jira_ai_reservations (job_id, user_id) values (j.id, j.user_id);
  return jsonb_build_object('allowed', true);
end;
$$;

-- Pre-AI duplicate check: has this Jira issue (site + issue id) already paid out to anyone?
-- Requires a live lease so only the worker holding the job can probe claims.
create or replace function public.office_jira_worker_issue_claimed(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_job_id bigint;
  v_tok text;
  v_cloud text := nullif(trim(p->>'cloudId'), '');
  v_issue text := nullif(trim(p->>'issueId'), '');
  j public.office_jira_jobs%rowtype;
begin
  begin
    v_job_id := (p->>'jobId')::bigint;
  exception when others then
    perform public.office_jira_raise('jira_claimed_invalid');
  end;
  v_tok := p->>'leaseToken';
  if v_job_id is null or v_tok is null or v_cloud is null or v_issue is null then
    perform public.office_jira_raise('jira_claimed_invalid');
  end if;

  select * into j from public.office_jira_jobs where id = v_job_id;
  if j.id is null then
    perform public.office_jira_raise('jira_job_not_found');
  end if;
  if j.state <> 'processing' or j.lease_token is distinct from v_tok
     or j.lease_expires_at is null or j.lease_expires_at < now() then
    perform public.office_jira_raise('jira_lease_invalid');
  end if;

  return jsonb_build_object('claimed', exists (
    select 1 from public.office_jira_rewards r
    where r.cloud_id = v_cloud and r.issue_id = v_issue
  ));
end;
$$;

create or replace function public.office_jira_worker(p_payload text, p_signature text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  payload jsonb;
  action text;
begin
  payload := public.office_jira_verify_signature(p_payload, p_signature);
  action := payload->>'action';

  case action
    when 'policy' then
      return public.office_jira_worker_policy();
    when 'connect' then
      return public.office_jira_worker_connect(payload);
    when 'connection' then
      return public.office_jira_worker_connection(payload);
    when 'save_tokens' then
      return public.office_jira_worker_save_tokens(payload);
    when 'claim' then
      return public.office_jira_worker_claim(payload);
    when 'issue_claimed' then
      return public.office_jira_worker_issue_claimed(payload);
    when 'reserve_ai' then
      return public.office_jira_worker_reserve_ai(payload);
    when 'finish' then
      return public.office_jira_worker_finish(payload);
    when 'award' then
      return public.office_jira_worker_award(payload);
    else
      perform public.office_jira_raise('jira_action_unknown');
  end case;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------

-- Revoke helpers / internal worker actions from public callers.
revoke all on function public.office_jira_policy_validate(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_policy_before_write() from public, anon, authenticated;
revoke all on function public.office_jira_vault_secret_name() from public, anon, authenticated;
revoke all on function public.office_jira_store_worker_secret(text) from public, anon, authenticated;
revoke all on function public.office_jira_read_worker_secret() from public, anon, authenticated;
revoke all on function public.office_jira_raise(text) from public, anon, authenticated;
revoke all on function public.office_jira_session_user() from public, anon, authenticated;
revoke all on function public.office_jira_hmac_hex(text, text) from public, anon, authenticated;
revoke all on function public.office_jira_verify_signature(text, text) from public, anon, authenticated;
revoke all on function public.office_jira_project_from_key(text) from public, anon, authenticated;
revoke all on function public.office_jira_job_public(public.office_jira_jobs) from public, anon, authenticated;
revoke all on function public.office_jira_policy_public() from public, anon, authenticated;
revoke all on function public.office_jira_manila_day_start(timestamptz) from public, anon, authenticated;
revoke all on function public.office_jira_manila_next_day(timestamptz) from public, anon, authenticated;
revoke all on function public.office_jira_compute_amount(jsonb, text, text, boolean) from public, anon, authenticated;
revoke all on function public.office_jira_worker_policy() from public, anon, authenticated;
revoke all on function public.office_jira_worker_connect(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_worker_connection(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_worker_save_tokens(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_worker_claim(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_worker_finish(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_worker_award(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_worker_reserve_ai(jsonb) from public, anon, authenticated;
revoke all on function public.office_jira_worker_issue_claimed(jsonb) from public, anon, authenticated;

revoke all on function public.office_jira_status() from public, anon, authenticated;
revoke all on function public.office_jira_submit(text) from public, anon, authenticated;
revoke all on function public.office_jira_disconnect() from public, anon, authenticated;
revoke all on function public.office_jira_bootstrap(text) from public, anon, authenticated;
revoke all on function public.office_jira_worker(text, text) from public, anon, authenticated;

grant execute on function public.office_jira_status() to authenticated;
grant execute on function public.office_jira_submit(text) to authenticated;
grant execute on function public.office_jira_disconnect() to authenticated;
grant execute on function public.office_jira_bootstrap(text) to authenticated;
-- Cryptographically protected endpoint only.
grant execute on function public.office_jira_worker(text, text) to anon, authenticated;

grant execute on function public.office_jira_status() to service_role;
grant execute on function public.office_jira_submit(text) to service_role;
grant execute on function public.office_jira_disconnect() to service_role;
grant execute on function public.office_jira_bootstrap(text) to service_role;
grant execute on function public.office_jira_worker(text, text) to service_role;

alter table public.office_jira_policy enable row level security;
alter table public.office_jira_connections enable row level security;
alter table public.office_jira_jobs enable row level security;
alter table public.office_jira_rewards enable row level security;
alter table public.office_jira_ai_reservations enable row level security;
revoke all on table public.office_jira_ai_reservations from public, anon, authenticated;
revoke all on sequence public.office_jira_ai_reservations_id_seq from public, anon, authenticated;
grant select, insert on table public.office_jira_ai_reservations to service_role;
grant usage, select on sequence public.office_jira_ai_reservations_id_seq to service_role;

drop policy if exists office_jira_policy_select_authenticated on public.office_jira_policy;
create policy office_jira_policy_select_authenticated
  on public.office_jira_policy
  for select
  to authenticated
  using (true);

drop policy if exists office_jira_connections_select_own on public.office_jira_connections;
create policy office_jira_connections_select_own
  on public.office_jira_connections
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists office_jira_jobs_select_own on public.office_jira_jobs;
create policy office_jira_jobs_select_own
  on public.office_jira_jobs
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists office_jira_rewards_select_own on public.office_jira_rewards;
create policy office_jira_rewards_select_own
  on public.office_jira_rewards
  for select
  to authenticated
  using (user_id = auth.uid());

revoke all on table public.office_jira_policy from public, anon, authenticated;
revoke all on table public.office_jira_connections from public, anon, authenticated;
revoke all on table public.office_jira_jobs from public, anon, authenticated;
revoke all on table public.office_jira_rewards from public, anon, authenticated;

revoke all on sequence public.office_jira_jobs_id_seq from public, anon, authenticated;
revoke all on sequence public.office_jira_rewards_id_seq from public, anon, authenticated;

-- Authenticated: non-secret policy + own row reads only. No client writes.
grant select on table public.office_jira_policy to authenticated;
grant select on table public.office_jira_connections to authenticated;
grant select on table public.office_jira_jobs to authenticated;
grant select on table public.office_jira_rewards to authenticated;

-- service_role DML for operations / admin; rewards append-oriented.
grant select, insert, update, delete on table public.office_jira_policy to service_role;
grant select, insert, update, delete on table public.office_jira_connections to service_role;
grant select, insert, update, delete on table public.office_jira_jobs to service_role;
revoke all on table public.office_jira_rewards from service_role;
grant select, insert on table public.office_jira_rewards to service_role;
grant usage, select on sequence public.office_jira_jobs_id_seq to service_role;
grant usage, select on sequence public.office_jira_rewards_id_seq to service_role;

-- Fallback vault table (if created at runtime) is never granted to clients.
do $$
begin
  if to_regclass('public.office_jira_vault_fallback') is not null then
    execute 'revoke all on table public.office_jira_vault_fallback from public, anon, authenticated';
    execute 'alter table public.office_jira_vault_fallback enable row level security';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
