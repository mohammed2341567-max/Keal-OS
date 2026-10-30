-- KEAL OS v6 Supabase schema
-- Run once in Supabase SQL Editor. Re-running is designed to be safe.
-- No email addresses are stored in KEAL tables. Only Auth stores provider email.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.keal_invites (
  email_hash text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.keal_invites enable row level security;
revoke all on public.keal_invites from anon, authenticated;

create table if not exists public.keal_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  keal_id text not null unique,
  nickname text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint keal_nickname_format check (nickname ~ '^[A-Za-z0-9_-]{3,20}$')
);
create unique index if not exists keal_profiles_nickname_ci on public.keal_profiles (lower(nickname));
alter table public.keal_profiles enable row level security;
drop policy if exists "KEAL members can read public profiles" on public.keal_profiles;
create policy "KEAL members can read public profiles" on public.keal_profiles
  for select to authenticated using (true);
drop policy if exists "Users can update their own nickname" on public.keal_profiles;
create policy "Users can update their own nickname" on public.keal_profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on public.keal_profiles to authenticated;
grant update (nickname, updated_at) on public.keal_profiles to authenticated;

create or replace function public.keal_enforce_invite()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_hash text;
begin
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;
  if new.email is null or length(trim(new.email)) = 0 then
    raise exception 'KEAL invitation required';
  end if;
  v_hash := encode(extensions.digest(lower(trim(new.email)), 'sha256'), 'hex');
  -- Consume the invitation atomically: one invitation creates one Auth account.
  delete from public.keal_invites i where i.email_hash = v_hash returning i.email_hash into v_hash;
  if not found then
    raise exception 'This Google account has not been invited to KEAL OS';
  end if;
  return new;
end;
$$;

drop trigger if exists keal_auth_invite_guard on auth.users;
create trigger keal_auth_invite_guard before insert on auth.users
for each row execute function public.keal_enforce_invite();

create or replace function public.keal_create_profile()
returns trigger language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id text;
  v_nick text;
  v_first text[] := array['Bright','Silent','Silver','Neon','Swift','Arctic','Golden','Cosmic','Clever','Blue','Solar','Urban'];
  v_second text[] := array['Falcon','Comet','Raven','Orbit','Phoenix','Voyager','Pixel','Otter','Nova','Panda','Tiger','Harbor'];
  v_try integer := 0;
begin
  if new.is_anonymous then return new; end if;
  loop
    v_id := 'KEAL-' || upper(substr(encode(extensions.gen_random_bytes(8), 'hex'),1,16));
    exit when not exists (select 1 from public.keal_profiles where keal_id = v_id);
  end loop;
  loop
    v_nick := v_first[1 + floor(random()*array_length(v_first,1))::int]
      || v_second[1 + floor(random()*array_length(v_second,1))::int]
      || (1000 + floor(random()*9000)::int)::text;
    exit when not exists (select 1 from public.keal_profiles where lower(nickname)=lower(v_nick));
    v_try := v_try + 1;
    if v_try > 100 then v_nick := 'Member' || substr(replace(new.id::text,'-',''),1,8); exit; end if;
  end loop;
  insert into public.keal_profiles(user_id, keal_id, nickname)
  values(new.id, v_id, v_nick)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists keal_auth_profile_create on auth.users;
create trigger keal_auth_profile_create after insert on auth.users
for each row execute function public.keal_create_profile();

create or replace function public.keal_touch_profile()
returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists keal_profile_updated_at on public.keal_profiles;
create trigger keal_profile_updated_at before update on public.keal_profiles
for each row execute function public.keal_touch_profile();

create table if not exists public.keal_chat_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references public.keal_profiles(user_id) on delete cascade,
  body text not null check (char_length(body) between 1 and 800),
  created_at timestamptz not null default now()
);
create index if not exists keal_chat_messages_created_idx on public.keal_chat_messages(created_at desc);
alter table public.keal_chat_messages enable row level security;
drop policy if exists "Invited members can read chat" on public.keal_chat_messages;
create policy "Invited members can read chat" on public.keal_chat_messages
  for select to authenticated using (true);
drop policy if exists "Members can send as themselves" on public.keal_chat_messages;
create policy "Members can send as themselves" on public.keal_chat_messages
  for insert to authenticated with check (sender_id = auth.uid());
drop policy if exists "Members can delete their own messages" on public.keal_chat_messages;
create policy "Members can delete their own messages" on public.keal_chat_messages
  for delete to authenticated using (sender_id = auth.uid());
grant select, insert, delete on public.keal_chat_messages to authenticated;

-- Server-side chat rate limit (the client-side limit is only a usability aid).
create table if not exists public.keal_chat_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_sent_at timestamptz not null default '-infinity'
);
alter table public.keal_chat_rate_limits enable row level security;
revoke all on public.keal_chat_rate_limits from anon, authenticated;

create or replace function public.keal_chat_rate_limit()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_last timestamptz;
begin
  if auth.uid() is null or new.sender_id <> auth.uid() then
    raise exception 'not allowed';
  end if;
  new.body := btrim(new.body);
  if char_length(new.body) < 1 or char_length(new.body) > 800 then
    raise exception 'message must be 1–800 characters';
  end if;
  perform pg_advisory_xact_lock(hashtext(new.sender_id::text));
  insert into public.keal_chat_rate_limits(user_id) values(new.sender_id) on conflict(user_id) do nothing;
  select last_sent_at into v_last from public.keal_chat_rate_limits where user_id=new.sender_id for update;
  if v_last > now() - interval '1.2 seconds' then
    raise exception 'Please wait before sending another message';
  end if;
  update public.keal_chat_rate_limits set last_sent_at=now() where user_id=new.sender_id;
  return new;
end;
$$;
drop trigger if exists keal_chat_rate_guard on public.keal_chat_messages;
create trigger keal_chat_rate_guard before insert on public.keal_chat_messages
for each row execute function public.keal_chat_rate_limit();


-- Per-user text workspace files. The application writes through a safe RPC.
create table if not exists public.keal_user_files (
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null check (length(path) between 1 and 240 and path ~ '^[A-Za-z0-9 _./-]+$' and path !~ '(^/|/$|//)'),
  kind text not null default 'file' check (kind in ('file','dir')),
  content text,
  version text not null default '1',
  updated_at timestamptz not null default now(),
  primary key (user_id, path),
  check ((kind='dir' and content is null) or (kind='file' and content is not null and octet_length(content)<=262144))
);
alter table public.keal_user_files enable row level security;
drop policy if exists "Users read own files" on public.keal_user_files;
create policy "Users read own files" on public.keal_user_files for select to authenticated using (user_id=auth.uid());
drop policy if exists "Users delete own files" on public.keal_user_files;
create policy "Users delete own files" on public.keal_user_files for delete to authenticated using (user_id=auth.uid());
grant select, delete on public.keal_user_files to authenticated;

create or replace function public.keal_mkdir(p_path text)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if p_path is null or length(p_path)>240 or p_path !~ '^[A-Za-z0-9 _./-]+$' or p_path ~ '(^/|/$|//)'
     or exists (select 1 from regexp_split_to_table(p_path, '/') as paths(part) where part = '' or part in ('.','..') or left(part,1)='.' or length(part)>80)
  then raise exception 'invalid path'; end if;
  insert into public.keal_user_files(user_id,path,kind,content,version)
  values(v_user,p_path,'dir',null,'1')
  on conflict(user_id,path) do nothing;
  if exists (select 1 from public.keal_user_files where user_id=v_user and path=p_path and kind <> 'dir') then
    raise exception 'path already exists as a file';
  end if;
  return jsonb_build_object('ok',true,'path',p_path);
end;
$$;
revoke all on function public.keal_mkdir(text) from public, anon;
grant execute on function public.keal_mkdir(text) to authenticated;

create or replace function public.keal_write_file(p_path text, p_content text, p_base text default null, p_force boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_user uuid := auth.uid(); v_row public.keal_user_files%rowtype; v_version text;
begin
  if v_user is null then raise exception 'authentication required'; end if;
  if p_path is null or length(p_path)>240 or p_path !~ '^[A-Za-z0-9 _./-]+$' or p_path ~ '(^/|/$|//)'
     or exists (select 1 from regexp_split_to_table(p_path, '/') as paths(part) where part = '' or part in ('.','..') or left(part,1)='.' or length(part)>80)
  then raise exception 'invalid path'; end if;
  if p_path !~* '\.(txt|md|py|js|html|css|json|xml|csv|yml|yaml|toml|sh|sql)$' then raise exception 'unsupported file type'; end if;
  if p_content is null or octet_length(p_content)>262144 then raise exception 'file too large'; end if;
  perform pg_advisory_xact_lock(hashtext(v_user::text), hashtext(p_path));
  select * into v_row from public.keal_user_files where user_id=v_user and path=p_path for update;
  if found then
    if v_row.kind <> 'file' then raise exception 'path is a folder'; end if;
    v_version := md5(v_row.content);
    if not coalesce(p_force,false) and p_base is distinct from v_version then
      return jsonb_build_object('ok',false,'version',v_version,'current',jsonb_build_object('content',v_row.content,'version',v_version));
    end if;
    v_version := md5(p_content);
    update public.keal_user_files set content=p_content,version=v_version,updated_at=now() where user_id=v_user and path=p_path;
  else
    if p_base is not null and not coalesce(p_force,false) then return jsonb_build_object('ok',false,'current',null); end if;
    v_version := md5(p_content);
    insert into public.keal_user_files(user_id,path,kind,content,version) values(v_user,p_path,'file',p_content,v_version);
  end if;
  return jsonb_build_object('ok',true,'path',p_path,'version',v_version);
end;
$$;
revoke all on function public.keal_write_file(text,text,text,boolean) from public, anon;
grant execute on function public.keal_write_file(text,text,text,boolean) to authenticated;

create table if not exists public.keal_user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{"wallpaper_master":"midnight","wallpaper_client":"midnight"}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.keal_user_settings enable row level security;
drop policy if exists "Users manage own settings" on public.keal_user_settings;
create policy "Users manage own settings" on public.keal_user_settings for all to authenticated
  using (user_id=auth.uid()) with check (user_id=auth.uid());
grant select, insert, update, delete on public.keal_user_settings to authenticated;

create table if not exists public.keal_installed_apps (
  user_id uuid not null references auth.users(id) on delete cascade,
  device text not null check (device in ('master','client')),
  app_id text not null check (app_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  installed_at timestamptz not null default now(),
  primary key(user_id,device,app_id)
);
alter table public.keal_installed_apps enable row level security;
drop policy if exists "Users manage own app installs" on public.keal_installed_apps;
create policy "Users manage own app installs" on public.keal_installed_apps for all to authenticated
  using (user_id=auth.uid()) with check (user_id=auth.uid());
grant select, insert, update, delete on public.keal_installed_apps to authenticated;

-- Private realtime control topic: each user can connect only to their own paired devices.
drop policy if exists "KEAL user session read own topic" on realtime.messages;
create policy "KEAL user session read own topic" on realtime.messages
  for select to authenticated using (realtime.topic() = 'keal-session:' || (select auth.uid())::text);
drop policy if exists "KEAL user session write own topic" on realtime.messages;
create policy "KEAL user session write own topic" on realtime.messages
  for insert to authenticated with check (realtime.topic() = 'keal-session:' || (select auth.uid())::text);
drop policy if exists "KEAL chat private channel read" on realtime.messages;
create policy "KEAL chat private channel read" on realtime.messages
  for select to authenticated using (realtime.topic() = 'keal-chat-lobby');
drop policy if exists "KEAL chat private channel write" on realtime.messages;
create policy "KEAL chat private channel write" on realtime.messages
  for insert to authenticated with check (realtime.topic() = 'keal-chat-lobby');

-- Enable Postgres Changes for the chat table if it is not already in the publication.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='keal_chat_messages'
  ) then
    alter publication supabase_realtime add table public.keal_chat_messages;
  end if;
exception when undefined_object then
  raise notice 'Create/enable the supabase_realtime publication in the Supabase dashboard, then add keal_chat_messages.';
end $$;

-- Invite an address using a SHA-256 digest; the clear email is not stored here.
-- Run for your own Google account and each friend you want to invite:
-- insert into public.keal_invites(email_hash)
-- values (encode(extensions.digest(lower(trim('friend@example.com')), 'sha256'), 'hex'))
-- on conflict do nothing;
