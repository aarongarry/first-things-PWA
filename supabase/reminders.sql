-- Run after pwa-demo-accounts.sql, in the project's SQL Editor. Safe to run again.
-- Stores each phone's push subscription + the time the person wants their daily reminder.
-- The browser may only save/remove ITS OWN subscription. Only the service role can read them.
begin;
create table if not exists public.first_things_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  remind_time time not null default '18:00',
  timezone_name text not null,
  last_sent_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists first_things_push_identity_idx on public.first_things_push_subscriptions(identity_id);
alter table public.first_things_push_subscriptions enable row level security;
revoke all on public.first_things_push_subscriptions from anon, authenticated;

create or replace function public.first_things_reminder_save(account_phone text, subscription jsonb, remind_at text, zone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account_id uuid; ep text; p256 text; au text;
begin
  select identity_id into account_id from public.first_things_demo_accounts
    where phone = account_phone and not retired;
  if account_id is null then raise exception 'Open First Things and sync your account first'; end if;
  ep := subscription->>'endpoint'; p256 := subscription->'keys'->>'p256dh'; au := subscription->'keys'->>'auth';
  if ep is null or ep !~ '^https://' or length(ep) > 2000 or p256 is null or au is null then
    raise exception 'Invalid subscription';
  end if;
  if remind_at is null or remind_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid time'; end if;
  if zone is null or not exists(select 1 from pg_timezone_names where name = zone) then raise exception 'Invalid time zone'; end if;
  if (select count(*) from public.first_things_push_subscriptions s
        where s.identity_id = account_id and s.endpoint <> ep) >= 5 then
    raise exception 'Too many devices for this account';
  end if;
  insert into public.first_things_push_subscriptions(identity_id, endpoint, p256dh, auth, remind_time, timezone_name)
    values(account_id, ep, p256, au, remind_at::time, zone)
  on conflict (endpoint) do update set
    identity_id = excluded.identity_id, p256dh = excluded.p256dh, auth = excluded.auth,
    remind_time = excluded.remind_time, timezone_name = excluded.timezone_name, updated_at = now(),
    last_sent_on = case when public.first_things_push_subscriptions.remind_time is distinct from excluded.remind_time
                        then null else public.first_things_push_subscriptions.last_sent_on end;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.first_things_reminder_remove(account_phone text, endpoint_url text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account_id uuid;
begin
  select identity_id into account_id from public.first_things_demo_accounts where phone = account_phone;
  delete from public.first_things_push_subscriptions where identity_id = account_id and endpoint = endpoint_url;
  return jsonb_build_object('ok', true);
end $$;

-- Used by the send-reminders Edge Function (service role only): who is due right now?
-- Due = it is past their reminder time (within 3 hours), nothing sent yet today, tasks still unfinished.
-- Also returns the user's first name for the notification. Changing the returned columns
-- means the old version has to be dropped first.
drop function if exists public.first_things_due_reminders();
create function public.first_things_due_reminders()
returns table(id uuid, endpoint text, p256dh text, auth text, remaining integer, name text)
language sql security definer set search_path = '' as $$
  select s.id, s.endpoint, s.p256dh, s.auth, r.remaining,
    coalesce(nullif(btrim(a.state->'profile'->>'name'), ''), 'Friend') as name
  from public.first_things_push_subscriptions s
  join public.first_things_demo_accounts a on a.identity_id = s.identity_id and not a.retired
  cross join lateral (
    select count(*)::int as remaining
    from jsonb_array_elements(a.state->'tasks') t
    where coalesce((t->>'done')::boolean, false) = false
  ) r
  where r.remaining > 0
    and ((now() at time zone s.timezone_name)::time - s.remind_time) between interval '0' and interval '3 hours'
    and (now() at time zone s.timezone_name)::date is distinct from s.last_sent_on;
$$;

create or replace function public.first_things_reminders_sent(ids uuid[])
returns void language sql security definer set search_path = '' as $$
  update public.first_things_push_subscriptions s
    set last_sent_on = (now() at time zone s.timezone_name)::date where s.id = any(ids);
$$;

create or replace function public.first_things_reminders_drop(ids uuid[])
returns void language sql security definer set search_path = '' as $$
  delete from public.first_things_push_subscriptions where id = any(ids);
$$;

revoke all on function public.first_things_reminder_save(text, jsonb, text, text) from public;
revoke all on function public.first_things_reminder_remove(text, text) from public;
grant execute on function public.first_things_reminder_save(text, jsonb, text, text) to anon, authenticated;
grant execute on function public.first_things_reminder_remove(text, text) to anon, authenticated;
revoke all on function public.first_things_due_reminders() from public, anon, authenticated;
revoke all on function public.first_things_reminders_sent(uuid[]) from public, anon, authenticated;
revoke all on function public.first_things_reminders_drop(uuid[]) from public, anon, authenticated;
grant execute on function public.first_things_due_reminders() to service_role;
grant execute on function public.first_things_reminders_sent(uuid[]) to service_role;
grant execute on function public.first_things_reminders_drop(uuid[]) to service_role;
commit;
