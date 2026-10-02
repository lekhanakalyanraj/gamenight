-- Heads Up, slice 6a: the game in the database.
--
-- The guesser turns their back to the TV; the card shows on the TV for the room, who shout clues; the guesser taps
-- Got it or Pass on their phone. Turns rotate; each guesser scores what they got.
--
-- The secret is the card, kept from one person: the guesser. So the live card never goes on the room topic (the
-- guesser's phone listens there). It goes only to the room's TVs, each on its own display:{id} topic, which only that
-- TV can join; a TV that reloads asks for it again (headsup_live_card, TVs only). A turn's cards become public at its
-- recap. The host's lines may not name any card that isn't public yet (private.live_words_in).
--
--   content.headsup_cards   the card bank (a hand-checked seed now; AI-built decks join it in 6b)
--   room_members.interests  up to three per player, picked in the lobby; the deck leans toward them
--   private.headsup_deck    a game's dealt cards, in order; which turn showed each, and Got it or Pass
--   public.headsup_turns    each turn: the guesser, its clock, counts, and (once it's over) its cards
--
-- The database runs the clock: the countdown, the guessing, the end of a turn. The game master starts each next
-- turn (so it can pace the room and commentate), and the game ends after everyone has had their turns.

-- ---------------------------------------------------------------------------
-- The card bank
-- ---------------------------------------------------------------------------

create table content.headsup_cards (
  id uuid primary key default gen_random_uuid(),
  topic text not null check (topic ~ '^[a-z][a-z0-9 &-]{1,29}$'),
  card text not null check (char_length(btrim(card)) between 2 and 40),
  rating public.age_rating not null default 'family',
  region text check (region ~ '^[A-Z]{2}$'),  -- null: known everywhere
  origin text not null default 'seed' check (origin in ('seed', 'generated')),
  status text not null default 'verified' check (status in ('verified', 'retired')),
  created_at timestamptz not null default now()
);
create unique index headsup_cards_topic_card_uq on content.headsup_cards (topic, lower(btrim(card)));
alter table content.headsup_cards enable row level security;

-- ---------------------------------------------------------------------------
-- Interests, picked in the lobby (up to three each)
-- ---------------------------------------------------------------------------

alter table public.room_members add column interests text[]
  check (interests is null or cardinality(interests) between 1 and 3);

create function public.set_interests(p_room_id uuid, p_interests text[])
returns public.room_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.room_members;
  v_clean text[];
begin
  select * into v_member from public.room_members
  where room_id = p_room_id and user_id = (select auth.uid()) and left_at is null
  for update;
  if not found then
    raise exception 'You''re not in this room.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.rooms where id = p_room_id and status = 'lobby') then
    raise exception 'Pick interests in the lobby, before a game starts.' using errcode = '55000';
  end if;
  select array_agg(i order by first) into v_clean
  from (
    select min(ord) as first, min(t) as i
    from unnest(coalesce(p_interests, '{}')) with ordinality as u(raw, ord)
    cross join lateral (select nullif(btrim(regexp_replace(raw, '\s+', ' ', 'g')), '') as t) c
    where t is not null
    group by lower(t)
  ) d;
  if cardinality(v_clean) > 3 then
    raise exception 'Pick up to three interests.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(v_clean, '{}')) i where i !~ '^[[:alpha:][:digit:] &''.,-]{2,30}$') then
    raise exception 'An interest is 2 to 30 letters, numbers, spaces or simple punctuation.' using errcode = '22023';
  end if;
  update public.room_members set interests = v_clean where id = v_member.id returning * into v_member;
  return v_member;
end;
$$;

-- ---------------------------------------------------------------------------
-- A game's deck and turns
-- ---------------------------------------------------------------------------

create table private.headsup_deck (
  game_id uuid not null references public.games (id) on delete cascade,
  position int not null check (position >= 1),
  room_id uuid not null references public.rooms (id) on delete cascade,
  card_id uuid not null references content.headsup_cards (id),
  card text not null,
  turn smallint,                                   -- the turn that showed it
  result text check (result in ('got', 'pass')),  -- null: not answered (still on screen, or the buzzer went)
  shown_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (game_id, position)
);
create index headsup_deck_room_id_idx on private.headsup_deck (room_id, created_at);
create index headsup_deck_card_id_idx on private.headsup_deck (card_id);
alter table private.headsup_deck enable row level security;

-- Which card is on the TV right now (the deck position), per game.
create table private.headsup_live (
  game_id uuid primary key references public.games (id) on delete cascade,
  position int
);
alter table private.headsup_live enable row level security;

-- A guesser's taps, by the id their phone made, so a retried tap counts once.
create table private.headsup_moves (
  action_id uuid primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  turn smallint not null,
  card_no smallint not null,
  result text not null check (result in ('got', 'pass')),
  by_user uuid not null,
  created_at timestamptz not null default now()
);
create index headsup_moves_game_id_idx on private.headsup_moves (game_id);
alter table private.headsup_moves enable row level security;

create table public.headsup_turns (
  game_id uuid not null references public.games (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  number smallint not null check (number >= 1),
  round smallint not null check (round >= 1),
  member_id uuid not null references public.room_members (id) on delete cascade,
  step int not null,
  started_at timestamptz,          -- when guessing began
  ends_at timestamptz,             -- when the buzzer goes (moves with pause and +30 seconds: the game's deadline rules)
  ended_at timestamptz,
  shown smallint not null default 0,   -- cards shown so far this turn, the live one included: what a tap answers
  got smallint not null default 0,
  passed smallint not null default 0,
  cards jsonb,                     -- at the recap: [{card, result}], in order; null while the turn is on
  primary key (game_id, number),
  check ((cards is null) = (ended_at is null))
);
create index headsup_turns_room_id_idx on public.headsup_turns (room_id);
create index headsup_turns_member_id_idx on public.headsup_turns (member_id);
alter table public.headsup_turns enable row level security;
create policy "members and displays read a game's turns" on public.headsup_turns
  for select to authenticated using (private.can_view_room(room_id));
create trigger headsup_turns_broadcast after insert or update on public.headsup_turns
  for each row execute function private.broadcast_game_change();

-- ---------------------------------------------------------------------------
-- The live card, to the room's TVs only
-- ---------------------------------------------------------------------------

-- Sends what's on screen now (or nothing) to every TV paired with the game's room, each on its own topic.
create function private.headsup_send_card(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_display record;
begin
  select jsonb_build_object('game_id', g.id, 'turn', t.number, 'card_no', t.shown,
                            'card', case when g.phase = 'guessing' then d.card end)
  into v_payload
  from public.games g
  left join private.headsup_live l on l.game_id = g.id
  left join private.headsup_deck d on d.game_id = g.id and d.position = l.position
  left join lateral (select * from public.headsup_turns t where t.game_id = g.id order by t.number desc limit 1) t on true
  where g.id = p_game_id;
  for v_display in
    select d.user_id from public.room_displays d join public.games g on g.room_id = d.room_id where g.id = p_game_id
  loop
    perform realtime.send(v_payload, 'headsup_card', 'display:' || v_display.user_id::text, true);
  end loop;
end;
$$;

-- What a TV shows now, for a TV that has just loaded or reconnected. Only a TV paired with the game's room may ask.
create function public.headsup_live_card(p_game_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game_id;
  if not found or not exists (select 1 from public.room_displays d
                              where d.room_id = v_game.room_id and d.user_id = (select auth.uid())) then
    raise exception 'Only the room''s TV shows the card.' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('game_id', v_game.id, 'turn', t.number, 'card_no', t.shown,
                              'card', case when v_game.phase = 'guessing' then d.card end)
    from private.headsup_live l
    left join private.headsup_deck d on d.game_id = l.game_id and d.position = l.position
    left join lateral (select * from public.headsup_turns t where t.game_id = l.game_id order by t.number desc limit 1) t on true
    where l.game_id = p_game_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Dealing, turns and taps
-- ---------------------------------------------------------------------------

-- Deals the deck: the room's rating or milder, its region or everywhere, nothing played in this room in the last
-- 12 hours, shuffled, leaning toward the players' interests. Enough for every turn at a quick pace.
create function private.headsup_deal(p_game_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_room public.rooms;
  v_interests text[];
  v_dealt int;
begin
  select * into v_game from public.games where id = p_game_id;
  select * into v_room from public.rooms where id = v_game.room_id;
  select coalesce(array_agg(distinct lower(btrim(i))), '{}') into v_interests
  from public.game_players p join public.room_members m on m.id = p.member_id
  cross join lateral unnest(coalesce(m.interests, '{}')) i
  where p.game_id = p_game_id;

  insert into private.headsup_deck (game_id, position, room_id, card_id, card)
  select p_game_id, row_number() over (order by k), v_game.room_id, c.id, btrim(c.card)
  from (
    select c.*, case when c.topic = any(v_interests) then random() * 0.4 else random() end as k
    from content.headsup_cards c
    where c.status = 'verified' and c.rating <= v_room.age_rating
      and (c.region is null or c.region = v_game.settings ->> 'region')
      and not exists (select 1 from private.headsup_deck d
                      where d.room_id = v_game.room_id and d.card_id = c.id and d.created_at > now() - interval '12 hours')
    order by k
    limit (v_game.config ->> 'total_turns')::int * 30
  ) c;
  get diagnostics v_dealt = row_count;
  insert into private.headsup_live (game_id, position) values (p_game_id, null);
  return v_dealt;
end;
$$;

-- The current turn, or null.
create function private.headsup_turn(p_game_id uuid)
returns public.headsup_turns
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.headsup_turns where game_id = p_game_id order by number desc limit 1;
$$;

-- Puts the next unseen card on the TV, or ends the turn if the deck has run out.
create function private.headsup_next_card(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.headsup_turns := private.headsup_turn(p_game_id);
  v_position int;
begin
  select min(position) into v_position from private.headsup_deck where game_id = p_game_id and shown_at is null;
  if v_position is null then
    perform private.headsup_end_turn(p_game_id, 'deck_empty');
    return;
  end if;
  update private.headsup_deck set turn = v_turn.number, shown_at = now()
  where game_id = p_game_id and position = v_position;
  update private.headsup_live set position = v_position where game_id = p_game_id;
  update public.headsup_turns set shown = shown + 1 where game_id = p_game_id and number = v_turn.number;
  perform private.headsup_send_card(p_game_id);
end;
$$;

-- The countdown's over: the clock starts and the first card goes up.
create function private.headsup_begin_guessing(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_seconds int;
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.phase <> 'ready' then
    return;
  end if;
  v_seconds := (v_game.config ->> 'seconds')::int;
  update public.games
  set phase = 'guessing', step = step + 1, phase_deadline = now() + make_interval(secs => v_seconds), resolved = false
  where id = p_game_id;
  update public.headsup_turns set started_at = now(), ends_at = now() + make_interval(secs => v_seconds)
  where game_id = p_game_id and number = (private.headsup_turn(p_game_id)).number;
  perform private.headsup_next_card(p_game_id);
end;
$$;

-- The buzzer (time, the host, or an empty deck): the turn's cards go public, and the recap shows for a few seconds.
create function private.headsup_end_turn(p_game_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_turn public.headsup_turns := private.headsup_turn(p_game_id);
begin
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.phase <> 'guessing' then
    return;
  end if;
  update public.headsup_turns t
  set ended_at = now(),
      cards = (select coalesce(jsonb_agg(jsonb_build_object('card', d.card, 'result', d.result) order by d.position), '[]')
               from private.headsup_deck d where d.game_id = p_game_id and d.turn = v_turn.number)
  where t.game_id = p_game_id and t.number = v_turn.number
  returning * into v_turn;
  update private.headsup_live set position = null where game_id = p_game_id;
  update public.games
  set phase = 'recap', step = step + 1, resolved = true,
      phase_deadline = now() + make_interval(secs => (config ->> 'recap_seconds')::int)
  where id = p_game_id
  returning * into v_game;
  perform private.headsup_send_card(p_game_id);
  perform private.emit_game_event(v_game, 'phase_complete', jsonb_build_object(
    'phase', 'guessing', 'reason', p_reason, 'turn', v_turn.number, 'guesser', v_turn.member_id,
    'got', v_turn.got, 'passed', v_turn.passed));
end;
$$;

-- The guesser taps Got it or Pass for the card on screen (card_no: its place in the turn, so a late or repeated tap
-- can't answer the next card). The host may tap for them. The phone makes the action id: a retried tap counts once.
create function public.headsup_move(p_game_id uuid, p_result text, p_card_no int, p_action_id uuid)
returns public.headsup_turns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_turn public.headsup_turns;
  v_position int;
  v_is_host boolean;
begin
  if p_action_id is null or p_result not in ('got', 'pass') then
    raise exception 'A move is Got it or Pass, with its id.' using errcode = '22023';
  end if;
  if exists (select 1 from private.headsup_moves where action_id = p_action_id) then
    select * into v_turn from public.headsup_turns t
    where t.game_id = p_game_id and t.number = (select turn from private.headsup_moves where action_id = p_action_id);
    return v_turn;  -- a retry: counted already
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found or v_game.kind <> 'heads_up' then
    raise exception 'That''s not a game of Heads Up.' using errcode = '22023';
  end if;
  v_turn := private.headsup_turn(p_game_id);
  v_is_host := exists (select 1 from public.rooms where id = v_game.room_id and host_id = (select auth.uid()));
  if not v_is_host and not exists (select 1 from public.room_members m
                                   where m.id = v_turn.member_id and m.user_id = (select auth.uid()) and m.left_at is null) then
    raise exception 'Only this turn''s guesser (or the host) can say Got it or Pass.' using errcode = '42501';
  end if;
  if v_game.phase <> 'guessing' or v_game.paused_at is not null then
    raise exception 'There''s no card to answer right now.' using errcode = '55000';
  end if;
  if p_card_no is distinct from v_turn.shown then
    raise exception 'That card has already moved on.' using errcode = '55000';
  end if;

  select position into v_position from private.headsup_live where game_id = p_game_id;
  update private.headsup_deck set result = p_result where game_id = p_game_id and position = v_position;
  insert into private.headsup_moves (action_id, game_id, turn, card_no, result, by_user)
  values (p_action_id, p_game_id, v_turn.number, p_card_no, p_result, (select auth.uid()));
  update public.headsup_turns
  set got = got + (p_result = 'got')::int, passed = passed + (p_result = 'pass')::int
  where game_id = p_game_id and number = v_turn.number;
  perform private.headsup_next_card(p_game_id);
  return private.headsup_turn(p_game_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- The game master's side
-- ---------------------------------------------------------------------------

-- The game as the game master sees it: players, turns, scores. Never a card that isn't public yet.
create function game_api.get_headsup_state(p_game_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'game', jsonb_build_object(
      'id', g.id, 'room_id', g.room_id, 'kind', g.kind, 'phase', g.phase, 'step', g.step, 'config', g.config,
      'phase_deadline', g.phase_deadline, 'paused', g.paused_at is not null, 'resolved', g.resolved),
    'age_rating', r.age_rating,
    'turns_done', (select count(*) from public.headsup_turns t where t.game_id = g.id and t.ended_at is not null),
    'total_turns', (g.config ->> 'total_turns')::int,
    'turn', (select to_jsonb(t) - 'room_id' from public.headsup_turns t where t.game_id = g.id order by t.number desc limit 1),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'member_id', p.member_id, 'nickname', m.nickname, 'interests', m.interests, 'in_room', m.left_at is null,
                  'got', coalesce((select sum(t.got) from public.headsup_turns t where t.game_id = g.id and t.member_id = p.member_id), 0))
                  order by p.seat), '[]')
                from public.game_players p join public.room_members m on m.id = p.member_id where p.game_id = g.id)
  )
  from public.games g join public.rooms r on r.id = g.room_id
  where g.id = p_game_id;
$$;

-- Starts the next turn: the next guesser in the rotation who's still in the room gets the countdown. After everyone
-- has had their turns, the game ends instead.
create function game_api.gm_next_turn(p_game_id uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb := private.applied(p_event_id, 'gm_next_turn');
  v_game public.games;
  v_number int;
  v_total int;
  v_players int;
  v_member uuid;
  v_round int;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  v_game := private.gm_game(p_game_id, p_event_id);
  if v_game.kind <> 'heads_up' then
    raise exception 'That''s not a game of Heads Up.' using errcode = '22023';
  end if;
  if v_game.paused_at is not null then
    raise exception 'The game is paused.' using errcode = '55000';
  end if;
  if not (v_game.phase = 'setup' or (v_game.phase = 'recap' and v_game.phase_deadline is null)) then
    raise exception 'The next turn starts once the last one''s recap has had its time.' using errcode = '55000';
  end if;
  v_total := (v_game.config ->> 'total_turns')::int;
  v_players := cardinality(v_game.turn_order);
  select count(*) into v_number from public.headsup_turns where game_id = p_game_id;

  -- The next guesser still in the room (whoever left is skipped, their turns too).
  loop
    v_number := v_number + 1;
    exit when v_number > v_total;
    v_member := v_game.turn_order[((v_number - 1) % v_players) + 1];
    exit when exists (select 1 from public.room_members where id = v_member and left_at is null);
  end loop;
  if v_number > v_total or not exists (select 1 from private.headsup_deck where game_id = p_game_id and shown_at is null) then
    perform private.end_game(p_game_id, null);
    return private.record_applied(p_event_id, 'gm_next_turn', p_game_id, jsonb_build_object('game_over', true));
  end if;

  v_round := (v_number - 1) / v_players + 1;
  update public.games
  set phase = 'ready', step = step + 1, round = v_round, resolved = false,
      phase_deadline = now() + make_interval(secs => (config ->> 'ready_seconds')::int)
  where id = p_game_id
  returning * into v_game;
  insert into public.headsup_turns (game_id, room_id, number, round, member_id, step)
  values (p_game_id, v_game.room_id, v_number, v_round, v_member, v_game.step);

  return private.record_applied(p_event_id, 'gm_next_turn', p_game_id, jsonb_build_object(
    'turn', v_number, 'of', v_total, 'round', v_round, 'guesser', v_member, 'game_over', false));
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared machinery, now Heads Up aware
-- ---------------------------------------------------------------------------

create or replace function private.begin_game(p_room_id uuid, p_host_id uuid, p_kind public.game_kind, p_settings jsonb)
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
  v_config jsonb := '{}';
  v_rounds int;
  v_turns int;
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
  if jsonb_typeof(v_settings) <> 'object'
     or (v_settings ? 'region' and coalesce(v_settings ->> 'region', '') !~ '^[A-Z]{2}$') then
    raise exception 'Settings are an object, and a region is two capital letters.' using errcode = '22023';
  end if;

  select count(*) into v_players from public.room_members where room_id = p_room_id and left_at is null;

  if p_kind = 'undercover' then
    if exists (select 1 from jsonb_object_keys(v_settings) k where k not in ('theme', 'region'))
       or (v_settings ? 'theme' and coalesce(char_length(btrim(v_settings ->> 'theme')), 0) not between 1 and 30) then
      raise exception 'Settings take a theme (up to 30 characters) and a two-letter region.' using errcode = '22023';
    end if;
  elsif p_kind = 'quiz' then
    if exists (select 1 from jsonb_object_keys(v_settings) k where k not in ('rounds', 'seconds', 'region'))
       or (v_settings ? 'rounds' and coalesce(v_settings ->> 'rounds', '') not in ('3', '4', '5'))
       or (v_settings ? 'seconds' and coalesce(v_settings ->> 'seconds', '') not in ('10', '20', '30')) then
      raise exception 'A quiz takes 3, 4 or 5 rounds, 10, 20 or 30 seconds a question, and a region.' using errcode = '22023';
    end if;
    v_rounds := coalesce((v_settings ->> 'rounds')::int, 4);
    v_config := jsonb_build_object(
      'rounds', v_rounds, 'per_round', 5, 'seconds', coalesce((v_settings ->> 'seconds')::int, 20),
      'estimate_extra_seconds', 10, 'reveal_seconds', 8,
      -- A different kind each round, finishing on closest-estimate for a dramatic end.
      'round_kinds', case v_rounds
        when 3 then '["choice", "picture", "estimate"]'::jsonb
        when 4 then '["choice", "true_false", "picture", "estimate"]'::jsonb
        else '["choice", "true_false", "picture", "choice", "estimate"]'::jsonb end);
  elsif p_kind = 'heads_up' then
    if exists (select 1 from jsonb_object_keys(v_settings) k where k not in ('turns', 'seconds', 'region'))
       or (v_settings ? 'turns' and coalesce(v_settings ->> 'turns', '') not in ('1', '2'))
       or (v_settings ? 'seconds' and coalesce(v_settings ->> 'seconds', '') not in ('45', '60', '90')) then
      raise exception 'Heads Up takes 1 or 2 turns each, 45, 60 or 90 seconds a turn, and a region.' using errcode = '22023';
    end if;
    v_turns := coalesce((v_settings ->> 'turns')::int, 1);
    v_config := jsonb_build_object(
      'turns', v_turns, 'seconds', coalesce((v_settings ->> 'seconds')::int, 60),
      'ready_seconds', 5, 'recap_seconds', 8, 'total_turns', v_turns * v_players);
  end if;

  if v_players not between 3 and 16 then
    raise exception '% needs 3 to 16 players.',
      case p_kind when 'quiz' then 'Quiz Night' when 'heads_up' then 'Heads Up' else 'Undercover' end
      using errcode = '55000';
  end if;

  insert into public.games (room_id, kind, settings, config) values (p_room_id, p_kind, v_settings, v_config)
  returning * into v_game;
  insert into public.game_players (game_id, member_id, room_id, seat)
  select v_game.id, m.id, p_room_id, row_number() over (order by m.joined_at)
  from public.room_members m where m.room_id = p_room_id and m.left_at is null;
  if p_kind = 'quiz' then
    insert into public.quiz_scores (game_id, room_id, member_id)
    select v_game.id, p_room_id, p.member_id from public.game_players p where p.game_id = v_game.id;
  elsif p_kind = 'heads_up' then
    -- Guessers go in seat order, a fresh start each game; everyone has their turns before anyone's second.
    update public.games
    set turn_order = (select array_agg(p.member_id order by p.seat) from public.game_players p where p.game_id = v_game.id)
    where id = v_game.id
    returning * into v_game;
    perform private.headsup_deal(v_game.id);
  end if;
  update public.rooms set status = 'playing' where id = p_room_id;

  perform private.emit_game_event(v_game, 'game_started', jsonb_build_object('kind', p_kind));
  return v_game;
end;
$$;

-- The end of any game. A quiz or Heads Up ends on its final standings (no team wins; the scores say who did).
create or replace function private.end_game(p_game_id uuid, p_winner text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_reveal jsonb;
begin
  select * into v_game from public.games where id = p_game_id;
  if v_game.kind = 'quiz' then
    select jsonb_build_object('standings', coalesce(jsonb_agg(jsonb_build_object(
             'member_id', member_id, 'points', points, 'correct', correct) order by points desc), '[]'))
    into v_reveal from public.quiz_scores where game_id = p_game_id;
  elsif v_game.kind = 'heads_up' then
    select jsonb_build_object('standings', coalesce(jsonb_agg(jsonb_build_object(
             'member_id', s.member_id, 'got', s.got, 'passed', s.passed) order by s.got desc, s.passed), '[]'))
    into v_reveal
    from (select p.member_id, coalesce(sum(t.got), 0)::int as got, coalesce(sum(t.passed), 0)::int as passed
          from public.game_players p
          left join public.headsup_turns t on t.game_id = p.game_id and t.member_id = p.member_id
          where p.game_id = p_game_id group by p.member_id) s;
    update private.headsup_live set position = null where game_id = p_game_id;
  else
    select jsonb_build_object(
      'words', (select jsonb_build_object('civilian', w.civilian_word, 'undercover', w.undercover_word)
                from private.game_words w where w.game_id = p_game_id),
      'roles', (select coalesce(jsonb_object_agg(s.member_id, s.payload ->> 'role'), '{}')
                from public.secrets s where s.game_id = p_game_id),
      'guesses', (select coalesce(jsonb_agg(jsonb_build_object(
                    'member_id', j.member_id, 'guess', j.guess, 'verdict', j.verdict,
                    'reasoning', j.reasoning, 'overruled', j.overruled) order by j.step), '[]')
                  from private.game_judgements j where j.game_id = p_game_id)
    ) into v_reveal;
  end if;

  update public.games
  set phase = 'ended', winner = p_winner, reveal = v_reveal, ended_at = now(), step = step + 1,
      turn_index = null, turn_deadline = null, phase_deadline = null, paused_at = null
  where id = p_game_id
  returning * into v_game;

  update public.game_players p
  set revealed_role = s.payload ->> 'role'
  from public.secrets s
  where p.game_id = p_game_id and s.game_id = p.game_id and s.member_id = p.member_id and p.revealed_role is null;

  if v_game.kind = 'heads_up' then
    perform private.headsup_send_card(p_game_id);  -- the TVs clear the card
  end if;
  update public.rooms set status = 'lobby' where id = v_game.room_id and status = 'playing';
  perform private.emit_game_event(v_game, 'game_ended', jsonb_build_object('winner', p_winner));
end;
$$;

-- The host skips ahead: a quiz question closes now, or a reveal's wait ends; in Heads Up, the countdown ends (the
-- card goes up now), the turn ends, or the recap's wait ends.
create or replace function public.skip_phase(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.host_game(p_game_id);
begin
  if v_game.paused_at is not null then
    raise exception 'Resume the game first.' using errcode = '55000';
  end if;
  if v_game.phase = 'guess' and v_game.judgement is not null and not (v_game.judgement ->> 'settled')::boolean then
    perform private.settle_judgement(p_game_id);  -- skipping the overrule window agrees with the verdict
  elsif v_game.kind = 'heads_up' and v_game.phase = 'ready' then
    perform private.headsup_begin_guessing(p_game_id);
  elsif v_game.kind = 'heads_up' and v_game.phase = 'guessing' then
    perform private.headsup_end_turn(p_game_id, 'host_skipped');
  elsif (v_game.phase in ('clues', 'discussion', 'vote', 'guess', 'question') and not v_game.resolved)
        or (v_game.phase in ('reveal', 'recap') and v_game.phase_deadline is not null) then
    update public.games set turn_index = null, turn_deadline = null, phase_deadline = null
    where id = p_game_id returning * into v_game;
    perform private.emit_game_event(v_game, 'phase_complete',
                                    jsonb_build_object('phase', v_game.phase, 'reason', 'host_skipped'));
  else
    raise exception 'There''s nothing to skip right now.' using errcode = '55000';
  end if;
  select * into v_game from public.games where id = p_game_id;
  return v_game;
end;
$$;

-- Timers: Heads Up's countdown and buzzer are run here, so a turn's timing never waits on the game master.
create or replace function dispatch.fire_due_deadlines()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_fired int := 0;
begin
  for v_game in
    select g.* from public.games g join public.rooms r on r.id = g.room_id
    where g.phase <> 'ended' and g.paused_at is null and r.status = 'playing'
      and (g.turn_deadline <= now() or g.phase_deadline <= now())
    for update of g skip locked
  loop
    if v_game.turn_deadline <= now() then
      perform private.advance_turn(v_game.id);
    elsif v_game.phase = 'guess' and v_game.judgement is not null then
      perform private.settle_judgement(v_game.id);
    elsif v_game.kind = 'heads_up' and v_game.phase = 'ready' then
      perform private.headsup_begin_guessing(v_game.id);
    elsif v_game.kind = 'heads_up' and v_game.phase = 'guessing' then
      perform private.headsup_end_turn(v_game.id, 'time');
    else
      update public.games set phase_deadline = null where id = v_game.id;
      perform private.emit_game_event(v_game, 'deadline_passed', jsonb_build_object('phase', v_game.phase));
    end if;
    v_fired := v_fired + 1;
  end loop;
  return v_fired;
end;
$$;

-- The host's lines (the narrator's and the AI host's) may not name a secret word: Undercover's words, and in Heads Up
-- every card that isn't public yet (the one on the TV, and the ones still to come).
create or replace function private.live_words_in(p_room_id uuid, p_text text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.game_words w
    join public.games g on g.id = w.game_id and g.phase <> 'ended'
    join content.word_pairs p on p.id = w.pair_id
    cross join lateral unnest(array[p.word_a, p.word_b]) as word
    where w.room_id = p_room_id
      and p_text ~* ('\m' || private.regex_escape(btrim(word)) || '(e?s)?\M')
  ) or exists (
    select 1
    from private.headsup_deck d
    join public.games g on g.id = d.game_id and g.phase <> 'ended'
    left join public.headsup_turns t on t.game_id = d.game_id and t.number = d.turn
    where d.room_id = p_room_id and t.ended_at is null
      and p_text ~* ('\m' || private.regex_escape(btrim(d.card)) || '(e?s)?\M')
  );
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.set_interests(uuid, text[]) from public, anon;
revoke all on function public.headsup_move(uuid, text, int, uuid) from public, anon;
revoke all on function public.headsup_live_card(uuid) from public, anon;
grant execute on function public.set_interests(uuid, text[]) to authenticated;
grant execute on function public.headsup_move(uuid, text, int, uuid) to authenticated;
grant execute on function public.headsup_live_card(uuid) to authenticated;

revoke all on function private.headsup_send_card(uuid) from public, anon, authenticated;
revoke all on function private.headsup_deal(uuid) from public, anon, authenticated;
revoke all on function private.headsup_turn(uuid) from public, anon, authenticated;
revoke all on function private.headsup_next_card(uuid) from public, anon, authenticated;
revoke all on function private.headsup_begin_guessing(uuid) from public, anon, authenticated;
revoke all on function private.headsup_end_turn(uuid, text) from public, anon, authenticated;

revoke all on all functions in schema game_api from public;
grant execute on all functions in schema game_api to game_master_svc;
