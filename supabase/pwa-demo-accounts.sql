-- Run once in the existing project's SQL Editor. Safe to run again.
-- Intentionally UNVERIFIED demo accounts: anyone with a number can load/edit it.
-- This separate table does NOT expose or change the old authenticated ERD data.
begin;
create table if not exists public.first_things_demo_accounts (
  phone text primary key check (phone ~ '^\+[0-9]{11,15}$'),
  state jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.first_things_demo_accounts enable row level security;
revoke all on public.first_things_demo_accounts from anon, authenticated;

create or replace function public.first_things_demo_load(account_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if account_phone !~ '^\+[0-9]{11,15}$' or account_phone is null then
    raise exception 'Invalid phone number';
  end if;
  select jsonb_build_object('version', version, 'state', state) into result
    from public.first_things_demo_accounts where phone = account_phone;
  return coalesce(result, jsonb_build_object('version', 0, 'state', null));
end $$;

create or replace function public.first_things_demo_save(account_phone text, payload jsonb, expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare revision integer;
begin
  if account_phone !~ '^\+[0-9]{11,15}$' or account_phone is null then raise exception 'Invalid phone number'; end if;
  if jsonb_typeof(payload->'tasks') is distinct from 'array' or
     jsonb_typeof(payload->'goals') is distinct from 'array' or
     jsonb_typeof(payload->'daily') is distinct from 'object' or
     payload->'profile'->>'phone' is distinct from account_phone or
     octet_length(payload::text) > 1000000 then
    raise exception 'Invalid account data';
  end if;
  -- Serialize creation and updates, including two first logins for one number.
  perform pg_advisory_xact_lock(hashtextextended(account_phone, 0));
  select version into revision from public.first_things_demo_accounts where phone = account_phone;
  if coalesce(revision, 0) is distinct from expected_version then
    return jsonb_build_object('conflict', true);
  end if;
  revision := coalesce(revision, 0) + 1;
  insert into public.first_things_demo_accounts(phone, state, version)
    values(account_phone, payload, revision)
    on conflict(phone) do update set state = excluded.state, version = excluded.version, updated_at = now();
  return jsonb_build_object('version', revision, 'conflict', false);
end $$;
revoke all on function public.first_things_demo_load(text) from public;
revoke all on function public.first_things_demo_save(text, jsonb, integer) from public;
grant execute on function public.first_things_demo_load(text) to anon, authenticated;
grant execute on function public.first_things_demo_save(text, jsonb, integer) to anon, authenticated;
commit;
