-- =====================================================================
-- Admin portal ("Maintain Users / Goals / Tasks") for First Things.
-- Run once in the Supabase SQL Editor AFTER supabase/setup.sql.
-- Safe to re-run: no DROP TABLE and no deletion of existing data.
--
-- How it stays secure:
--   * The browser can still NOT read or write the tables directly (RLS is on and
--     table access is revoked, exactly like setup.sql).
--   * Every admin action goes through a function below. Each one calls
--     admin_guard(), which raises an error unless the caller is a real
--     (non-anonymous) signed-in user that is listed in public.admin_users.
--   * So hiding the Maintain buttons in the UI is only cosmetic. Anyone who
--     calls these functions without being an admin gets an error.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Who is an admin?  One row per Supabase Auth user allowed to maintain data.
-- ---------------------------------------------------------------------
create table if not exists public.admin_users (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

-- True only for a signed-in, NON-anonymous user that is in admin_users.
-- (The app signs visitors in anonymously, so the is_anonymous check matters.)
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and exists (select 1 from public.admin_users a where a.auth_user_id = auth.uid());
$$;

-- Used at the top of every admin function: stop immediately if not an admin.
create or replace function public.admin_guard()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
end $$;

-- Lets the page ask "am I an admin?" so it knows whether to show the Maintain
-- buttons. Returns false (instead of raising) for everyone else.
create or replace function public.admin_whoami()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_admin', public.is_admin(),
    'email', (select a.email from public.admin_users a where a.auth_user_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------
-- 2. USERS  (public."user" rows, joined to the login e-mail in auth.users)
-- ---------------------------------------------------------------------
-- READ: every user with their login e-mail and how much data they own.
create or replace function public.admin_list_users()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id,
      'name', u.name,
      'phone_number', u.phone_number,
      'date_created', u.date_created,
      'auth_user_id', u.auth_user_id,
      'email', au.email,
      'is_admin', exists (select 1 from public.admin_users a where a.auth_user_id = u.auth_user_id),
      'goal_count', (select count(*) from public.goal g
                      where g.user_id = u.id and g.client_ref is distinct from '__inbox__'),
      'task_count', (select count(*) from public.task t join public.goal g on g.id = t.goal_id
                      where g.user_id = u.id)
    ) order by u.id)
    from public."user" u left join auth.users au on au.id = u.auth_user_id
  ), '[]'::jsonb);
end $$;

-- CREATE / UPDATE: p_id null = create, otherwise edit that user.
-- p_auth_user_id links the row to a login; the admin-users Edge Function passes it
-- after it creates the Supabase Auth account. On edit, null leaves the link alone.
create or replace function public.admin_save_user(
  p_id bigint, p_name text, p_phone text, p_auth_user_id uuid default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare saved_id bigint;
begin
  perform public.admin_guard();
  if trim(coalesce(p_phone, '')) = '' then raise exception 'A phone number is required'; end if;
  if p_id is null then
    insert into public."user"(name, phone_number, auth_user_id)
      values (nullif(trim(p_name), ''), trim(p_phone), p_auth_user_id)
      returning id into saved_id;
  else
    update public."user"
       set name = nullif(trim(p_name), ''), phone_number = trim(p_phone),
           auth_user_id = coalesce(p_auth_user_id, auth_user_id),
           data_version = data_version + 1   -- stale open tabs must reload before saving
     where id = p_id returning id into saved_id;
    if saved_id is null then raise exception 'User not found'; end if;
  end if;
  return saved_id;
end $$;

-- DELETE: removes the user and everything they own (tasks, goals, daily rows).
-- Returns the Auth user id so the Edge Function can delete the login too.
-- An admin cannot delete their own account (that would lock everyone out).
create or replace function public.admin_delete_user(p_id bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare login_id uuid;
begin
  perform public.admin_guard();
  select auth_user_id into login_id from public."user" where id = p_id;
  if not found then raise exception 'User not found'; end if;
  if login_id is not null and login_id = auth.uid() then
    raise exception 'You cannot delete the account you are signed in with';
  end if;
  delete from public.task t using public.goal g where t.goal_id = g.id and g.user_id = p_id;
  delete from public.goal where user_id = p_id;
  delete from public.daily where user_id = p_id;
  delete from public."user" where id = p_id;
  return login_id;
end $$;

-- ---------------------------------------------------------------------
-- 3. GOALS
-- ---------------------------------------------------------------------
create or replace function public.admin_list_goals()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', g.id, 'goal_name', g.goal_name, 'goal_date', g.goal_date,
      'user_id', g.user_id, 'user_name', coalesce(u.name, u.phone_number),
      'task_count', (select count(*) from public.task t where t.goal_id = g.id)
    ) order by g.id)
    from public.goal g join public."user" u on u.id = g.user_id
    where g.client_ref is distinct from '__inbox__'   -- hide the app's internal "Unassigned" bucket
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_save_goal(
  p_id bigint, p_user_id bigint, p_name text, p_date date
) returns bigint language plpgsql security definer set search_path = '' as $$
declare saved_id bigint; owner_id bigint;
begin
  perform public.admin_guard();
  if trim(coalesce(p_name, '')) = '' then raise exception 'A goal needs a name'; end if;
  if p_id is null then
    if not exists (select 1 from public."user" where id = p_user_id) then raise exception 'Pick a user for this goal'; end if;
    insert into public.goal(user_id, goal_name, goal_date) values (p_user_id, trim(p_name), p_date)
      returning id, user_id into saved_id, owner_id;
  else
    update public.goal set goal_name = trim(p_name), goal_date = p_date
     where id = p_id returning id, user_id into saved_id, owner_id;
    if saved_id is null then raise exception 'Goal not found'; end if;
  end if;
  update public."user" set data_version = data_version + 1 where id = owner_id;
  return saved_id;
end $$;

-- DELETE a goal and its tasks.
create or replace function public.admin_delete_goal(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id bigint;
begin
  perform public.admin_guard();
  select user_id into owner_id from public.goal where id = p_id;
  if not found then raise exception 'Goal not found'; end if;
  delete from public.task where goal_id = p_id;
  delete from public.goal where id = p_id;
  update public."user" set data_version = data_version + 1 where id = owner_id;
end $$;

-- ---------------------------------------------------------------------
-- 4. TASKS
-- ---------------------------------------------------------------------
create or replace function public.admin_list_tasks()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'task_name', t.task_name,
      'requires_photo', coalesce(t.requires_photo, false),
      'is_completed', coalesce(t.is_completed, false),
      'goal_id', t.goal_id,
      'goal_name', case when g.client_ref = '__inbox__' then 'Unassigned' else g.goal_name end,
      'user_name', coalesce(u.name, u.phone_number)
    ) order by t.id)
    from public.task t
    join public.goal g on g.id = t.goal_id
    join public."user" u on u.id = g.user_id
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_save_task(
  p_id bigint, p_goal_id bigint, p_name text, p_requires_photo boolean, p_is_completed boolean
) returns bigint language plpgsql security definer set search_path = '' as $$
declare saved_id bigint; owner_id bigint;
begin
  perform public.admin_guard();
  if trim(coalesce(p_name, '')) = '' then raise exception 'A task needs a name'; end if;
  select user_id into owner_id from public.goal where id = p_goal_id;
  if not found then raise exception 'Pick a goal for this task'; end if;
  if p_id is null then
    -- "details" holds the extra fields the phone app expects; give new tasks safe defaults.
    insert into public.task(goal_id, task_name, requires_photo, is_completed, details)
      values (p_goal_id, trim(p_name), coalesce(p_requires_photo, false), coalesce(p_is_completed, false),
              '{"duration":"","recurrence":"none","urgency":"normal","reminder":false,"failures":0}'::jsonb)
      returning id into saved_id;
  else
    update public.task set goal_id = p_goal_id, task_name = trim(p_name),
           requires_photo = coalesce(p_requires_photo, false), is_completed = coalesce(p_is_completed, false)
     where id = p_id returning id into saved_id;
    if saved_id is null then raise exception 'Task not found'; end if;
  end if;
  update public."user" set data_version = data_version + 1 where id = owner_id;
  return saved_id;
end $$;

create or replace function public.admin_delete_task(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare owner_id bigint;
begin
  perform public.admin_guard();
  select g.user_id into owner_id from public.task t join public.goal g on g.id = t.goal_id where t.id = p_id;
  if not found then raise exception 'Task not found'; end if;
  delete from public.task where id = p_id;
  update public."user" set data_version = data_version + 1 where id = owner_id;
end $$;

-- ---------------------------------------------------------------------
-- 5. Permissions: only signed-in users may call these (and each one then
--    checks admin_guard()). The anonymous *role* gets nothing.
-- ---------------------------------------------------------------------
revoke all on function public.is_admin(), public.admin_guard(), public.admin_whoami(),
  public.admin_list_users(), public.admin_save_user(bigint, text, text, uuid), public.admin_delete_user(bigint),
  public.admin_list_goals(), public.admin_save_goal(bigint, bigint, text, date), public.admin_delete_goal(bigint),
  public.admin_list_tasks(), public.admin_save_task(bigint, bigint, text, boolean, boolean), public.admin_delete_task(bigint)
  from public, anon;
grant execute on function public.is_admin(), public.admin_whoami(),
  public.admin_list_users(), public.admin_save_user(bigint, text, text, uuid), public.admin_delete_user(bigint),
  public.admin_list_goals(), public.admin_save_goal(bigint, bigint, text, date), public.admin_delete_goal(bigint),
  public.admin_list_tasks(), public.admin_save_task(bigint, bigint, text, boolean, boolean), public.admin_delete_task(bigint)
  to authenticated;

commit;

-- =====================================================================
-- AFTER RUNNING THIS FILE: create the first admin (the TA / grader account).
--   1. Supabase dashboard -> Authentication -> Users -> Add user -> Create new user.
--      Enter an e-mail and password and tick "Auto Confirm User".
--   2. Run this (replace the e-mail with the one you just created). It makes the
--      account an admin AND adds a row for it in the user table, so it also shows
--      up in "Maintain Users":
--
--   insert into public.admin_users (auth_user_id, email)
--   select id, email from auth.users where email = 'ta@example.com'
--   on conflict do nothing;
--
--   insert into public."user" (auth_user_id, name, phone_number)
--   select id, 'TA Grader', '000-000-0000' from auth.users where email = 'ta@example.com'
--   on conflict (auth_user_id) do nothing;
-- =====================================================================
