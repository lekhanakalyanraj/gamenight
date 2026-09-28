-- Undercover, the first game: game state, private cards, moves, timers and the game master's API.
--
-- Rules this migration adds:
--   * the database deals: the game master picks a word pair and a role mix, Postgres shuffles and deals
--   * a player's card (role and word) is readable only by that player, and sent only on their member:{id} topic
--   * every public row (games, game_players, game_results) is broadcast whole to the room, so none of them
--     ever holds a word, a hidden role, Mr. White's guess or the judge's reasoning while the game is live
--   * players move only through submit_action and the host steers through host controls; the game master
--     acts only through game_api, and every call is idempotent by event id
--   * clue turns advance on their own (a tap or the timer); decisions go to the game master as outbox events
--   * host_say refuses any line containing a live secret word

create type public.game_kind as enum ('undercover');
create type public.game_phase as enum ('setup', 'clues', 'discussion', 'vote', 'guess', 'ended');

-- ---------------------------------------------------------------------------
-- Public game state (members and TVs read it; triggers broadcast it on room:{id})
-- ---------------------------------------------------------------------------

create table public.games (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  kind public.game_kind not null,
  phase public.game_phase not null default 'setup',
  step int not null default 0,              -- bumps whenever a phase opens; moves and events carry it
  round smallint not null default 0,
  settings jsonb not null default '{}',     -- the host's choices: theme, region
  config jsonb not null default '{}',       -- the public setup: role counts, turn length, theme
  turn_order uuid[] not null default '{}',  -- member ids, in speaking order
  turn_index smallint,                      -- the current speaker; null once every clue is in
  turn_deadline timestamptz,
  phase_deadline timestamptz,
  paused_at timestamptz,
  paused_turn_left interval,
  paused_phase_left interval,
  vote_candidates uuid[],                   -- a revote is only between the tied players
  revoted boolean not null default false,   -- one revote per round
  moves_in smallint not null default 0,     -- votes cast this step ("4 of 6 voted"), never who voted
  resolved boolean not null default false,  -- this step's vote or guess is settled
  guesser uuid references public.room_members (id),
  judgement jsonb,                          -- {verdict, overruled, settled}; the reasoning stays private until the end
  winner text check (winner in ('civilians', 'infiltrators', 'mr_white')),
  reveal jsonb,                             -- set at the end: both words, every role, the guesses and the reasoning
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index games_one_live_per_room on public.games (room_id) where phase <> 'ended';
create index games_turn_deadline_idx on public.games (turn_deadline) where turn_deadline is not null;
create index games_phase_deadline_idx on public.games (phase_deadline) where phase_deadline is not null;

create table public.game_players (
  game_id uuid not null references public.games (id) on delete cascade,
  member_id uuid not null references public.room_members (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  seat smallint not null,
  alive boolean not null default true,
  eliminated_round smallint,
  -- Only once the player is voted out, or for everyone when the game ends. The true role is in secrets.
  revealed_role text check (revealed_role in ('civilian', 'undercover', 'mr_white')),
  primary key (game_id, member_id)
);
create index game_players_member_id_idx on public.game_players (member_id);
create index game_players_room_id_idx on public.game_players (room_id);

-- One row per settled vote or guess: public once settled (the TV shows who voted for whom).
create table public.game_results (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  step int not null,
  round smallint not null,
  kind text not null check (kind in ('vote', 'guess')),
  votes jsonb,                               -- {voter member id: target member id}
  eliminated uuid references public.room_members (id),
  revealed_role text check (revealed_role in ('civilian', 'undercover', 'mr_white')),
  tie boolean not null default false,
  tied uuid[],
  verdict boolean,                           -- a guess: right or wrong, never the guess itself
  overruled boolean,
  created_at timestamptz not null default now(),
  unique (game_id, step)
);
create index game_results_room_id_idx on public.game_results (room_id);

-- ---------------------------------------------------------------------------
-- Private to one player: their card, and their own moves
-- ---------------------------------------------------------------------------

create table public.secrets (
  game_id uuid not null references public.games (id) on delete cascade,
  member_id uuid not null references public.room_members (id) on delete cascade,
  kind text not null check (kind in ('undercover_card')),
  payload jsonb not null,                    -- {"role": "civilian", "word": "chai"}; Mr. White's card has no word
  created_at timestamptz not null default now(),
  primary key (game_id, member_id)
);
create index secrets_member_id_idx on public.secrets (member_id);

create table public.game_actions (
  id uuid primary key,                       -- chosen by the phone, so a retried tap is the same move
  game_id uuid not null references public.games (id) on delete cascade,
  member_id uuid not null references public.room_members (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  step int not null,
  round smallint not null,
  kind text not null check (kind in ('done', 'vote', 'guess')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (game_id, step, member_id)          -- one move per player per step: one vote, one guess, one "done"
);
create index game_actions_member_id_idx on public.game_actions (member_id);
create index game_actions_room_id_idx on public.game_actions (room_id);

-- ---------------------------------------------------------------------------
-- The content bank: word pairs. No client can read it, or players could guess the room's pair.
-- ---------------------------------------------------------------------------

create schema content;
revoke all on schema content from public;

create table content.word_pairs (
  id uuid primary key default gen_random_uuid(),
  theme text not null check (char_length(theme) between 1 and 30),
  rating public.age_rating not null default 'family',
  region text check (region ~ '^[A-Z]{2}$'),  -- null: known everywhere
  word_a text not null check (char_length(btrim(word_a)) between 1 and 30),
  word_b text not null check (char_length(btrim(word_b)) between 1 and 30),
  source text not null default 'seed' check (source in ('seed', 'generated')),
  status text not null default 'approved' check (status in ('approved', 'retired')),
  created_at timestamptz not null default now(),
  check (lower(word_a) <> lower(word_b))
);
create unique index word_pairs_words_uq on content.word_pairs (least(lower(word_a), lower(word_b)), greatest(lower(word_a), lower(word_b)));
alter table content.word_pairs enable row level security;

-- Hand-checked starters: close but distinct, family-safe. The content specialist adds generated pairs.
insert into content.word_pairs (theme, region, word_a, word_b) values
  ('food', null, 'pizza', 'burger'), ('food', null, 'pancake', 'waffle'), ('food', null, 'noodles', 'spaghetti'),
  ('food', null, 'cupcake', 'muffin'), ('food', null, 'ketchup', 'mustard'), ('food', null, 'honey', 'jam'),
  ('drinks', null, 'coffee', 'tea'), ('drinks', null, 'milkshake', 'smoothie'), ('drinks', null, 'lemonade', 'orange juice'),
  ('animals', null, 'lion', 'tiger'), ('animals', null, 'dolphin', 'shark'), ('animals', null, 'crocodile', 'alligator'),
  ('animals', null, 'owl', 'eagle'), ('animals', null, 'rabbit', 'hamster'),
  ('places', null, 'beach', 'swimming pool'), ('places', null, 'library', 'bookshop'), ('places', null, 'airport', 'train station'),
  ('sports', null, 'football', 'rugby'), ('sports', null, 'tennis', 'badminton'), ('sports', null, 'chess', 'checkers'),
  ('movies', null, 'Batman', 'Superman'), ('movies', null, 'cinema', 'theatre'), ('music', null, 'piano', 'guitar'),
  ('home', null, 'pillow', 'cushion'), ('home', null, 'fork', 'spoon'), ('home', null, 'shampoo', 'soap'),
  ('travel', null, 'suitcase', 'backpack'), ('travel', null, 'hotel', 'hostel'),
  ('office', null, 'email', 'text message'), ('office', null, 'stapler', 'paper clip'),
  ('school', null, 'teacher', 'principal'), ('school', null, 'homework', 'exam'),
  ('food', 'IN', 'dosa', 'idli'), ('food', 'IN', 'samosa', 'pakora'), ('drinks', 'IN', 'chai', 'filter coffee'),
  ('travel', 'IN', 'auto-rickshaw', 'taxi'), ('movies', 'IN', 'Bollywood', 'Tollywood'), ('festivals', 'IN', 'Diwali', 'Holi'),
  ('food', 'GB', 'crumpet', 'scone'), ('travel', 'GB', 'the Tube', 'double-decker bus'),
  ('food', 'US', 'hot dog', 'corn dog'), ('festivals', 'US', 'Thanksgiving', 'Christmas');

-- ---------------------------------------------------------------------------
-- Internal: the dealt words, guesses and judgements, and which game-master calls were applied
-- ---------------------------------------------------------------------------

create table private.game_words (
  game_id uuid primary key references public.games (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  pair_id uuid not null references content.word_pairs (id),
  civilian_word text,                        -- set by the deal (which word goes to which side is random)
  undercover_word text,
  created_at timestamptz not null default now()
);
create index game_words_room_id_idx on private.game_words (room_id, created_at);
alter table private.game_words enable row level security;

create table private.game_judgements (
  game_id uuid not null references public.games (id) on delete cascade,
  step int not null,
  member_id uuid not null references public.room_members (id) on delete cascade,
  guess text,
  verdict boolean,
  reasoning text,
  overruled boolean not null default false,
  primary key (game_id, step)
);
alter table private.game_judgements enable row level security;

create table private.game_event_applications (
  event_id uuid not null,
  fn text not null,
  game_id uuid not null references public.games (id) on delete cascade,
  result jsonb not null,
  applied_at timestamptz not null default now(),
  primary key (event_id, fn)
);
alter table private.game_event_applications enable row level security;

-- ---------------------------------------------------------------------------
-- The outbox learns the game's events
-- ---------------------------------------------------------------------------

alter table dispatch.events drop constraint events_kind_check;
alter table dispatch.events add constraint events_kind_check
  check (kind in ('member_joined', 'game_started', 'phase_complete', 'deadline_passed', 'game_ended'));

alter table public.host_lines drop constraint host_lines_kind_check;
alter table public.host_lines add constraint host_lines_kind_check
  check (kind in ('welcome', 'announce', 'narration'));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Whether the signed-in user is this room member (their own card, their own moves, their own topic).
create function private.owns_member(p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members m where m.id = p_member_id and m.user_id = (select auth.uid())
  );
$$;

-- Topics: room:{id} for members and the room's TVs, display:{user} for a TV itself, member:{id} for one player.
create or replace function private.can_access_topic(p_topic text)
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
  elsif p_topic ~ '^member:[0-9a-f-]{36}$' then
    return private.owns_member(substr(p_topic, 8)::uuid);
  end if;
  return false;
end;
$$;

-- Writes a game event to the outbox, with the step it belongs to (so a late event is recognised as
-- stale) and the request's traceparent, then wakes the dispatcher.
create function private.emit_game_event(p_game public.games, p_kind text, p_payload jsonb default '{}')
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
  perform pg_notify('dispatch_events', p_game.room_id::text);
end;
$$;

create function private.card_role(p_game_id uuid, p_member_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.payload ->> 'role' from public.secrets s where s.game_id = p_game_id and s.member_id = p_member_id;
$$;

-- The legal role mixes: at least one undercover, civilians outnumbering the infiltrators, Mr. White
-- from 5 players and two of them from 10.
create function private.undercover_mix_ok(p_players int, p_undercovers int, p_mr_whites int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_undercovers >= 1
     and p_mr_whites between 0 and (case when p_players >= 10 then 2 when p_players >= 5 then 1 else 0 end)
     and p_players - p_undercovers - p_mr_whites > p_undercovers + p_mr_whites;
$$;

-- Who has won, if anyone: civilians when no infiltrator is left, infiltrators when one civilian is left.
create function private.undercover_winner(p_game_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when count(*) filter (where s.payload ->> 'role' <> 'civilian') = 0 then 'civilians'
    when count(*) filter (where s.payload ->> 'role' = 'civilian') <= 1 then 'infiltrators'
  end
  from public.game_players p
  join public.secrets s on s.game_id = p.game_id and s.member_id = p.member_id
  where p.game_id = p_game_id and p.alive;
$$;

-- Ends a game and reveals everything. The games row changes first, so on the room topic the "ended"
-- message arrives before the roles of players still alive.
create function private.end_game(p_game_id uuid, p_winner text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_reveal jsonb;
begin
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

  update public.games
  set phase = 'ended', winner = p_winner, reveal = v_reveal, ended_at = now(), step = step + 1,
      turn_index = null, turn_deadline = null, phase_deadline = null, paused_at = null
  where id = p_game_id
  returning * into v_game;

  update public.game_players p
  set revealed_role = s.payload ->> 'role'
  from public.secrets s
  where p.game_id = p_game_id and s.game_id = p.game_id and s.member_id = p.member_id and p.revealed_role is null;

  update public.rooms set status = 'lobby' where id = v_game.room_id and status = 'playing';
  perform private.emit_game_event(v_game, 'game_ended', jsonb_build_object('winner', p_winner));
end;
$$;

-- The next speaker, or, after the last clue, tell the game master that the clues are in.
create function private.advance_turn(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  select * into v_game from public.games where id = p_game_id;
  if v_game.turn_index + 1 >= cardinality(v_game.turn_order) then
    update public.games set turn_index = null, turn_deadline = null where id = p_game_id returning * into v_game;
    perform private.emit_game_event(v_game, 'phase_complete', jsonb_build_object('phase', 'clues'));
  else
    update public.games
    set turn_index = turn_index + 1,
        turn_deadline = now() + make_interval(secs => (config ->> 'turn_seconds')::int)
    where id = p_game_id;
  end if;
end;
$$;

-- Applies the game master's verdict on Mr. White's guess, once the host has agreed, overruled it, or
-- let the 10-second window pass.
create function private.settle_judgement(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_verdict boolean;
  v_winner text;
begin
  select * into v_game from public.games where id = p_game_id;
  v_verdict := (v_game.judgement ->> 'verdict')::boolean;

  update private.game_judgements
  set verdict = v_verdict, overruled = (v_game.judgement ->> 'overruled')::boolean
  where game_id = p_game_id and step = v_game.step;
  insert into public.game_results (game_id, room_id, step, round, kind, eliminated, revealed_role, verdict, overruled)
  values (v_game.id, v_game.room_id, v_game.step, v_game.round, 'guess', v_game.guesser, 'mr_white', v_verdict,
          (v_game.judgement ->> 'overruled')::boolean);

  update public.games
  set judgement = judgement || '{"settled": true}', resolved = true, phase_deadline = null
  where id = p_game_id
  returning * into v_game;

  if v_verdict then
    perform private.end_game(p_game_id, 'mr_white');
    return;
  end if;
  v_winner := private.undercover_winner(p_game_id);
  if v_winner is not null then
    perform private.end_game(p_game_id, v_winner);
  else
    perform private.emit_game_event(v_game, 'phase_complete', jsonb_build_object('phase', 'guess', 'verdict', false));
  end if;
end;
$$;

-- Postgres regular expressions: escape a word so it matches literally.
create function private.regex_escape(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p_text, '([!$()*+.:<=>?[\\\]^{|}-])', '\\\1', 'g');
$$;

-- Any live game's words in this room that the text contains, as whole words (plurals too).
create function private.live_words_in(p_room_id uuid, p_text text)
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
  );
$$;

-- The room's host, and the game locked for the change.
create function private.host_game(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  select g.* into v_game from public.games g join public.rooms r on r.id = g.room_id
  where g.id = p_game_id and r.host_id = (select auth.uid())
  for update of g;
  if not found then
    raise exception 'Only the host can do that.' using errcode = '42501';
  end if;
  if v_game.phase = 'ended' then
    raise exception 'This game is over.' using errcode = '55000';
  end if;
  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.game_results enable row level security;
alter table public.secrets enable row level security;
alter table public.game_actions enable row level security;

create policy "members and displays read a room's games" on public.games
  for select to authenticated using (private.can_view_room(room_id));
create policy "members and displays read a game's players" on public.game_players
  for select to authenticated using (private.can_view_room(room_id));
create policy "members and displays read settled votes and guesses" on public.game_results
  for select to authenticated using (private.can_view_room(room_id));
create policy "a player reads only their own card" on public.secrets
  for select to authenticated using (private.owns_member(member_id));
create policy "a player reads only their own moves" on public.game_actions
  for select to authenticated using (private.owns_member(member_id));

-- ---------------------------------------------------------------------------
-- Realtime: public game state on room:{id}; a player's card and move receipts on member:{id}
-- ---------------------------------------------------------------------------

create function private.broadcast_game_change()
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

create function private.broadcast_to_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'member:' || new.member_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null
  );
  return null;
end;
$$;

create trigger games_broadcast after insert or update on public.games
  for each row execute function private.broadcast_game_change();
create trigger game_players_broadcast after insert or update on public.game_players
  for each row execute function private.broadcast_game_change();
create trigger game_results_broadcast after insert on public.game_results
  for each row execute function private.broadcast_game_change();
create trigger secrets_broadcast after insert on public.secrets
  for each row execute function private.broadcast_to_member();
create trigger game_actions_broadcast after insert on public.game_actions
  for each row execute function private.broadcast_to_member();

-- Closing the room ends its game.
create function private.end_game_when_room_closes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game_id uuid;
begin
  select id into v_game_id from public.games where room_id = new.id and phase <> 'ended' for update;
  if found then
    perform private.end_game(v_game_id, null);
  end if;
  return null;
end;
$$;

create trigger rooms_end_game_on_close
  after update of status on public.rooms
  for each row when (new.status = 'closed' and old.status <> 'closed')
  execute function private.end_game_when_room_closes();

-- ---------------------------------------------------------------------------
-- Player and host RPCs
-- ---------------------------------------------------------------------------

-- The host starts a game with everyone in the lobby (3 to 16 players, the host included).
-- p_settings: {"theme": "food", "region": "IN"}, both optional.
create function public.start_game(p_room_id uuid, p_kind public.game_kind, p_settings jsonb default '{}')
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
  if not found or v_room.host_id is distinct from (select auth.uid()) then
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

-- A player's move: 'done' (my clue is said), 'vote' ({"target": member id}) or 'guess' ({"text": ...}).
-- p_action_id comes from the phone, so a retried tap returns the first result instead of acting twice.
create function public.submit_action(p_game_id uuid, p_kind text, p_payload jsonb, p_action_id uuid)
returns public.game_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_member uuid;
  v_alive boolean;
  v_action public.game_actions;
  v_target uuid;
  v_text text;
  v_payload jsonb := '{}';
  v_voters int;
begin
  select * into v_action from public.game_actions where id = p_action_id;
  if found then
    if not private.owns_member(v_action.member_id) then
      raise exception 'That move belongs to someone else.' using errcode = '42501';
    end if;
    return v_action;
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  select p.member_id, p.alive into v_member, v_alive
  from public.game_players p join public.room_members m on m.id = p.member_id
  where p.game_id = p_game_id and m.user_id = (select auth.uid());
  if v_member is null then
    raise exception 'You''re not in this game.' using errcode = '42501';
  end if;
  if v_game.phase = 'ended' then
    raise exception 'This game is over.' using errcode = '55000';
  end if;
  if v_game.paused_at is not null then
    raise exception 'The game is paused.' using errcode = '55000';
  end if;

  if p_kind = 'done' then
    if v_game.phase <> 'clues' or v_game.turn_index is null or v_game.turn_order[v_game.turn_index + 1] <> v_member then
      raise exception 'It''s not your turn.' using errcode = '55000';
    end if;
  elsif p_kind = 'vote' then
    if v_game.phase <> 'vote' or v_game.resolved then
      raise exception 'Voting isn''t open.' using errcode = '55000';
    end if;
    if not v_alive then
      raise exception 'You''re out of this game, so you can''t vote.' using errcode = '55000';
    end if;
    begin
      v_target := (p_payload ->> 'target')::uuid;
    exception when invalid_text_representation then
      v_target := null;
    end;
    if v_target is null or v_target = v_member
       or not exists (select 1 from public.game_players p where p.game_id = p_game_id and p.member_id = v_target and p.alive)
       or (v_game.vote_candidates is not null and not v_target = any (v_game.vote_candidates)) then
      raise exception 'Vote for another player who''s still in.' using errcode = '22023';
    end if;
    v_payload := jsonb_build_object('target', v_target);
  elsif p_kind = 'guess' then
    if v_game.phase <> 'guess' or v_game.guesser is distinct from v_member or v_game.judgement is not null then
      raise exception 'Only Mr. White guesses, once, after being voted out.' using errcode = '55000';
    end if;
    v_text := btrim(coalesce(p_payload ->> 'text', ''));
    if char_length(v_text) not between 1 and 40 then
      raise exception 'Guess a word of up to 40 characters.' using errcode = '22023';
    end if;
    v_payload := jsonb_build_object('text', v_text);
  else
    raise exception 'Unknown move %.', p_kind using errcode = '22023';
  end if;

  begin
    insert into public.game_actions (id, game_id, member_id, room_id, step, round, kind, payload)
    values (p_action_id, p_game_id, v_member, v_game.room_id, v_game.step, v_game.round, p_kind, v_payload)
    returning * into v_action;
  exception when unique_violation then
    -- The same tap, retried while the first was still being applied: return the first.
    select * into v_action from public.game_actions where id = p_action_id and member_id = v_member;
    if found then
      return v_action;
    end if;
    raise exception 'You''ve already made your move.' using errcode = '23505';
  end;

  if p_kind = 'done' then
    perform private.advance_turn(p_game_id);
  elsif p_kind = 'vote' then
    update public.games set moves_in = moves_in + 1 where id = p_game_id returning * into v_game;
    -- Everyone still in and still in the room has voted (someone who left can't hold the vote up).
    select count(*) into v_voters
    from public.game_players p join public.room_members m on m.id = p.member_id
    where p.game_id = p_game_id and p.alive and m.left_at is null;
    if v_game.moves_in >= v_voters then
      update public.games set phase_deadline = null where id = p_game_id;
      perform private.emit_game_event(v_game, 'phase_complete', jsonb_build_object('phase', 'vote'));
    end if;
  else
    insert into private.game_judgements (game_id, step, member_id, guess) values (p_game_id, v_game.step, v_member, v_text);
    update public.games set phase_deadline = null where id = p_game_id;
    perform private.emit_game_event(v_game, 'phase_complete', jsonb_build_object('phase', 'guess'));
  end if;
  return v_action;
end;
$$;

-- Host controls: pause, resume, extend the timer, skip the speaker, skip the phase, settle the judge's
-- verdict (agree or overrule), end the game.

create function public.pause_game(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.host_game(p_game_id);
begin
  if v_game.paused_at is null then
    update public.games
    set paused_at = now(),
        paused_turn_left = turn_deadline - now(), paused_phase_left = phase_deadline - now(),
        turn_deadline = null, phase_deadline = null
    where id = p_game_id
    returning * into v_game;
  end if;
  return v_game;
end;
$$;

create function public.resume_game(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.host_game(p_game_id);
begin
  if v_game.paused_at is not null then
    update public.games
    set paused_at = null,
        -- At least 5 seconds back on any clock that was running; none where none was.
        turn_deadline = case when paused_turn_left is not null
                             then now() + greatest(paused_turn_left, interval '5 seconds') end,
        phase_deadline = case when paused_phase_left is not null
                              then now() + greatest(paused_phase_left, interval '5 seconds') end,
        paused_turn_left = null, paused_phase_left = null
    where id = p_game_id
    returning * into v_game;
  end if;
  return v_game;
end;
$$;

create function public.extend_phase(p_game_id uuid, p_seconds int default 30)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.host_game(p_game_id);
begin
  if p_seconds not between 10 and 120 then
    raise exception 'Extend by 10 to 120 seconds.' using errcode = '22023';
  end if;
  if coalesce(v_game.phase_deadline, v_game.paused_at + v_game.paused_phase_left) is null then
    raise exception 'There''s no timer to extend right now.' using errcode = '55000';
  end if;
  update public.games
  set phase_deadline = phase_deadline + make_interval(secs => p_seconds),
      paused_phase_left = paused_phase_left + make_interval(secs => p_seconds)
  where id = p_game_id
  returning * into v_game;
  return v_game;
end;
$$;

create function public.skip_turn(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.host_game(p_game_id);
begin
  if v_game.phase <> 'clues' or v_game.turn_index is null or v_game.paused_at is not null then
    raise exception 'There''s no speaker to skip.' using errcode = '55000';
  end if;
  perform private.advance_turn(p_game_id);
  select * into v_game from public.games where id = p_game_id;
  return v_game;
end;
$$;

-- Ends the current phase now; the game master decides what comes next, as when its timer runs out.
create function public.skip_phase(p_game_id uuid)
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
  elsif v_game.phase in ('clues', 'discussion', 'vote', 'guess') and not v_game.resolved then
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

-- The host agrees with the judge on Mr. White's guess, or overrules it. Either way it applies now.
create function public.settle_judgement(p_game_id uuid, p_overrule boolean default false)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.host_game(p_game_id);
begin
  if v_game.phase <> 'guess' or v_game.judgement is null or (v_game.judgement ->> 'settled')::boolean then
    raise exception 'There''s no verdict waiting.' using errcode = '55000';
  end if;
  if p_overrule then
    update public.games
    set judgement = judgement || jsonb_build_object('verdict', not (judgement ->> 'verdict')::boolean, 'overruled', true)
    where id = p_game_id;
  end if;
  perform private.settle_judgement(p_game_id);
  select * into v_game from public.games where id = p_game_id;
  return v_game;
end;
$$;

create function public.end_game(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.host_game(p_game_id);
begin
  perform private.end_game(p_game_id, null);
  select * into v_game from public.games where id = p_game_id;
  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- The game master's API (only game_master_svc can use it)
-- ---------------------------------------------------------------------------

create role game_master_svc nologin;
create schema game_api;
revoke all on schema game_api from public;
grant usage on schema game_api to game_master_svc;

-- Every mutating call names the event it's handling. A repeated call for the same event returns the
-- first result and changes nothing, so a redelivered event or a retried run is safe.
create function private.applied(p_event_id uuid, p_fn text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select result from private.game_event_applications where event_id = p_event_id and fn = p_fn;
$$;

create function private.record_applied(p_event_id uuid, p_fn text, p_game_id uuid, p_result jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  insert into private.game_event_applications (event_id, fn, game_id, result) values (p_event_id, p_fn, p_game_id, p_result);
  select p_result;
$$;

-- Locks the game for a game-master call; errors if it's over or paused.
create function private.gm_game(p_game_id uuid, p_event_id uuid)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
begin
  if p_event_id is null then
    raise exception 'Every game-master call needs the event id it handles.' using errcode = '22023';
  end if;
  select * into v_game from public.games where id = p_game_id for update;
  if not found then
    raise exception 'No game %.', p_game_id using errcode = 'P0002';
  end if;
  return v_game;
end;
$$;

-- Everything the game master may know, including every card (it's trusted like a human narrator).
create function game_api.get_game_state(p_game_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'game', jsonb_build_object(
      'id', g.id, 'room_id', g.room_id, 'kind', g.kind, 'phase', g.phase, 'step', g.step, 'round', g.round,
      'settings', g.settings, 'config', g.config, 'turn_order', to_jsonb(g.turn_order), 'turn_index', g.turn_index,
      'turn_deadline', g.turn_deadline, 'phase_deadline', g.phase_deadline, 'paused', g.paused_at is not null,
      'vote_candidates', to_jsonb(g.vote_candidates), 'revoted', g.revoted, 'moves_in', g.moves_in,
      'resolved', g.resolved, 'guesser', g.guesser, 'judgement', g.judgement, 'winner', g.winner
    ),
    'age_rating', r.age_rating,
    'words', (select jsonb_build_object('civilian', w.civilian_word, 'undercover', w.undercover_word, 'pair_id', w.pair_id)
              from private.game_words w where w.game_id = g.id),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'member_id', p.member_id, 'nickname', m.nickname, 'seat', p.seat, 'alive', p.alive,
                  'in_room', m.left_at is null, 'role', s.payload ->> 'role', 'word', s.payload ->> 'word',
                  'revealed_role', p.revealed_role) order by p.seat), '[]')
                from public.game_players p
                join public.room_members m on m.id = p.member_id
                left join public.secrets s on s.game_id = p.game_id and s.member_id = p.member_id
                where p.game_id = g.id),
    'votes', (select coalesce(jsonb_object_agg(a.member_id, a.payload ->> 'target'), '{}')
              from public.game_actions a where a.game_id = g.id and a.step = g.step and a.kind = 'vote'),
    'guess', (select j.guess from private.game_judgements j where j.game_id = g.id and j.step = g.step),
    'results', (select coalesce(jsonb_agg(to_jsonb(x) - 'room_id' order by x.step), '[]')
                from public.game_results x where x.game_id = g.id)
  )
  from public.games g join public.rooms r on r.id = g.room_id
  where g.id = p_game_id;
$$;

-- Approved pairs that fit the room's rating and region and haven't been played in this room in the
-- last 12 hours, optionally for one theme.
create function game_api.word_pairs(p_game_id uuid, p_theme text default null, p_limit int default 10)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'theme', c.theme, 'rating', c.rating, 'region', c.region, 'word_a', c.word_a, 'word_b', c.word_b)), '[]')
  from (
    select p.* from content.word_pairs p
    join public.games g on g.id = p_game_id
    join public.rooms r on r.id = g.room_id
    where p.status = 'approved'
      and p.rating <= r.age_rating
      and (p.region is null or p.region = g.settings ->> 'region')
      and (p_theme is null or lower(p.theme) = lower(btrim(p_theme)))
      and not exists (select 1 from private.game_words w
                      where w.room_id = g.room_id and w.pair_id = p.id and w.created_at > now() - interval '12 hours')
    order by random()
    limit least(greatest(p_limit, 1), 50)
  ) c;
$$;

-- The content specialist saves a pair it generated and checked. Returns the pair's id (the existing
-- one if the bank already has these two words).
create function game_api.save_word_pair(
  p_theme text, p_rating public.age_rating, p_region text, p_word_a text, p_word_b text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a text := btrim(p_word_a);
  v_b text := btrim(p_word_b);
  v_id uuid;
begin
  if position(lower(v_a) in lower(v_b)) > 0 or position(lower(v_b) in lower(v_a)) > 0 then
    raise exception 'The two words must be different words, not one inside the other.' using errcode = '22023';
  end if;
  select id into v_id from content.word_pairs
  where least(lower(word_a), lower(word_b)) = least(lower(v_a), lower(v_b))
    and greatest(lower(word_a), lower(word_b)) = greatest(lower(v_a), lower(v_b));
  if found then
    return v_id;
  end if;
  insert into content.word_pairs (theme, rating, region, word_a, word_b, source)
  values (lower(btrim(p_theme)), p_rating, p_region, v_a, v_b, 'generated')
  returning id into v_id;
  return v_id;
end;
$$;

-- The game master's setup: a pair from the bank, a role mix and the clue-turn length (10-30 seconds).
-- It can change its mind until the deal.
create function game_api.gm_setup(
  p_game_id uuid, p_pair_id uuid, p_undercovers int, p_mr_whites int, p_turn_seconds int, p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.gm_game(p_game_id, p_event_id);
  v_prev jsonb := private.applied(p_event_id, 'gm_setup');
  v_players int;
  v_pair content.word_pairs;
  v_config jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if v_game.phase <> 'setup' or exists (
       select 1 from private.game_words where game_id = p_game_id and civilian_word is not null) then
    raise exception 'Setup is over: the cards are dealt.' using errcode = '55000';
  end if;
  select count(*) into v_players from public.game_players where game_id = p_game_id;
  if not private.undercover_mix_ok(v_players, p_undercovers, p_mr_whites) then
    raise exception '% undercover and % Mr. White don''t fit % players: at least 1 undercover, civilians must outnumber them, Mr. White from 5 players (2 from 10).',
      p_undercovers, p_mr_whites, v_players using errcode = '22023';
  end if;
  if p_turn_seconds not between 10 and 30 then
    raise exception 'Clue turns last 10 to 30 seconds.' using errcode = '22023';
  end if;

  select p.* into v_pair
  from content.word_pairs p join public.rooms r on r.id = v_game.room_id
  where p.id = p_pair_id and p.status = 'approved' and p.rating <= r.age_rating
    and (p.region is null or p.region = v_game.settings ->> 'region');
  if not found then
    raise exception 'That pair isn''t in the bank for this room''s rating and region.' using errcode = '22023';
  end if;
  if exists (select 1 from private.game_words w
             where w.room_id = v_game.room_id and w.pair_id = p_pair_id and w.game_id <> p_game_id
               and w.created_at > now() - interval '12 hours') then
    raise exception 'This room already played that pair tonight.' using errcode = '22023';
  end if;

  insert into private.game_words (game_id, room_id, pair_id) values (p_game_id, v_game.room_id, p_pair_id)
  on conflict (game_id) do update set pair_id = excluded.pair_id;
  v_config := jsonb_build_object(
    'civilians', v_players - p_undercovers - p_mr_whites, 'undercovers', p_undercovers, 'mr_whites', p_mr_whites,
    'turn_seconds', p_turn_seconds, 'theme', v_pair.theme);
  update public.games set config = v_config where id = p_game_id;
  return private.record_applied(p_event_id, 'gm_setup', p_game_id, jsonb_build_object('config', v_config));
end;
$$;

-- Deals the cards: which word is the civilians' is a coin flip, and who gets which role is a shuffle,
-- both from Postgres's strong random source. The game master learns the result only afterwards.
create function game_api.gm_deal(p_game_id uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.gm_game(p_game_id, p_event_id);
  v_prev jsonb := private.applied(p_event_id, 'gm_deal');
  v_words private.game_words;
  v_pair content.word_pairs;
  v_civilian text;
  v_undercover text;
  v_undercovers int := (v_game.config ->> 'undercovers')::int;
  v_mr_whites int := (v_game.config ->> 'mr_whites')::int;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  select * into v_words from private.game_words where game_id = p_game_id;
  if v_game.phase <> 'setup' or not found or v_words.civilian_word is not null then
    raise exception 'Deal once, after setup.' using errcode = '55000';
  end if;
  select * into v_pair from content.word_pairs where id = v_words.pair_id;
  if get_byte(extensions.gen_random_bytes(1), 0) % 2 = 0 then
    v_civilian := v_pair.word_a; v_undercover := v_pair.word_b;
  else
    v_civilian := v_pair.word_b; v_undercover := v_pair.word_a;
  end if;

  insert into public.secrets (game_id, member_id, kind, payload)
  select p_game_id, s.member_id, 'undercover_card',
         case when s.n <= v_mr_whites then jsonb_build_object('role', 'mr_white')
              when s.n <= v_mr_whites + v_undercovers then jsonb_build_object('role', 'undercover', 'word', v_undercover)
              else jsonb_build_object('role', 'civilian', 'word', v_civilian) end
  from (select member_id, row_number() over (order by gen_random_uuid()) as n
        from public.game_players where game_id = p_game_id) s;
  update private.game_words set civilian_word = v_civilian, undercover_word = v_undercover where game_id = p_game_id;

  return private.record_applied(p_event_id, 'gm_deal', p_game_id,
    jsonb_build_object('dealt', true, 'players', (select count(*) from public.game_players where game_id = p_game_id)));
end;
$$;

-- Opens the next phase. The legal moves:
--   clues:      after the deal, after a settled vote or a wrong guess (a new round). p_turn_order is a
--               permutation of the players still in, or null for seat order; Mr. White never goes first
--   discussion: once every clue is in, for 30-180 seconds
--   vote:       from discussion (it can end early), or a revote between the tied players after a tie,
--               once per round, for 20-90 seconds
create function game_api.gm_open_phase(
  p_game_id uuid, p_phase public.game_phase, p_seconds int, p_event_id uuid,
  p_turn_order uuid[] default null, p_candidates uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.gm_game(p_game_id, p_event_id);
  v_prev jsonb := private.applied(p_event_id, 'gm_open_phase');
  v_alive uuid[];
  v_order uuid[];
  v_last public.game_results;
  i int := 0;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if v_game.phase = 'ended' then
    raise exception 'This game is over.' using errcode = '55000';
  end if;
  if v_game.paused_at is not null then
    raise exception 'The host has paused the game.' using errcode = '55000';
  end if;
  select array_agg(member_id order by seat) into v_alive from public.game_players where game_id = p_game_id and alive;
  select * into v_last from public.game_results where game_id = p_game_id and step = v_game.step;

  if p_phase = 'clues' then
    if not ((v_game.phase = 'setup' and exists (select 1 from private.game_words where game_id = p_game_id and civilian_word is not null))
            or (v_game.phase in ('vote', 'guess') and v_game.resolved)) then
      raise exception 'A new round of clues starts after the deal, a settled vote or a wrong guess.' using errcode = '55000';
    end if;
    if p_turn_order is null then
      v_order := v_alive[(v_game.round % cardinality(v_alive)) + 1:] || v_alive[:(v_game.round % cardinality(v_alive))];
    elsif cardinality(p_turn_order) <> cardinality(v_alive)
          or (select count(distinct x) from unnest(p_turn_order) x) <> cardinality(v_alive)
          or not p_turn_order <@ v_alive then
      raise exception 'The turn order must list every player still in, once each.' using errcode = '22023';
    else
      v_order := p_turn_order;
    end if;
    while private.card_role(p_game_id, v_order[1]) = 'mr_white' and i < cardinality(v_order) loop
      v_order := v_order[2:] || v_order[1:1];
      i := i + 1;
    end loop;
    update public.games
    set phase = 'clues', step = step + 1, round = round + 1, turn_order = v_order, turn_index = 0,
        turn_deadline = now() + make_interval(secs => (config ->> 'turn_seconds')::int), phase_deadline = null,
        vote_candidates = null, revoted = false, moves_in = 0, resolved = false, guesser = null, judgement = null
    where id = p_game_id returning * into v_game;

  elsif p_phase = 'discussion' then
    if v_game.phase <> 'clues' or v_game.turn_index is not null then
      raise exception 'Discussion opens once every clue is in.' using errcode = '55000';
    end if;
    if p_seconds not between 30 and 180 then
      raise exception 'Discussion lasts 30 to 180 seconds.' using errcode = '22023';
    end if;
    update public.games
    set phase = 'discussion', step = step + 1, phase_deadline = now() + make_interval(secs => p_seconds)
    where id = p_game_id returning * into v_game;

  elsif p_phase = 'vote' then
    if p_seconds not between 20 and 90 then
      raise exception 'Voting lasts 20 to 90 seconds.' using errcode = '22023';
    end if;
    if v_game.phase = 'discussion' then
      if p_candidates is not null then
        raise exception 'The first vote of a round is open to everyone still in.' using errcode = '22023';
      end if;
    elsif v_game.phase = 'vote' and v_game.resolved and v_last.tie and not v_game.revoted then
      if p_candidates is null or cardinality(p_candidates) < 2 or not p_candidates <@ v_last.tied then
        raise exception 'A revote is between two or more of the tied players.' using errcode = '22023';
      end if;
    else
      raise exception 'Voting opens after discussion, or once as a revote after a tie.' using errcode = '55000';
    end if;
    update public.games
    set phase = 'vote', step = step + 1, phase_deadline = now() + make_interval(secs => p_seconds),
        vote_candidates = p_candidates, revoted = revoted or p_candidates is not null, moves_in = 0, resolved = false
    where id = p_game_id returning * into v_game;

  else
    raise exception 'The game master opens clues, discussion or vote; the database handles the rest.' using errcode = '22023';
  end if;

  return private.record_applied(p_event_id, 'gm_open_phase', p_game_id, jsonb_build_object(
    'phase', v_game.phase, 'step', v_game.step, 'round', v_game.round,
    'turn_order', to_jsonb(v_game.turn_order), 'phase_deadline', v_game.phase_deadline));
end;
$$;

-- Counts the votes. One top name: they're out and their role is shown; if that's Mr. White, they get
-- to guess. A tie (or no votes): the game master picks from the options, a revote or no elimination.
create function game_api.gm_resolve_vote(p_game_id uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.gm_game(p_game_id, p_event_id);
  v_prev jsonb := private.applied(p_event_id, 'gm_resolve_vote');
  v_votes jsonb;
  v_top uuid[];
  v_out uuid;
  v_role text;
  v_winner text;
  v_result jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if v_game.phase <> 'vote' or v_game.resolved then
    raise exception 'There''s no open vote to count.' using errcode = '55000';
  end if;

  select coalesce(jsonb_object_agg(member_id, payload ->> 'target'), '{}') into v_votes
  from public.game_actions where game_id = p_game_id and step = v_game.step and kind = 'vote';
  select array_agg(target) into v_top from (
    select (payload ->> 'target')::uuid as target, count(*) as n, max(count(*)) over () as top
    from public.game_actions where game_id = p_game_id and step = v_game.step and kind = 'vote'
    group by 1
  ) t where n = top;

  if v_top is null or cardinality(v_top) > 1 then
    insert into public.game_results (game_id, room_id, step, round, kind, votes, tie, tied)
    values (p_game_id, v_game.room_id, v_game.step, v_game.round, 'vote', v_votes, true, v_top);
    update public.games set resolved = true, phase_deadline = null where id = p_game_id;
    v_result := jsonb_build_object('tie', true, 'tied', to_jsonb(coalesce(v_top, '{}')), 'votes', v_votes,
      'options', case when not v_game.revoted and cardinality(v_top) >= 2
                      then '["revote", "no_elimination"]'::jsonb else '["no_elimination"]'::jsonb end);
    return private.record_applied(p_event_id, 'gm_resolve_vote', p_game_id, v_result);
  end if;

  v_out := v_top[1];
  v_role := private.card_role(p_game_id, v_out);
  update public.game_players set alive = false, eliminated_round = v_game.round, revealed_role = v_role
  where game_id = p_game_id and member_id = v_out;
  insert into public.game_results (game_id, room_id, step, round, kind, votes, eliminated, revealed_role)
  values (p_game_id, v_game.room_id, v_game.step, v_game.round, 'vote', v_votes, v_out, v_role);
  v_result := jsonb_build_object('tie', false, 'eliminated', v_out, 'role', v_role, 'votes', v_votes);

  if v_role = 'mr_white' then
    update public.games
    set phase = 'guess', step = step + 1, guesser = v_out, judgement = null, resolved = false,
        phase_deadline = now() + interval '60 seconds'
    where id = p_game_id;
    v_result := v_result || '{"guess": true}';
  else
    update public.games set resolved = true, phase_deadline = null where id = p_game_id;
    v_winner := private.undercover_winner(p_game_id);
    if v_winner is not null then
      perform private.end_game(p_game_id, v_winner);
    end if;
    v_result := v_result || jsonb_build_object('winner', v_winner);
  end if;
  return private.record_applied(p_event_id, 'gm_resolve_vote', p_game_id, v_result);
end;
$$;

-- Judges Mr. White's guess (near misses count: the game master's call, with its reasoning). The host
-- then has 10 seconds to agree or overrule before it applies. No guess in time: the verdict is "wrong".
create function game_api.gm_judge(p_game_id uuid, p_verdict boolean, p_reasoning text, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := private.gm_game(p_game_id, p_event_id);
  v_prev jsonb := private.applied(p_event_id, 'gm_judge');
  v_guess text;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if v_game.phase <> 'guess' or v_game.judgement is not null then
    raise exception 'There''s no guess waiting for a verdict.' using errcode = '55000';
  end if;
  if char_length(btrim(coalesce(p_reasoning, ''))) not between 1 and 300 then
    raise exception 'Give a reason of up to 300 characters.' using errcode = '22023';
  end if;
  select guess into v_guess from private.game_judgements where game_id = p_game_id and step = v_game.step;
  if v_guess is null and p_verdict then
    raise exception 'Mr. White hasn''t guessed, so the guess can''t be right.' using errcode = '22023';
  end if;

  insert into private.game_judgements (game_id, step, member_id, verdict, reasoning)
  values (p_game_id, v_game.step, v_game.guesser, p_verdict, btrim(p_reasoning))
  on conflict (game_id, step) do update set verdict = excluded.verdict, reasoning = excluded.reasoning;
  update public.games
  set judgement = jsonb_build_object('verdict', p_verdict, 'overruled', false, 'settled', false),
      phase_deadline = now() + interval '10 seconds'
  where id = p_game_id;
  return private.record_applied(p_event_id, 'gm_judge', p_game_id,
    jsonb_build_object('verdict', p_verdict, 'settles_in_seconds', 10));
end;
$$;

-- ---------------------------------------------------------------------------
-- Timers (the dispatcher calls this about once a second)
-- ---------------------------------------------------------------------------

-- Claims every expired deadline. Clue turns and a settled verdict are mechanical and happen here; a
-- phase running out becomes a deadline_passed event, and the game master decides what it means.
create function dispatch.fire_due_deadlines()
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
    else
      update public.games set phase_deadline = null where id = v_game.id;
      perform private.emit_game_event(v_game, 'deadline_passed', jsonb_build_object('phase', v_game.phase));
    end if;
    v_fired := v_fired + 1;
  end loop;
  return v_fired;
end;
$$;

-- ---------------------------------------------------------------------------
-- host_say refuses a live secret word (the database's own last check; the narrator checks first)
-- ---------------------------------------------------------------------------

create or replace function agents_api.host_say(p_room_id uuid, p_text text, p_kind text, p_event_id uuid default null)
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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function private.owns_member(uuid) from public, anon;
grant execute on function private.owns_member(uuid) to authenticated;  -- the RLS policies call it

revoke all on function private.emit_game_event(public.games, text, jsonb) from public, anon, authenticated;
revoke all on function private.card_role(uuid, uuid) from public, anon, authenticated;
revoke all on function private.undercover_mix_ok(int, int, int) from public, anon, authenticated;
revoke all on function private.undercover_winner(uuid) from public, anon, authenticated;
revoke all on function private.end_game(uuid, text) from public, anon, authenticated;
revoke all on function private.advance_turn(uuid) from public, anon, authenticated;
revoke all on function private.settle_judgement(uuid) from public, anon, authenticated;
revoke all on function private.regex_escape(text) from public, anon, authenticated;
revoke all on function private.live_words_in(uuid, text) from public, anon, authenticated;
revoke all on function private.host_game(uuid) from public, anon, authenticated;
revoke all on function private.applied(uuid, text) from public, anon, authenticated;
revoke all on function private.record_applied(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.gm_game(uuid, uuid) from public, anon, authenticated;
revoke all on function private.broadcast_game_change() from public, anon, authenticated;
revoke all on function private.broadcast_to_member() from public, anon, authenticated;
revoke all on function private.end_game_when_room_closes() from public, anon, authenticated;

revoke all on function public.start_game(uuid, public.game_kind, jsonb) from public, anon;
revoke all on function public.submit_action(uuid, text, jsonb, uuid) from public, anon;
revoke all on function public.pause_game(uuid) from public, anon;
revoke all on function public.resume_game(uuid) from public, anon;
revoke all on function public.extend_phase(uuid, int) from public, anon;
revoke all on function public.skip_turn(uuid) from public, anon;
revoke all on function public.skip_phase(uuid) from public, anon;
revoke all on function public.settle_judgement(uuid, boolean) from public, anon;
revoke all on function public.end_game(uuid) from public, anon;
grant execute on function public.start_game(uuid, public.game_kind, jsonb) to authenticated;
grant execute on function public.submit_action(uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.pause_game(uuid) to authenticated;
grant execute on function public.resume_game(uuid) to authenticated;
grant execute on function public.extend_phase(uuid, int) to authenticated;
grant execute on function public.skip_turn(uuid) to authenticated;
grant execute on function public.skip_phase(uuid) to authenticated;
grant execute on function public.settle_judgement(uuid, boolean) to authenticated;
grant execute on function public.end_game(uuid) to authenticated;

revoke all on all functions in schema game_api from public;
grant execute on all functions in schema game_api to game_master_svc;

revoke all on function dispatch.fire_due_deadlines() from public;
grant execute on function dispatch.fire_due_deadlines() to dispatcher_svc;
