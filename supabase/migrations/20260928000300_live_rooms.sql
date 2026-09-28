-- Live rooms: TVs paired as displays, removing players, and a rate limit on guessing codes.
--
-- Rules this migration adds:
--   * a TV is a display, not a player: it can read its room's lobby but never acts in it
--   * a TV pairs by showing a short-lived code that the room's host enters on their phone
--   * the host can remove a player from the lobby, and that player can't rejoin the room
--   * guessing room or pairing codes is limited to 10 misses per user per 10 minutes

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

alter table public.room_members add column removed_by_host boolean not null default false;

create table public.room_displays (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  paired_at timestamptz not null default now(),
  unique (room_id, user_id)
);
create index room_displays_user_id_idx on public.room_displays (user_id);

-- One live code per TV. A code is deleted as soon as it's used, so it can't pair twice.
create table public.display_pairings (
  code text primary key check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  expires_at timestamptz not null default now() + interval '10 minutes'
);

-- Internal bookkeeping, in a schema the Data API doesn't expose.
create table private.join_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('room', 'display')),
  attempted_at timestamptz not null default now()
);
create index join_attempts_user_id_attempted_at_idx on private.join_attempts (user_id, attempted_at);
alter table private.join_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.can_view_room(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_room_member(p_room_id)
      or exists (
        select 1 from public.room_displays d
        where d.room_id = p_room_id and d.user_id = (select auth.uid())
      );
$$;

-- Topics: 'room:<uuid>' for everyone who can view the room, 'display:<uuid>' for that TV alone.
create function private.can_access_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_topic ~ '^room:[0-9a-f-]{36}$' then
    return private.can_view_room(substr(p_topic, 6)::uuid);
  elsif p_topic ~ '^display:[0-9a-f-]{36}$' then
    return substr(p_topic, 9)::uuid = (select auth.uid());
  end if;
  return false;
end;
$$;

-- Raises once the caller has missed 10 times in 10 minutes. 'PT429' makes the Data API answer 429.
create function private.check_attempt_limit()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from private.join_attempts a
      where a.user_id = (select auth.uid()) and a.attempted_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Too many wrong codes. Wait a few minutes and try again.' using errcode = 'PT429';
  end if;
end;
$$;

create function private.record_failed_attempt(p_kind text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.join_attempts (user_id, kind) values ((select auth.uid()), p_kind);
$$;

revoke all on function private.can_view_room(uuid) from public, anon;
revoke all on function private.can_access_topic(text) from public, anon;
grant execute on function private.can_view_room(uuid) to authenticated;
grant execute on function private.can_access_topic(text) to authenticated;
revoke all on function private.check_attempt_limit() from public, anon, authenticated;
revoke all on function private.record_failed_attempt(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security: displays read their room; TVs read their own pairing
-- ---------------------------------------------------------------------------

drop policy "hosts and members read a room" on public.rooms;
create policy "hosts, members and displays read a room" on public.rooms
  for select to authenticated
  using (host_id = (select auth.uid()) or private.can_view_room(id));

drop policy "members read their room's members" on public.room_members;
create policy "members and displays read a room's members" on public.room_members
  for select to authenticated
  using (private.can_view_room(room_id));

alter table public.room_displays enable row level security;
create policy "members and displays see a room's displays" on public.room_displays
  for select to authenticated
  using (user_id = (select auth.uid()) or private.can_view_room(room_id));

alter table public.display_pairings enable row level security;
create policy "a TV reads its own pairing code" on public.display_pairings
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy "room members receive their room's broadcasts" on realtime.messages;
drop policy "room members share presence in their room" on realtime.messages;
drop function private.can_access_room_topic(text);

create policy "members and displays receive their topics" on realtime.messages
  for select to authenticated
  using (private.can_access_topic((select realtime.topic())));

create policy "members and displays share presence on their topics" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and private.can_access_topic((select realtime.topic()))
  );

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Replaces slice 0's join_room. Changes: attempts are rate-limited; an unknown code returns null
-- instead of raising (raising would roll back the recorded attempt); removed players and the
-- room's own TV can't join as players.
create or replace function public.join_room(
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
  perform private.check_attempt_limit();

  -- Lock the room row so concurrent joins can't both squeeze past the capacity check.
  select * into v_room from public.rooms where code = upper(btrim(p_code)) for update;
  if not found or v_room.status = 'closed' then
    perform private.record_failed_attempt('room');
    return null;
  end if;

  select * into v_member from public.room_members where room_id = v_room.id and user_id = v_uid;
  if found and v_member.removed_by_host then
    raise exception 'The host removed you from this room.' using errcode = '42501';
  end if;
  if found and v_member.left_at is null then
    return v_member;  -- already in: joining again is a no-op
  end if;

  if exists (select 1 from public.room_displays d where d.room_id = v_room.id and d.user_id = v_uid) then
    raise exception 'This screen is the room''s TV. Join from a phone.' using errcode = '42501';
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

-- The host removes a player from the lobby. They can't rejoin this room.
create function public.kick_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_member public.room_members;
  v_room public.rooms;
begin
  select * into v_member from public.room_members where id = p_member_id for update;
  if found then
    select * into v_room from public.rooms where id = v_member.room_id;
  end if;
  if not found or v_room.host_id is distinct from v_uid then
    raise exception 'Only the host can remove players.' using errcode = '42501';
  end if;
  if v_member.user_id = v_uid then
    raise exception 'You can''t remove yourself. Close the room instead.' using errcode = '42501';
  end if;
  if v_room.status <> 'lobby' then
    raise exception 'Players can only be removed in the lobby.' using errcode = '55000';
  end if;

  update public.room_members
  set left_at = coalesce(left_at, now()), removed_by_host = true
  where id = p_member_id;
end;
$$;

-- A TV asks for a code to show on screen. While its current code has more than 2 minutes left, it
-- gets that same code back (so two tabs, or a page that starts twice, all show one code); after
-- that, it gets a fresh code and the old one stops working.
create function public.start_display_pairing()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_attempt int := 0;
begin
  if v_uid is null then
    raise exception 'Sign in to show a pairing code.' using errcode = '28000';
  end if;
  select p.code into v_code from public.display_pairings p
  where p.user_id = v_uid and p.expires_at > now() + interval '2 minutes';
  if found then
    return v_code;
  end if;
  delete from public.display_pairings where user_id = v_uid;
  loop
    begin
      insert into public.display_pairings (code, user_id)
      values (public.new_room_code(), v_uid)
      returning code into v_code;
      return v_code;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

-- The host enters the TV's code on their phone. Returns null for a wrong or expired code
-- (so the miss is recorded, as in join_room), and tells the TV which room to show.
create function public.pair_display(p_room_id uuid, p_code text)
returns public.room_displays
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms;
  v_pairing public.display_pairings;
  v_display public.room_displays;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found or v_room.host_id is distinct from v_uid or v_room.status = 'closed' then
    raise exception 'Only the host can connect a TV to this room.' using errcode = '42501';
  end if;
  perform private.check_attempt_limit();

  delete from public.display_pairings
  where code = upper(btrim(p_code)) and expires_at > now()
  returning * into v_pairing;
  if not found then
    perform private.record_failed_attempt('display');
    return null;
  end if;

  insert into public.room_displays (room_id, user_id)
  values (v_room.id, v_pairing.user_id)
  on conflict (room_id, user_id) do update set paired_at = now()
  returning * into v_display;

  perform realtime.send(
    jsonb_build_object('room_code', v_room.code), 'paired', 'display:' || v_pairing.user_id::text, true
  );
  return v_display;
end;
$$;

-- The host disconnects a TV. The TV is told, and goes back to showing a pairing code.
create function public.remove_display(p_display_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display public.room_displays;
begin
  delete from public.room_displays d
  using public.rooms r
  where d.id = p_display_id and r.id = d.room_id and r.host_id = auth.uid()
  returning d.* into v_display;
  if not found then
    raise exception 'Only the host can disconnect a TV.' using errcode = '42501';
  end if;

  perform realtime.send(
    jsonb_build_object('room_id', v_display.room_id), 'unpaired', 'display:' || v_display.user_id::text, true
  );
end;
$$;

revoke all on function public.kick_member(uuid) from public, anon;
revoke all on function public.start_display_pairing() from public, anon;
revoke all on function public.pair_display(uuid, text) from public, anon;
revoke all on function public.remove_display(uuid) from public, anon;
grant execute on function public.kick_member(uuid) to authenticated;
grant execute on function public.start_display_pairing() to authenticated;
grant execute on function public.pair_display(uuid, text) to authenticated;
grant execute on function public.remove_display(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: room status and connected TVs join member changes on the room's topic
-- ---------------------------------------------------------------------------

create function private.broadcast_room_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'room:' || coalesce(new.id, old.id)::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

create function private.broadcast_room_display_change()
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

revoke all on function private.broadcast_room_change() from public, anon, authenticated;
revoke all on function private.broadcast_room_display_change() from public, anon, authenticated;

create trigger rooms_broadcast
  after update on public.rooms
  for each row execute function private.broadcast_room_change();

create trigger room_displays_broadcast
  after insert or update or delete on public.room_displays
  for each row execute function private.broadcast_room_display_change();
