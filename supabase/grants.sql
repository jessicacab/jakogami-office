-- Let the app's server (Supabase's service_role, used through the secret key) reach the tables it needs.
-- Grants only what the app uses: read staff and attendance data.
-- Nothing is granted to anon or authenticated browsers.
grant usage on schema public to service_role;
grant select on public.profiles to service_role;
-- live presence: today's calendar status (read only)
grant select on public.calendar_entries to service_role;
