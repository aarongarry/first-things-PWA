-- Apply after pwa-demo-accounts.sql. Safe to run again.
-- Daily counters for AI photo checks. Phone accounts are unverified, so these
-- caps are what keep the Anthropic bill bounded. Only the verify-photo Edge
-- Function (service role) can read or change them.
begin;
create table if not exists public.first_things_photo_checks (
  identity_id uuid not null,
  day date not null,                     -- UTC day
  checks integer not null default 0,
  primary key (identity_id, day)
);
alter table public.first_things_photo_checks enable row level security;
revoke all on public.first_things_photo_checks from anon, authenticated;
grant select, insert, update, delete on public.first_things_photo_checks to service_role;
grant select on public.first_things_demo_accounts to service_role;

-- Counts one check if the account and the whole app are under today's caps.
-- Returns 'ok', 'account' (this account hit its cap) or 'app' (everyone did).
create or replace function public.first_things_take_photo_check(who uuid, per_account integer, per_app integer)
returns text language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'utc')::date; mine integer; everyone integer;
begin
  -- One check at a time, so two requests can't both take the last slot.
  perform pg_advisory_xact_lock(hashtext('first_things_photo_checks'));
  delete from public.first_things_photo_checks where day < today - 7;
  select coalesce(sum(checks), 0) into everyone from public.first_things_photo_checks where day = today;
  if everyone >= per_app then return 'app'; end if;
  select checks into mine from public.first_things_photo_checks where identity_id = who and day = today;
  if coalesce(mine, 0) >= per_account then return 'account'; end if;
  insert into public.first_things_photo_checks (identity_id, day, checks) values (who, today, 1)
    on conflict (identity_id, day) do update set checks = public.first_things_photo_checks.checks + 1;
  return 'ok';
end $$;
revoke all on function public.first_things_take_photo_check(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.first_things_take_photo_check(uuid, integer, integer) to service_role;
commit;
