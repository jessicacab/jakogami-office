-- Character looks: each person's own saved character (hair, skin tone, body, face, clothes, accessories).
-- Run in the SAME Supabase project. Additive and rerunnable; it changes no existing data.
-- Only the Jakogami server (secret key) reads and writes it: a person can save only their own look (the server takes
-- the account from the verified session) and every look is checked against the character options before it is saved.
begin;

create table if not exists public.office_character_looks (
  user_id uuid primary key references auth.users (id) on delete cascade,
  spec jsonb not null,
  updated_at timestamptz not null default now(),
  constraint office_character_looks_small check (octet_length(spec::text) <= 8192)
);

alter table public.office_character_looks enable row level security;
revoke all on table public.office_character_looks from public, anon, authenticated;
grant select, insert, update on table public.office_character_looks to service_role;

notify pgrst, 'reload schema';
commit;
