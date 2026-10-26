-- Run against an isolated PostgreSQL instance with the Supabase auth.uid() stub,
-- auth.users test UUIDs ...0001 and ...0002, and setup.sql already applied.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$
declare result jsonb; snapshot jsonb; version integer;
begin
  assert public.first_things_load()->'state' = 'null'::jsonb;
  snapshot := '{"profile":{"name":"Test One","phone":"5551111111"},"goals":[{"id":"g1","title":"Study","target":"2026-10-30"}],"tasks":[{"id":"t1","title":"Read","goalId":"g1","photo":false,"done":false,"recurrence":"none","duration":10,"anchor":"2026-10-10","failures":0},{"id":"t2","title":"Unassigned","goalId":"","photo":true,"done":false}],"daily":{"day":"2026-10-10","templates":[],"ledger":{},"activeUntil":0,"requestedBreaks":2,"selectedApps":["YouTube"],"timeOffset":0}}';
  version := public.first_things_save(snapshot, 0);
  assert version = 1;
  result := public.first_things_load();
  assert jsonb_array_length(result->'state'->'tasks') = 2;
  assert jsonb_array_length(result->'state'->'goals') = 1;
  assert result->'state'->'tasks'->0->>'title' = 'Read';
  assert result->'state'->'tasks'->1->>'goalId' = '';
  snapshot := jsonb_set(snapshot, '{tasks,0,title}', '"Read chapter two"');
  snapshot := jsonb_set(snapshot, '{tasks,0,done}', 'true');
  version := public.first_things_save(snapshot, version);
  result := public.first_things_load();
  assert result->'state'->'tasks'->0->>'title' = 'Read chapter two';
  assert result->'state'->'tasks'->0->>'done' = 'true';
  -- Fail after updating the user, and verify the whole transaction rolls back.
  begin
    perform public.first_things_save(jsonb_set(snapshot, '{tasks,0,goalId}', '"another-users-goal"'), version);
    raise exception 'TEST FAILED: foreign goal accepted';
  exception when raise_exception then
    if SQLERRM = 'TEST FAILED: foreign goal accepted' then raise; end if;
  end;
  assert public.first_things_load()->>'version' = version::text;
  assert public.first_things_load()->'state'->'tasks'->0->>'goalId' = 'g1';
  -- A stale version must also be rejected.
  begin
    perform public.first_things_save(snapshot, 0);
    raise exception 'TEST FAILED: stale save accepted';
  exception when raise_exception then
    if SQLERRM = 'TEST FAILED: stale save accepted' then raise; end if;
  end;
  assert public.first_things_load()->>'version' = version::text;
  begin
    perform id from public.task;
    raise exception 'TEST FAILED: direct unscoped table access allowed';
  exception when insufficient_privilege then null;
  end;
  -- Moving a task and deleting a goal preserves the task and its ID.
  snapshot := jsonb_set(snapshot, '{tasks,0,goalId}', '""');
  snapshot := jsonb_set(snapshot, '{goals}', '[]');
  version := public.first_things_save(snapshot, version);
  assert jsonb_array_length(public.first_things_load()->'state'->'goals') = 0;
  assert jsonb_array_length(public.first_things_load()->'state'->'tasks') = 2;
  assert public.first_things_load()->'state'->'tasks'->0->>'id' = 't1';
  snapshot := jsonb_set(snapshot, '{tasks}', '[]');
  perform public.first_things_save(snapshot, version);
  assert jsonb_array_length(public.first_things_load()->'state'->'tasks') = 0;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
do $$begin
  assert public.first_things_load()->'state' = 'null'::jsonb, 'Second user saw first user data';
end $$;
select set_config('request.jwt.claim.sub', '', true);
do $$begin
  begin
    perform public.first_things_load();
    raise exception 'TEST FAILED: unauthenticated load allowed';
  exception when raise_exception then
    if SQLERRM = 'TEST FAILED: unauthenticated load allowed' then raise; end if;
  end;
end $$;
rollback;
select 'PASS CRUD, refresh reads, unassigned tasks, goal removal, stale saves, ownership, authentication, and table access' as result;
