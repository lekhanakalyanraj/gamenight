-- Events out, host lines in: the first path between the game database and the agents.
--
--   * dispatch.events is a transactional outbox: a state change and the event describing it
--     commit together, so the dispatcher never misses an event or sees one that didn't happen
--   * agents_api is the agents' whole write surface: host_say (idempotent, rate-limited) and a
--     read-only room snapshot. The agents never touch game tables directly
--   * public.host_lines is what the AI host says, shown on the TV and phones

-- ---------------------------------------------------------------------------
-- The outbox (owned by the dispatcher's schema)
-- ---------------------------------------------------------------------------

create table dispatch.events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  kind text not null check (kind in ('member_joined')),
  payload jsonb not null default '{}',
  traceparent text,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  dispatched_at timestamptz,
  failed_at timestamptz
);
create index events_pending_idx on dispatch.events (next_attempt_at) where dispatched_at is null and failed_at is null;
create index events_room_id_idx on dispatch.events (room_id);
alter table dispatch.events enable row level security;
create policy "the dispatcher works the outbox" on dispatch.events
  for all to dispatcher_svc using (true) with check (true);
grant select, update on dispatch.events to dispatcher_svc;

-- A player joining becomes an event. The request's traceparent (sent by the web app, passed on by
-- the Data API in request.headers) rides along so one trace follows the join into the agents.
create function private.enqueue_member_joined()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role <> 'player' or new.left_at is not null then
    return null;
  end if;
  insert into dispatch.events (room_id, kind, payload, traceparent)
  values (
    new.room_id,
    'member_joined',
    jsonb_build_object('member_id', new.id, 'nickname', new.nickname),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'traceparent'
  );
  perform pg_notify('dispatch_events', new.room_id::text);
  return null;
end;
$$;
revoke all on function private.enqueue_member_joined() from public, anon, authenticated;

create trigger room_members_enqueue_joined
  after insert on public.room_members
  for each row execute function private.enqueue_member_joined();

-- A player who left and comes back counts as joining again.
create trigger room_members_enqueue_rejoined
  after update of left_at on public.room_members
  for each row when (old.left_at is not null and new.left_at is null)
  execute function private.enqueue_member_joined();

-- ---------------------------------------------------------------------------
-- What the AI host says
-- ---------------------------------------------------------------------------

create table public.host_lines (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  kind text not null check (kind in ('welcome', 'announce')),
  text text not null check (char_length(text) between 1 and 280),
  event_id uuid unique,
  created_at timestamptz not null default now()
);
create index host_lines_room_id_created_at_idx on public.host_lines (room_id, created_at);
alter table public.host_lines enable row level security;
create policy "members and displays read the host's lines" on public.host_lines
  for select to authenticated using (private.can_view_room(room_id));

create function private.broadcast_host_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'room:' || new.room_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null
  );
  return null;
end;
$$;
revoke all on function private.broadcast_host_line() from public, anon, authenticated;

create trigger host_lines_broadcast
  after insert on public.host_lines
  for each row execute function private.broadcast_host_line();

-- ---------------------------------------------------------------------------
-- The agents' API (only agents_svc can use it)
-- ---------------------------------------------------------------------------

create role agents_svc nologin;
create schema agents_api;
revoke all on schema agents_api from public;
grant usage on schema agents_api to agents_svc;

-- The AI host says something in a room. Idempotent by event_id (a retried run can't say it twice),
-- limited to 280 characters and 20 lines per room per minute, and never into a closed room.
create function agents_api.host_say(p_room_id uuid, p_text text, p_kind text, p_event_id uuid default null)
returns public.host_lines
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.host_lines;
  v_text text := btrim(p_text);
begin
  if p_event_id is not null then
    select * into v_line from public.host_lines where event_id = p_event_id;
    if found then
      return v_line;
    end if;
  end if;
  if not exists (select 1 from public.rooms where id = p_room_id and status <> 'closed') then
    raise exception 'No open room %.', p_room_id using errcode = 'P0002';
  end if;
  if (select count(*) from public.host_lines
      where room_id = p_room_id and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'The host has said enough for now in room %.', p_room_id using errcode = 'PT429';
  end if;

  insert into public.host_lines (room_id, kind, text, event_id)
  values (p_room_id, p_kind, v_text, p_event_id)
  returning * into v_line;
  return v_line;
end;
$$;

-- What the agents may know about a room: public lobby facts only (no user ids, no secrets).
create function agents_api.room_snapshot(p_room_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'code', r.code,
    'status', r.status,
    'age_rating', r.age_rating,
    'max_players', r.max_players,
    'tv_connected', exists (select 1 from public.room_displays d where d.room_id = r.id),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('nickname', m.nickname, 'role', m.role) order by m.joined_at)
      from public.room_members m where m.room_id = r.id and m.left_at is null
    ), '[]'::jsonb)
  )
  from public.rooms r
  where r.id = p_room_id;
$$;

revoke all on function agents_api.host_say(uuid, text, text, uuid) from public;
revoke all on function agents_api.room_snapshot(uuid) from public;
grant execute on function agents_api.host_say(uuid, text, text, uuid) to agents_svc;
grant execute on function agents_api.room_snapshot(uuid) to agents_svc;
