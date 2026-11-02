-- Apply after pwa-demo-accounts.sql. Safe to run again.
-- Google Calendar tokens are reachable only by the google-calendar Edge Function
-- (service role). The browser never receives a Google token.
begin;
create table if not exists public.first_things_calendar_connections (
  identity_id uuid primary key,
  email text not null,
  refresh_token text not null,           -- AES-GCM encrypted by the Edge Function
  scopes text[] not null,
  key_hashes text[] not null,            -- SHA-256 of each connected device's key
  connected_at timestamptz not null default now()
);
-- One-time sign-in attempts. Each row lives ten minutes at most.
create table if not exists public.first_things_calendar_oauth_states (
  state text primary key,
  identity_id uuid not null,
  key_hash text not null,
  return_to text not null,
  expires_at timestamptz not null
);
alter table public.first_things_calendar_connections enable row level security;
alter table public.first_things_calendar_oauth_states enable row level security;
revoke all on public.first_things_calendar_connections from anon, authenticated;
revoke all on public.first_things_calendar_oauth_states from anon, authenticated;
grant select, insert, update, delete on public.first_things_calendar_connections to service_role;
grant select, insert, update, delete on public.first_things_calendar_oauth_states to service_role;
grant select on public.first_things_demo_accounts to service_role;
commit;
