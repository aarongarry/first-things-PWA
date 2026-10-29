-- Run after both migrations. Everything, including fixtures, is rolled back.
begin;
do $$
declare p text := '+1999' || lpad((floor(random()*100000000)::bigint)::text,8,'0');
  moved text := '+1998' || lpad((floor(random()*100000000)::bigint)::text,8,'0');
  k uuid; snap jsonb; r jsonb; identity_before uuid;
begin
  snap := jsonb_build_object('onboarded',true,'profile',jsonb_build_object('name','Shortcut test','phone',p),
    'tasks','[{"id":"test","done":false}]'::jsonb,'goals','[]'::jsonb,
    'daily',jsonb_build_object('day',to_char(now() at time zone 'America/Denver','YYYY-MM-DD'),
      'timeOffset',0,'selectedApps','["Instagram"]'::jsonb,'activeUntil',0));
  insert into public.first_things_demo_accounts(phone,state) values(p,snap) returning identity_id into identity_before;
  k := (public.first_things_shortcut_setup(p)->>'access_key')::uuid;
  assert (public.first_things_shortcut_setup(p)->>'access_key')::uuid = k, 'stable setup key';
  r := public.first_things_instagram_status(k,'America/Denver');
  assert r->>'decision' = 'pause', 'unfinished task pauses';
  assert (select count(*) from jsonb_object_keys(r)) = 2, 'no account/task payload';
  assert public.first_things_instagram_status(gen_random_uuid(),'UTC')->>'decision' = 'refresh', 'unknown key';
  assert public.first_things_instagram_status(k,'bad zone')->>'decision' = 'refresh', 'invalid zone';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{tasks,0,done}','true') where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'allow', 'completed tasks';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{tasks}','[]') where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'allow', 'empty list';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{daily,selectedApps}','[]') where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'allow', 'Instagram unselected';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{daily,activeUntil}',to_jsonb(extract(epoch from now())*1000+60000)) where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'allow', 'active break';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{daily,activeUntil}',to_jsonb(extract(epoch from now())*1000-1)) where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'pause', 'expired break';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{daily,day}','"2000-01-01"') where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'refresh', 'stale day';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{daily,timeOffset}','86400000') where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'refresh', 'demo time';
  update public.first_things_demo_accounts set state=jsonb_set(snap,'{onboarded}','false') where phone=p;
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'refresh', 'onboarding';
  update public.first_things_demo_accounts set state=snap where phone=p;
  r := public.first_things_demo_rename(p,moved,'Moved test',1,gen_random_uuid());
  assert r->>'version' = '2', 'phone migration';
  assert (public.first_things_shortcut_setup(moved)->>'access_key')::uuid = k, 'key follows identity';
  assert public.first_things_instagram_status(k,'America/Denver')->>'decision' = 'pause', 'status survives phone move';
  assert has_function_privilege('anon','public.first_things_instagram_status(uuid,text)','execute'), 'shortcut RPC callable';
  assert not has_table_privilege('anon','public.first_things_shortcut_links','select'), 'no direct links table access';
end $$;
select 'PASS: paused, completed, empty, unselected, active/expired break, stale day, invalid key/zone, demo time, onboarding, phone migration and privileges' as result;
rollback;
