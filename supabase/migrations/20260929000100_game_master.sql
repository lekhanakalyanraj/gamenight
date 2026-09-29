-- The AI game master's way in, the host agent starting games, and game events dispatched without delay.
--
--   * starting a game is one piece of logic, shared by the host's phone (public.start_game, as the
--     signed-in host) and the host agent (agents_api.start_game, for the host the Agent Server verified)
--   * the game master narrates with game_api.say: into its own game's room only, through the same
--     checks as host_say (length, rate, and no live secret word)

-- ---------------------------------------------------------------------------
-- Game events wake the dispatcher with a "game:" payload, so it hands them over at once instead of waiting
-- to batch them like lobby joins
-- ---------------------------------------------------------------------------

create or replace function private.emit_game_event(p_game public.games, p_kind text, p_payload jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into dispatch.events (room_id, kind, payload, traceparent)
  values (
    p_game.room_id,
    p_kind,
    p_payload || jsonb_build_object('game_id', p_game.id, 'step', p_game.step),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'traceparent'
  );
  perform pg_notify('dispatch_events', 'game:' || p_game.room_id::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- Starting a game
-- ---------------------------------------------------------------------------

create function private.begin_game(p_room_id uuid, p_host_id uuid, p_kind public.game_kind, p_settings jsonb)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms;
  v_game public.games;
  v_players int;
  v_settings jsonb := coalesce(p_settings, '{}');
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or p_host_id is null or v_room.host_id <> p_host_id then
    raise exception 'Only the host can start a game.' using errcode = '42501';
  end if;
  if v_room.status = 'closed' then
    raise exception 'This room is closed.' using errcode = '55000';
  end if;
  if v_room.status = 'playing' then
    raise exception 'A game is already running.' using errcode = '55000';
  end if;
  if jsonb_typeof(v_settings) <> 'object' or exists (
       select 1 from jsonb_object_keys(v_settings) k where k not in ('theme', 'region'))
     or (v_settings ? 'theme' and coalesce(char_length(btrim(v_settings ->> 'theme')), 0) not between 1 and 30)
     or (v_settings ? 'region' and coalesce(v_settings ->> 'region', '') !~ '^[A-Z]{2}$') then
    raise exception 'Settings take a theme (up to 30 characters) and a two-letter region.' using errcode = '22023';
  end if;
  select count(*) into v_players from public.room_members where room_id = p_room_id and left_at is null;
  if v_players not between 3 and 16 then
    raise exception 'Undercover needs 3 to 16 players.' using errcode = '55000';
  end if;

  insert into public.games (room_id, kind, settings) values (p_room_id, p_kind, v_settings) returning * into v_game;
  insert into public.game_players (game_id, member_id, room_id, seat)
  select v_game.id, m.id, p_room_id, row_number() over (order by m.joined_at)
  from public.room_members m where m.room_id = p_room_id and m.left_at is null;
  update public.rooms set status = 'playing' where id = p_room_id;

  perform private.emit_game_event(v_game, 'game_started', jsonb_build_object('kind', p_kind));
  return v_game;
end;
$$;

-- The host starts a game from their phone.
create or replace function public.start_game(p_room_id uuid, p_kind public.game_kind, p_settings jsonb default '{}')
returns public.games
language sql
security definer
set search_path = ''
as $$
  select * from private.begin_game(p_room_id, (select auth.uid()), p_kind, p_settings);
$$;

-- The host asks the host agent to start a game. The Agent Server has verified the host's login and that
-- they host this room; the database checks the host again.
create function agents_api.start_game(p_room_id uuid, p_host_id uuid, p_settings jsonb default '{}')
returns public.games
language sql
security definer
set search_path = ''
as $$
  select * from private.begin_game(p_room_id, p_host_id, 'undercover', p_settings);
$$;

-- ---------------------------------------------------------------------------
-- Saying something in a room: one set of checks for the host agent and the game master
-- ---------------------------------------------------------------------------

create function private.say(p_room_id uuid, p_text text, p_kind text, p_event_id uuid)
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
  if private.live_words_in(p_room_id, v_text) then
    raise exception 'That line would give away a secret word. Say it without the word.' using errcode = 'GN001';
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

create or replace function agents_api.host_say(p_room_id uuid, p_text text, p_kind text, p_event_id uuid default null)
returns public.host_lines
language sql
security definer
set search_path = ''
as $$
  select * from private.say(p_room_id, p_text, p_kind, p_event_id);
$$;

-- The game master narrates into its own game's room. Idempotent by event id, like host_say.
create function game_api.say(p_game_id uuid, p_text text, p_event_id uuid)
returns public.host_lines
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  select room_id into v_room_id from public.games where id = p_game_id;
  if not found then
    raise exception 'No game %.', p_game_id using errcode = 'P0002';
  end if;
  return private.say(v_room_id, p_text, 'narration', p_event_id);
end;
$$;

-- The pairs this room has played in the last 12 hours, so the content specialist can avoid them.
create function game_api.played_tonight(p_game_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_array(p.word_a, p.word_b)), '[]')
  from public.games g
  join private.game_words w on w.room_id = g.room_id and w.created_at > now() - interval '12 hours'
  join content.word_pairs p on p.id = w.pair_id
  where g.id = p_game_id;
$$;

revoke all on function private.begin_game(uuid, uuid, public.game_kind, jsonb) from public, anon, authenticated;
revoke all on function private.say(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function agents_api.start_game(uuid, uuid, jsonb) from public;
grant execute on function agents_api.start_game(uuid, uuid, jsonb) to agents_svc;
revoke all on function game_api.say(uuid, text, uuid) from public;
grant execute on function game_api.say(uuid, text, uuid) to game_master_svc;
revoke all on function game_api.played_tonight(uuid) from public;
grant execute on function game_api.played_tonight(uuid) to game_master_svc;
