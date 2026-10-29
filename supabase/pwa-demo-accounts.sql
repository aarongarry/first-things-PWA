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
alter table public.first_things_demo_accounts add column if not exists identity_id uuid not null default gen_random_uuid();
alter table public.first_things_demo_accounts add column if not exists retired boolean not null default false;
alter table public.first_things_demo_accounts add column if not exists move_request uuid;
alter table public.first_things_demo_accounts add column if not exists moved_phone text;
alter table public.first_things_demo_accounts enable row level security;
revoke all on public.first_things_demo_accounts from anon, authenticated;

create or replace function public.first_things_demo_load(account_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if account_phone !~ '^\+[0-9]{11,15}$' or account_phone is null then
    raise exception 'Invalid phone number';
  end if;
  select case when retired then jsonb_build_object('retired', true)
    else jsonb_build_object('version', version, 'state', state) end into result
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
  if exists(select 1 from public.first_things_demo_accounts where phone = account_phone and retired) then
    return jsonb_build_object('retired', true);
  end if;
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

-- Move a demo identity atomically, without overwriting another account. Retain
-- the old row as a tombstone so a stale/offline device cannot recreate it.
create or replace function public.first_things_demo_rename(
  account_phone text, new_phone text, new_name text, expected_version integer, request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare source public.first_things_demo_accounts%rowtype; destination public.first_things_demo_accounts%rowtype; next_state jsonb;
begin
  if account_phone is null or new_phone is null or account_phone = new_phone or
     account_phone !~ '^\+[0-9]{11,15}$' or new_phone !~ '^\+[0-9]{11,15}$' or
     new_name is null or length(trim(new_name)) not between 1 and 40 or request_id is null then
    raise exception 'Invalid profile';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(least(account_phone, new_phone), 0));
  perform pg_advisory_xact_lock(hashtextextended(greatest(account_phone, new_phone), 0));
  select * into source from public.first_things_demo_accounts where phone = account_phone;
  if not found then return jsonb_build_object('conflict', true); end if;
  if source.retired then
    -- Retrying a request after a lost response returns the committed result.
    if source.move_request = request_id and source.moved_phone = new_phone then
      select * into destination from public.first_things_demo_accounts where phone = new_phone;
      if found and not destination.retired then
        return jsonb_build_object('version', destination.version, 'state', destination.state);
      end if;
    end if;
    return jsonb_build_object('retired', true);
  end if;
  select * into destination from public.first_things_demo_accounts where phone = new_phone;
  if found and (not destination.retired or destination.identity_id <> source.identity_id) then
    return jsonb_build_object('taken', true);
  end if;
  if source.version is distinct from expected_version then return jsonb_build_object('conflict', true); end if;
  next_state := jsonb_set(source.state, '{profile}', jsonb_build_object('phone', new_phone, 'name', trim(new_name)));
  insert into public.first_things_demo_accounts(phone, state, version, identity_id)
    values(new_phone, next_state, source.version + 1, source.identity_id)
    on conflict(phone) do update set state = excluded.state, version = excluded.version,
      retired = false, move_request = null, moved_phone = null, updated_at = now();
  update public.first_things_demo_accounts set retired = true, move_request = request_id,
    moved_phone = new_phone, version = version + 1, updated_at = now() where phone = account_phone;
  return jsonb_build_object('version', source.version + 1, 'state', next_state);
end $$;
revoke all on function public.first_things_demo_rename(text, text, text, integer, uuid) from public;
grant execute on function public.first_things_demo_rename(text, text, text, integer, uuid) to anon, authenticated;
commit;
