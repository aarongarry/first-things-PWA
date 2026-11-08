-- Run once in the project's SQL Editor, AFTER supabase/okr-report.sql and
-- supabase/instagram-shortcut.sql. Safe to run again.
--
-- Adds "Reminder only" tasks. A reminder-only task is saved in the account state
-- with "reminder": true. It never pauses apps and never earns a break, so it must
-- also be ignored here:
--   1. the app-reminder status checks used by the iPhone shortcut count only the
--      unfinished tasks that are NOT reminder-only
--   2. the daily activity log (behind the Progress report's Key Results) counts only
--      tasks that are NOT reminder-only
--
-- Only function bodies are replaced. No tables or existing data change.
begin;

create or replace function public.first_things_record_activity(who uuid, snapshot jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare list_day date; total integer; finished integer; earned integer; used integer;
begin
  begin
    list_day := (snapshot->'daily'->>'day')::date;
    -- Reminder-only tasks are not counted: they never affect screen time.
    select count(*) into total from jsonb_array_elements(snapshot->'tasks') t
      where not coalesce((t->>'reminder')::boolean, false);
    -- A day with no tasks is not an active day, so it is not logged.
    if total = 0 or list_day is null then return; end if;
    select count(*) filter (where (t->>'done')::boolean and not coalesce((t->>'reminder')::boolean, false)) into finished
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

create or replace function public.first_things_instagram_status(access_key uuid, timezone_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare snapshot jsonb; daily jsonb; decision text; reason text; remaining integer; until_ms numeric; current_day text;
begin
  -- Avoid cached access decisions. No personal fields are returned.
  perform set_config('response.headers', '[{"Cache-Control":"no-store, max-age=0"}]', true);
  select a.state into snapshot from public.first_things_shortcut_links l
    join public.first_things_demo_accounts a on a.identity_id = l.identity_id and not a.retired
    where l.access_key = first_things_instagram_status.access_key;
  if snapshot is null then
    return jsonb_build_object('decision','refresh','message','Set up the Instagram shortcut again in First Things.');
  end if;
  if timezone_name is null or not exists(select 1 from pg_timezone_names where name = timezone_name) then
    return jsonb_build_object('decision','refresh','message','Set up the shortcut again with your current time zone.');
  end if;
  current_day := to_char(now() at time zone timezone_name, 'YYYY-MM-DD');
  daily := snapshot->'daily';
  if daily->>'day' is distinct from current_day or coalesce((daily->>'timeOffset')::numeric,0) <> 0
     or coalesce((snapshot->>'onboarded')::boolean,false) = false then
    decision := 'refresh'; reason := 'Open First Things and sync today’s list before using Instagram.';
  else
    select count(*) into remaining from jsonb_array_elements(snapshot->'tasks') t where coalesce((t->>'done')::boolean,false) = false
      and not coalesce((t->>'reminder')::boolean,false); -- reminder-only tasks never pause apps
    until_ms := coalesce((daily->>'activeUntil')::numeric,0);
    if not coalesce(daily->'selectedApps' @> '["Instagram"]'::jsonb,false) then
      decision := 'allow'; reason := 'Instagram is not selected in Restricted apps.';
    elsif remaining = 0 then
      decision := 'allow'; reason := 'Your first things are done. Enjoy your time.';
    elsif until_ms > extract(epoch from now()) * 1000 then
      decision := 'allow'; reason := 'Your earned break is active.';
    else
      decision := 'pause'; reason := 'Finish your first things or start an earned break, then sync.';
    end if;
  end if;
  return jsonb_build_object('decision',decision,'message',reason);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('decision','refresh','message','Open First Things and sync your account again.');
end $$;

create or replace function public.first_things_app_status(access_key uuid, timezone_name text, app_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare snapshot jsonb; daily jsonb; decision text; reason text; remaining integer; until_ms numeric; current_day text;
begin
  -- Avoid cached access decisions. No personal fields are returned.
  perform set_config('response.headers', '[{"Cache-Control":"no-store, max-age=0"}]', true);
  select a.state into snapshot from public.first_things_shortcut_links l
    join public.first_things_demo_accounts a on a.identity_id = l.identity_id and not a.retired
    where l.access_key = first_things_app_status.access_key;
  if snapshot is null then
    return jsonb_build_object('decision','refresh','message','Set up the Instagram shortcut again in First Things.');
  end if;
  if timezone_name is null or not exists(select 1 from pg_timezone_names where name = timezone_name) then
    return jsonb_build_object('decision','refresh','message','Set up the shortcut again with your current time zone.');
  end if;
  current_day := to_char(now() at time zone timezone_name, 'YYYY-MM-DD');
  daily := snapshot->'daily';
  if daily->>'day' is distinct from current_day or coalesce((daily->>'timeOffset')::numeric,0) <> 0
     or coalesce((snapshot->>'onboarded')::boolean,false) = false then
    decision := 'refresh'; reason := 'Open First Things and sync today’s list before using Instagram.';
  else
    select count(*) into remaining from jsonb_array_elements(snapshot->'tasks') t where coalesce((t->>'done')::boolean,false) = false
      and not coalesce((t->>'reminder')::boolean,false); -- reminder-only tasks never pause apps
    until_ms := coalesce((daily->>'activeUntil')::numeric,0);
    if not coalesce(daily->'selectedApps' @> jsonb_build_array(app_name),false) then
      decision := 'allow'; reason := 'Instagram is not selected in Restricted apps.';
    elsif remaining = 0 then
      decision := 'allow'; reason := 'Your first things are done. Enjoy your time.';
    elsif until_ms > extract(epoch from now()) * 1000 then
      decision := 'allow'; reason := 'Your earned break is active.';
    else
      decision := 'pause'; reason := 'Finish your first things or start an earned break, then sync.';
    end if;
  end if;
  return jsonb_build_object('decision',decision,'message',reason);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('decision','refresh','message','Open First Things and sync your account again.');
end $$;

-- Rebuild today's log rows so they use the new rule right away.
do $$ begin
  perform public.first_things_record_activity(identity_id, state)
    from public.first_things_demo_accounts where not retired;
end $$;

commit;
