-- Run after pwa-demo-accounts.sql and okr-report.sql. Everything, including fixtures, is rolled back.
begin;
do $$
declare
  p text := '+1997' || lpad((floor(random()*100000000)::bigint)::text,8,'0');
  moved text := '+1996' || lpad((floor(random()*100000000)::bigint)::text,8,'0');
  today date := (now() at time zone 'America/Denver')::date;
  who uuid; r jsonb; before jsonb; v integer := 0; d integer;
  -- Builds the same JSON shape the app saves, for a given day.
  function_payload jsonb;
begin
  before := public.first_things_okrs();

  -- Day 1 (today): 3 tasks, 2 done, 2 breaks earned and 1 of them used.
  function_payload := jsonb_build_object('onboarded', true,
    'profile', jsonb_build_object('name', 'OKR test', 'phone', p),
    'tasks', '[{"id":"a","done":true},{"id":"b","done":false},{"id":"c","done":true}]'::jsonb,
    'goals', '[]'::jsonb,
    'daily', jsonb_build_object('day', to_char(today, 'YYYY-MM-DD'), 'timeOffset', 0,
      'ledger', '{"1":{"id":1,"used":true},"2":{"id":2,"used":false}}'::jsonb));
  r := public.first_things_demo_save(p, function_payload, v);
  assert r->>'conflict' = 'false', 'first save works';
  v := (r->>'version')::integer;
  select identity_id into who from public.first_things_demo_accounts where phone = p;
  assert (select (number_of_tasks, completed_task_num, breaks_earned, breaks_used)
            from public.first_things_activity_log where identity_id = who and list_date = today)
         = row(3, 2, 2, 1), 'log row matches the saved day';
  r := public.first_things_okrs();
  assert (r->'objective1'->'kr1'->>'denominator')::int - (before->'objective1'->'kr1'->>'denominator')::int = 3, 'KR1 counts planned tasks';
  assert (r->'objective1'->'kr1'->>'numerator')::int - (before->'objective1'->'kr1'->>'numerator')::int = 2, 'KR1 counts completed tasks';
  assert (r->'objective1'->'kr2'->>'numerator')::int = (before->'objective1'->'kr2'->>'numerator')::int, 'unfinished list is not complete';
  assert (r->'objective1'->'kr2'->>'denominator')::int - (before->'objective1'->'kr2'->>'denominator')::int = 1, 'KR2 counts the list';

  -- Finishing the last task updates the same row and completes the list.
  function_payload := jsonb_set(function_payload, '{tasks,1,done}', 'true');
  r := public.first_things_demo_save(p, function_payload, v);
  v := (r->>'version')::integer;
  assert (select count(*) from public.first_things_activity_log where identity_id = who) = 1, 'same day reuses its row';
  assert (select completed_task_num from public.first_things_activity_log where identity_id = who and list_date = today) = 3, 'row updates';
  r := public.first_things_okrs();
  assert (r->'objective1'->'kr2'->>'numerator')::int - (before->'objective1'->'kr2'->>'numerator')::int = 1, 'KR2 counts the finished list';

  -- Two earlier days make this person a returning user (3 days in the last 7).
  for d in 1..2 loop
    function_payload := jsonb_set(function_payload, '{daily,day}', to_jsonb(to_char(today - d, 'YYYY-MM-DD')));
    r := public.first_things_demo_save(p, function_payload, v);
    v := (r->>'version')::integer;
  end loop;
  assert (select count(*) from public.first_things_activity_log where identity_id = who) = 3, 'three active days';
  r := public.first_things_okrs();
  assert (r->'objective2'->'kr4'->>'value')::int - (before->'objective2'->'kr4'->>'value')::int = 1, 'KR4 counts a returning user';

  -- Days older than 7 do not count toward "returning".
  update public.first_things_activity_log set list_date = today - 30 where identity_id = who and list_date = today - 2;
  r := public.first_things_okrs();
  assert (r->'objective2'->'kr4'->>'value')::int = (before->'objective2'->'kr4'->>'value')::int, 'old days are outside the window';

  -- A broken state must never block saving.
  update public.first_things_demo_accounts set state = '{"tasks": 5, "daily": {"day": "not a date"}}' where phone = p;
  assert (select count(*) from public.first_things_demo_accounts where phone = p) = 1, 'bad state still saves';

  -- A phone number change keeps one identity and its history.
  r := public.first_things_demo_rename(p, moved, 'Moved test', (select version from public.first_things_demo_accounts where phone = p), gen_random_uuid());
  assert r->>'version' is not null, 'rename works';
  assert (select identity_id from public.first_things_demo_accounts where phone = moved) = who, 'identity follows the move';
  assert (select count(*) from public.first_things_activity_log where identity_id = who) >= 2, 'history survives the move';

  -- Privacy and permissions.
  assert position(p in public.first_things_okrs()::text) = 0 and position(moved in public.first_things_okrs()::text) = 0, 'no phone numbers in the report';
  assert has_function_privilege('anon', 'public.first_things_okrs()', 'execute'), 'report callable with the public key';
  assert not has_function_privilege('anon', 'public.first_things_record_activity(uuid,jsonb)', 'execute'), 'log writer is not public';
  assert not has_table_privilege('anon', 'public.first_things_activity_log', 'select'), 'no direct log access';
  assert not has_table_privilege('authenticated', 'public.first_things_activity_log', 'insert'), 'no direct log writes';
end $$;
select 'PASS: log rows, KR1-KR4 math, same-day update, 7-day window, bad state, phone move, no phone numbers, privileges' as result;
rollback;
