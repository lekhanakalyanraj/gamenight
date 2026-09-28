-- Rooms, members and hosts: schema v0.
--
-- Rules this migration enforces in the database, not in app code:
--   * only signed-in (non-guest) users can create rooms
--   * anyone signed in, including anonymous guests, can join with a room code
--   * rooms hold 3-16 players; nicknames are unique per room (case-insensitive)
--   * adult rooms require an explicit 18+ confirmation from every member
--   * nobody writes these tables directly: all writes go through the RPCs below
--   * members can read only their own rooms, and only members receive a room's realtime broadcasts

create type public.age_rating as enum ('family', 'teen', 'adult');
create type public.room_status as enum ('lobby', 'playing', 'closed');
create type public.member_role as enum ('host', 'player');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  host_id uuid not null references auth.users (id) on delete cascade,
  status public.room_status not null default 'lobby',
  age_rating public.age_rating not null default 'family',
  max_players smallint not null default 16 check (max_players between 3 and 16),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create index rooms_host_id_idx on public.rooms (host_id);

create table public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 20),
  role public.member_role not null default 'player',
  adult_confirmed boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (room_id, user_id)
);

create unique index room_members_nickname_uq
  on public.room_members (room_id, lower(btrim(nickname)))
  where left_at is null;
create index room_members_user_id_idx on public.room_members (user_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so RLS policies can call it without recursing into room_members' own policy.
create function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members m
    where m.room_id = p_room_id
      and m.user_id = (select auth.uid())
      and m.left_at is null
  );
$$;

-- Realtime topics look like 'room:<uuid>'. Malformed topics are simply not allowed.
create function public.can_access_room_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_topic !~ '^room:[0-9a-f-]{36}$' then
    return false;
  end if;
  return public.is_room_member(substr(p_topic, 6)::uuid);
end;
$$;

create function public.is_guest()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
$$;

-- 32 unambiguous characters (no I, O, 0, 1), so every random byte maps uniformly.
create function public.new_room_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(6);
  code text := '';
begin
  for i in 0..5 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles for signed-in hosts (guests don't get one)
-- ---------------------------------------------------------------------------

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(new.is_anonymous, false) then
    insert into public.profiles (id, display_name)
    values (
      new.id,
      coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1), 'Host')
    );
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row-level security: read access only; every write goes through an RPC
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

create policy "users read their own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "users update their own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "hosts and members read a room" on public.rooms
  for select to authenticated
  using (host_id = (select auth.uid()) or public.is_room_member(id));

create policy "members read their room's members" on public.room_members
  for select to authenticated
  using (public.is_room_member(room_id));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create function public.create_room(
  p_nickname text,
  p_age_rating public.age_rating default 'family',
  p_confirm_adult boolean default false
)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms;
  v_attempt int := 0;
begin
  if v_uid is null then
    raise exception 'Sign in to create a room.' using errcode = '28000';
  end if;
  if public.is_guest() then
    raise exception 'Guests can join rooms but not create them.' using errcode = '42501';
  end if;
  if p_age_rating = 'adult' and not p_confirm_adult then
    raise exception 'Confirm you are 18 or over to host an adult room.' using errcode = '42501';
  end if;
  if (select count(*) from public.rooms r where r.host_id = v_uid and r.status <> 'closed') >= 3 then
    raise exception 'Close one of your open rooms first.' using errcode = '53400';
  end if;

  loop
    begin
      insert into public.rooms (code, host_id, age_rating)
      values (public.new_room_code(), v_uid, p_age_rating)
      returning * into v_room;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  -- The host plays too, so they are the room's first member.
  insert into public.room_members (room_id, user_id, nickname, role, adult_confirmed)
  values (v_room.id, v_uid, btrim(p_nickname), 'host', p_age_rating = 'adult');

  return v_room;
end;
$$;

create function public.join_room(
  p_code text,
  p_nickname text,
  p_confirm_adult boolean default false
)
returns public.room_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms;
  v_member public.room_members;
  v_active int;
begin
  if v_uid is null then
    raise exception 'Sign in to join a room.' using errcode = '28000';
  end if;

  -- Lock the room row so concurrent joins can't both squeeze past the capacity check.
  select * into v_room from public.rooms where code = upper(btrim(p_code)) for update;
  if not found or v_room.status = 'closed' then
    raise exception 'There is no open room with that code.' using errcode = 'P0002';
  end if;

  select * into v_member from public.room_members where room_id = v_room.id and user_id = v_uid;
  if found and v_member.left_at is null then
    return v_member;  -- already in: joining again is a no-op
  end if;

  if v_room.status <> 'lobby' then
    raise exception 'This room has already started playing.' using errcode = '55000';
  end if;
  if v_room.age_rating = 'adult' and not p_confirm_adult then
    raise exception 'This room is 18+. Confirm you are 18 or over to join.' using errcode = '42501';
  end if;

  select count(*) into v_active from public.room_members where room_id = v_room.id and left_at is null;
  if v_active >= v_room.max_players then
    raise exception 'This room is full.' using errcode = '53400';
  end if;

  begin
    if v_member.id is not null then
      update public.room_members
      set left_at = null, nickname = btrim(p_nickname), adult_confirmed = p_confirm_adult, joined_at = now()
      where id = v_member.id
      returning * into v_member;
    else
      insert into public.room_members (room_id, user_id, nickname, adult_confirmed)
      values (v_room.id, v_uid, btrim(p_nickname), p_confirm_adult)
      returning * into v_member;
    end if;
  exception when unique_violation then
    raise exception 'That nickname is taken in this room.' using errcode = '23505';
  end;

  return v_member;
end;
$$;

create function public.leave_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  update public.room_members set left_at = now()
  where room_id = p_room_id and user_id = v_uid and left_at is null;

  -- When the host leaves, the room closes.
  update public.rooms set status = 'closed', closed_at = now()
  where id = p_room_id and host_id = v_uid and status <> 'closed';
end;
$$;

revoke all on function public.create_room(text, public.age_rating, boolean) from public, anon;
revoke all on function public.join_room(text, text, boolean) from public, anon;
revoke all on function public.leave_room(uuid) from public, anon;
grant execute on function public.create_room(text, public.age_rating, boolean) to authenticated;
grant execute on function public.join_room(text, text, boolean) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
revoke all on function public.new_room_code() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: lobby changes broadcast on a private per-room topic
-- ---------------------------------------------------------------------------

create function public.broadcast_room_member_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'room:' || coalesce(new.room_id, old.room_id)::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

create trigger room_members_broadcast
  after insert or update or delete on public.room_members
  for each row execute function public.broadcast_room_member_change();

create policy "room members receive their room's broadcasts" on realtime.messages
  for select to authenticated
  using (public.can_access_room_topic((select realtime.topic())));

create policy "room members share presence in their room" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and public.can_access_room_topic((select realtime.topic()))
  );
