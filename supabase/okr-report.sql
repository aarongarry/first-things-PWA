-- Run once in the project's SQL Editor, AFTER supabase/pwa-demo-accounts.sql. Safe to run again.
-- Adds the data behind the app's Progress tab (our 2 Objectives and 4 Key Results).
--
--   1. A small per-day activity log that fills itself in whenever an account is
--      saved. An account's saved state only holds "today": at midnight finished
--      tasks are removed from it, so without this log there would be no history
--      to measure completion or returning users from.
--   2. first_things_okrs(): returns the 4 Key Results as JSON. It returns totals
--      only (no names, phone numbers, or task text), so the app can call it
--      with the public key, the same way it calls the demo account functions.
--
-- Nothing here changes or deletes existing account data.
begin;

-- One row per person per day. identity_id (not the phone number) is used so a
-- phone number change keeps the same history.
create table if not exists public.first_things_activity_log (
  identity_id uuid not null,
  list_date date not null,
  number_of_tasks integer not null,
  completed_task_num integer not null,
  breaks_earned integer not null,
  breaks_used integer not null,
  updated_at timestamptz not null default now(),
  primary key (identity_id, list_date)
);
alter table public.first_things_activity_log enable row level security;
revoke all on public.first_things_activity_log from anon, authenticated;

-- Turns one saved account state into that day's log row. Everything is wrapped
-- in an exception block on purpose: a malformed state must never be able to
-- block someone from saving their tasks. The worst case is a missing log row.
create or replace function public.first_things_record_activity(who uuid, snapshot jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare list_day date; total integer; finished integer; earned integer; used integer;
begin
  begin
    list_day := (snapshot->'daily'->>'day')::date;
    total := jsonb_array_length(snapshot->'tasks');
    -- A day with no tasks is not an active day, so it is not logged.
    if total = 0 or list_day is null then return; end if;
    select count(*) filter (where (t->>'done')::boolean) into finished
      from jsonb_array_elements(snapshot->'tasks') t;
    -- The ledger holds one entry per break earned; "used" marks the ones spent.
    select count(*), count(*) filter (where (e.value->>'used')::boolean) into earned, used
      from jsonb_each(coalesce(snapshot->'daily'->'ledger', '{}'::jsonb)) e;
    insert into public.first_things_activity_log
      (identity_id, list_date, number_of_tasks, completed_task_num, breaks_earned, breaks_used)
      values (who, list_day, total, finished, earned, used)
      on conflict (identity_id, list_date) do update set
        number_of_tasks = excluded.number_of_tasks,
        completed_task_num = excluded.completed_task_num,
        breaks_earned = excluded.breaks_earned,
        breaks_used = excluded.breaks_used,
        updated_at = now();
  exception when others then
    null; -- keep saving working no matter what
  end;
end $$;

create or replace function public.first_things_activity_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Retired rows are tombstones left behind by a phone number change.
  if not new.retired then
    perform public.first_things_record_activity(new.identity_id, new.state);
  end if;
  return new;
end $$;

drop trigger if exists first_things_activity on public.first_things_demo_accounts;
create trigger first_things_activity
  after insert or update of state on public.first_things_demo_accounts
  for each row execute function public.first_things_activity_trigger();

-- Supabase lets the public roles call new functions by default, so lock these
-- internal ones down explicitly. Otherwise anyone could write fake log rows.
revoke all on function public.first_things_record_activity(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.first_things_activity_trigger() from public, anon, authenticated;

-- Fill in today's row for accounts that already exist.
do $$ begin
  perform public.first_things_record_activity(identity_id, state)
    from public.first_things_demo_accounts where not retired;
end $$;

-- The four Key Results. Each one is calculated from real activity every time.
create or replace function public.first_things_okrs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  -- "Last 7 days" counts today and the 6 days before it, in Mountain time.
  window_start date := (now() at time zone 'America/Denver')::date - 6;
  total_tasks bigint; done_tasks bigint;       -- KR1
  total_lists bigint; full_lists bigint;       -- KR2
  avg_breaks numeric;                          -- KR3
  returning_users bigint; total_users bigint;  -- KR4
begin
  -- KR1: share of all tasks people planned that they actually completed.
  -- KR2: share of daily lists where every task was completed.
  -- KR3: average number of breaks earned on a day someone used the app.
  select coalesce(sum(number_of_tasks), 0), coalesce(sum(completed_task_num), 0),
         count(*), count(*) filter (where completed_task_num >= number_of_tasks),
         coalesce(avg(breaks_earned), 0)
    into total_tasks, done_tasks, total_lists, full_lists, avg_breaks
    from public.first_things_activity_log;

  -- KR4: people who came back, meaning they had a task list on 3 or more of the
  -- last 7 days. The table has one row per person per day, so count(*) = days.
  select count(*) into returning_users from (
    select identity_id from public.first_things_activity_log
     where list_date >= window_start
     group by identity_id having count(*) >= 3
  ) as frequent;
  select count(*) into total_users from public.first_things_demo_accounts where not retired;

  -- nullif(x, 0) avoids dividing by zero before anyone has any data.
  return jsonb_build_object(
    'objective1', jsonb_build_object(
      'title', 'Students finish their first things before they scroll',
      'kr1', jsonb_build_object('title', 'Task completion rate',
        'value', coalesce(round(100.0 * done_tasks / nullif(total_tasks, 0), 1), 0),
        'unit', '%', 'target', 70, 'numerator', done_tasks, 'denominator', total_tasks),
      'kr2', jsonb_build_object('title', 'Daily lists fully completed',
        'value', coalesce(round(100.0 * full_lists / nullif(total_lists, 0), 1), 0),
        'unit', '%', 'target', 50, 'numerator', full_lists, 'denominator', total_lists)),
    'objective2', jsonb_build_object(
      'title', 'Earned scroll time keeps students coming back',
      'kr3', jsonb_build_object('title', 'Breaks earned per active day',
        'value', round(avg_breaks, 1), 'unit', 'breaks', 'target', 2),
      'kr4', jsonb_build_object('title', 'Returning users (3+ of last 7 days)',
        'value', returning_users, 'unit', 'users', 'target', 5,
        'numerator', returning_users, 'denominator', total_users)),
    'generatedAt', now());
end $$;
revoke all on function public.first_things_okrs() from public;
grant execute on function public.first_things_okrs() to anon, authenticated;
commit;
