-- Apply after pwa-demo-accounts.sql. Demo-only, matching its unverified phone login.
-- The shortcut gets a narrow status capability, never names/numbers/task contents.
begin;
create table if not exists public.first_things_shortcut_links (
  identity_id uuid primary key,
  access_key uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);
alter table public.first_things_shortcut_links enable row level security;
revoke all on public.first_things_shortcut_links from anon, authenticated;

create or replace function public.first_things_shortcut_setup(account_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account_id uuid; link_key uuid;
begin
  select identity_id into account_id from public.first_things_demo_accounts
    where phone = account_phone and not retired;
  if account_id is null then raise exception 'Open First Things and sync your account first'; end if;
  insert into public.first_things_shortcut_links(identity_id) values(account_id)
    on conflict(identity_id) do nothing;
  select access_key into link_key from public.first_things_shortcut_links where identity_id = account_id;
  return jsonb_build_object('access_key', link_key);
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
    select count(*) into remaining from jsonb_array_elements(snapshot->'tasks') t where coalesce((t->>'done')::boolean,false) = false;
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
revoke all on function public.first_things_shortcut_setup(text) from public;
revoke all on function public.first_things_instagram_status(uuid,text) from public;
grant execute on function public.first_things_shortcut_setup(text) to anon, authenticated;
grant execute on function public.first_things_instagram_status(uuid,text) to anon, authenticated;
commit;
