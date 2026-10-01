-- Quiz Night (slice 5a): everyone answers the same question on their phone at once; the TV asks it, reveals the
-- answer and shows the leaderboard. The quiz master (AI, or scripted rules) picks the questions; the database runs
-- the clock, keeps the answers secret until the reveal, and does all the scoring.
--
-- The secret here is the answer:
--   * a question's keyed answer lives in private.quiz_keys, readable by no player, until its reveal copies it
--     into the public row (quiz_questions.answer stays null until then);
--   * each player reads only their own answers until the question is revealed;
--   * the host's lines can't single out the live answer (private.say refuses them, as it does a secret word).

-- ---------------------------------------------------------------------------
-- The question bank: verified questions, each with its answer and source. No client can read it.
-- ---------------------------------------------------------------------------

create table content.quiz_bank (
  id uuid primary key default gen_random_uuid(),
  topic text not null check (topic ~ '^[a-z][a-z0-9 &-]{1,29}$'),  -- e.g. general, cricket, bollywood
  kind text not null check (kind in ('choice', 'true_false', 'estimate', 'picture')),
  difficulty smallint not null check (difficulty between 1 and 3),
  rating public.age_rating not null default 'family',
  region text check (region ~ '^[A-Z]{2}$'),  -- null: known everywhere
  prompt text not null check (char_length(btrim(prompt)) between 5 and 200),
  options jsonb,                 -- choice and picture: 2 to 4 answers to pick from
  answer jsonb not null,         -- choice/picture {"option": i}; true_false {"value": bool}; estimate {"value": n}
  unit text check (unit is null or char_length(unit) between 1 and 20),  -- estimates: "metres", "years"
  source_url text not null check (source_url ~ '^https://'),
  source_quote text not null check (char_length(source_quote) between 10 and 400),  -- what backs the answer
  image_path text,               -- picture: the object in the quiz-images bucket (a random name)
  image_credit jsonb,            -- picture: {"author", "licence", "source_url"}, shown on the TV
  origin text not null default 'seed' check (origin in ('seed', 'generated')),
  status text not null default 'verified' check (status in ('verified', 'retired')),
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((kind in ('choice', 'picture')) = (options is not null)),
  check (options is null or (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 4)),
  check (kind not in ('choice', 'picture') or (jsonb_typeof(answer -> 'option') = 'number'
         and (answer ->> 'option')::int between 0 and jsonb_array_length(options) - 1)),
  check (kind <> 'true_false' or jsonb_typeof(answer -> 'value') = 'boolean'),
  check (kind <> 'estimate' or jsonb_typeof(answer -> 'value') = 'number'),
  check ((kind = 'picture') = (image_path is not null and image_credit is not null))
);
create unique index quiz_bank_prompt_uq on content.quiz_bank (lower(prompt), coalesce(image_path, ''));
alter table content.quiz_bank enable row level security;

-- ---------------------------------------------------------------------------
-- Players pick a topic in the lobby; the quiz mixes everyone's picks
-- ---------------------------------------------------------------------------

alter table public.room_members add column topic text
  check (topic is null or topic ~ '^[[:alpha:][:digit:] &''.,-]{2,30}$');

create function public.set_topic(p_room_id uuid, p_topic text)
returns public.room_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.room_members;
  v_topic text := nullif(btrim(regexp_replace(coalesce(p_topic, ''), '\s+', ' ', 'g')), '');
begin
  if v_topic is not null and v_topic !~ '^[[:alpha:][:digit:] &''.,-]{2,30}$' then
    raise exception 'A topic is 2 to 30 letters, numbers and spaces.' using errcode = '22023';
  end if;
  update public.room_members m set topic = v_topic
  from public.rooms r
  where m.room_id = p_room_id and r.id = m.room_id and m.user_id = (select auth.uid()) and m.left_at is null
    and r.status = 'lobby'
  returning m.* into v_member;
  if not found then
    raise exception 'Pick a topic in the lobby of a room you''re in.' using errcode = '42501';
  end if;
  return v_member;
end;
$$;

-- ---------------------------------------------------------------------------
-- A game's questions (public once asked), their keys (private), the answers and the scores
-- ---------------------------------------------------------------------------

create table public.quiz_questions (
  game_id uuid not null references public.games (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  number smallint not null check (number >= 1),  -- 1, 2, ... across the game
  round smallint not null check (round >= 1),
  step int not null,                             -- the game step it was asked at
  kind text not null check (kind in ('choice', 'true_false', 'estimate', 'picture')),
  topic text not null,
  for_member uuid references public.room_members (id),  -- whose topic it is ("This one's for Asha!")
  difficulty smallint not null,
  prompt text not null,
  options jsonb,
  unit text,
  image_path text,
  image_credit jsonb,
  seconds smallint not null,
  opened_at timestamptz not null default now(),
  answer jsonb,          -- null until the reveal
  source_url text,       -- null until the reveal
  results jsonb,         -- at the reveal: how the room answered
  revealed_at timestamptz,
  primary key (game_id, number),
  unique (game_id, step),
  check ((answer is null) = (revealed_at is null))
);
create index quiz_questions_room_id_idx on public.quiz_questions (room_id);

create table private.quiz_keys (
  game_id uuid not null references public.games (id) on delete cascade,
  number smallint not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  bank_id uuid not null references content.quiz_bank (id),
  answer jsonb not null,
  created_at timestamptz not null default now(),
  primary key (game_id, number)
);
create index quiz_keys_room_id_idx on private.quiz_keys (room_id, created_at);

create table public.quiz_answers (
  game_id uuid not null references public.games (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  number smallint not null,
  member_id uuid not null references public.room_members (id) on delete cascade,
  answer jsonb not null,
  answered_at timestamptz not null default now(),  -- the server's clock: the speed bonus never trusts a phone
  joker boolean not null default false,
  action_id uuid not null unique,                  -- made by the phone, so a retried tap counts once
  correct boolean,                                 -- set at the reveal
  points int,                                      -- set at the reveal
  primary key (game_id, number, member_id)
);
create index quiz_answers_room_id_idx on public.quiz_answers (room_id);
create index quiz_answers_member_id_idx on public.quiz_answers (member_id);

create table public.quiz_scores (
  game_id uuid not null references public.games (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  member_id uuid not null references public.room_members (id) on delete cascade,
  points int not null default 0,
  correct smallint not null default 0,
  jokers smallint not null default 0,  -- the catch-up joker: whoever's last going into the final round
  joker_on smallint,                   -- the question it was played on
  primary key (game_id, member_id)
);
create index quiz_scores_room_id_idx on public.quiz_scores (room_id);
create index quiz_scores_member_id_idx on public.quiz_scores (member_id);
create index quiz_questions_for_member_idx on public.quiz_questions (for_member);
create index quiz_keys_bank_id_idx on private.quiz_keys (bank_id);

alter table public.quiz_questions enable row level security;
alter table private.quiz_keys enable row level security;
alter table public.quiz_answers enable row level security;
alter table public.quiz_scores enable row level security;

create function private.quiz_revealed(p_game_id uuid, p_number smallint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.quiz_questions
                 where game_id = p_game_id and number = p_number and revealed_at is not null);
$$;

create policy "members and displays read a game's questions" on public.quiz_questions
  for select to authenticated using (private.can_view_room(room_id));
create policy "members and displays read the scores" on public.quiz_scores
  for select to authenticated using (private.can_view_room(room_id));
-- Your own answers always; everyone's once that question has been revealed.
create policy "a player reads their own answers, and all answers once revealed" on public.quiz_answers
  for select to authenticated using (
    private.owns_member(member_id)
    or (private.can_view_room(room_id) and private.quiz_revealed(game_id, number))
  );

-- Questions and scores go to the room; an answer goes to its player only (the reveal shows the room how it went).
create trigger quiz_questions_broadcast after insert or update on public.quiz_questions
  for each row execute function private.broadcast_game_change();
create trigger quiz_scores_broadcast after insert or update on public.quiz_scores
  for each row execute function private.broadcast_game_change();
create trigger quiz_answers_broadcast after insert or update on public.quiz_answers
  for each row execute function private.broadcast_to_member();

-- ---------------------------------------------------------------------------
-- Starting a game: each game checks its own settings
--   undercover: theme (up to 30 characters), region
--   quiz: rounds (3 to 5, 5 questions each), seconds per question (10, 20 or 30), region
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
  end if;

  select count(*) into v_players from public.room_members where room_id = p_room_id and left_at is null;
  if v_players not between 3 and 16 then
    raise exception '% needs 3 to 16 players.', case p_kind when 'quiz' then 'Quiz Night' else 'Undercover' end
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
  end if;
  update public.rooms set status = 'playing' where id = p_room_id;

  perform private.emit_game_event(v_game, 'game_started', jsonb_build_object('kind', p_kind));
  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Answering, on the phone
-- ---------------------------------------------------------------------------

-- The caller's player in this game (still in the room), or an error.
create function private.quiz_player(p_game_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.member_id from public.game_players p
  join public.room_members m on m.id = p.member_id
  where p.game_id = p_game_id and m.user_id = (select auth.uid()) and m.left_at is null;
$$;

create function public.answer_question(p_game_id uuid, p_answer jsonb, p_action_id uuid)
returns public.quiz_answers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid := private.quiz_player(p_game_id);
  v_game public.games;
  v_question public.quiz_questions;
  v_row public.quiz_answers;
  v_score public.quiz_scores;
  v_players int;
begin
  if v_member is null then
    raise exception 'You''re not playing this game.' using errcode = '42501';
  end if;
  if p_action_id is null then
    raise exception 'An answer needs its id.' using errcode = '22023';
  end if;
  select * into v_row from public.quiz_answers where action_id = p_action_id;
  if found then
    if v_row.member_id <> v_member then
      raise exception 'That answer id is taken.' using errcode = '22023';
    end if;
    return v_row;  -- a retried tap: the same answer, counted once
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if v_game.kind <> 'quiz' or v_game.phase <> 'question' or v_game.paused_at is not null
     or v_game.phase_deadline is null then
    raise exception 'There''s no question open to answer.' using errcode = '55000';
  end if;
  select * into v_question from public.quiz_questions where game_id = p_game_id and step = v_game.step;

  -- CASE, so a value is only cast once it's known to be a number (in parentheses: an IF ends at its first THEN).
  if jsonb_typeof(p_answer) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_answer)) <> 1
     or not (case v_question.kind
          when 'true_false' then jsonb_typeof(p_answer -> 'value') = 'boolean'
          when 'estimate' then (case when jsonb_typeof(p_answer -> 'value') = 'number'
                                     then abs((p_answer ->> 'value')::numeric) < 1e12 else false end)
          else (case when jsonb_typeof(p_answer -> 'option') = 'number'
                     then (p_answer ->> 'option')::numeric = trunc((p_answer ->> 'option')::numeric)
                          and (p_answer ->> 'option')::numeric between 0 and jsonb_array_length(v_question.options) - 1
                     else false end)
        end) then
    raise exception 'That isn''t an answer to this question.' using errcode = '22023';
  end if;
  if exists (select 1 from public.quiz_answers where game_id = p_game_id and number = v_question.number
             and member_id = v_member) then
    raise exception 'You''ve already answered this one.' using errcode = '23505';
  end if;

  select * into v_score from public.quiz_scores where game_id = p_game_id and member_id = v_member;
  insert into public.quiz_answers (game_id, room_id, number, member_id, answer, joker, action_id)
  values (p_game_id, v_game.room_id, v_question.number, v_member, p_answer,
          coalesce(v_score.joker_on = v_question.number, false), p_action_id)
  returning * into v_row;

  update public.games set moves_in = moves_in + 1 where id = p_game_id returning * into v_game;
  select count(*) into v_players from public.game_players p join public.room_members m on m.id = p.member_id
  where p.game_id = p_game_id and m.left_at is null;
  if v_game.moves_in >= v_players then  -- everyone's in: close it now, and tell the quiz master
    update public.games set phase_deadline = null where id = p_game_id returning * into v_game;
    perform private.emit_game_event(v_game, 'phase_complete', jsonb_build_object('phase', 'question'));
  end if;
  return v_row;
end;
$$;

-- The catch-up joker: doubles this question's points. Played before answering, while the question is open.
create function public.play_joker(p_game_id uuid)
returns public.quiz_scores
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid := private.quiz_player(p_game_id);
  v_game public.games;
  v_number smallint;
  v_score public.quiz_scores;
begin
  if v_member is null then
    raise exception 'You''re not playing this game.' using errcode = '42501';
  end if;
  select * into v_game from public.games where id = p_game_id for update;
  if v_game.kind <> 'quiz' or v_game.phase <> 'question' or v_game.paused_at is not null
     or v_game.phase_deadline is null then
    raise exception 'Play the joker while a question is open.' using errcode = '55000';
  end if;
  select number into v_number from public.quiz_questions where game_id = p_game_id and step = v_game.step;
  if exists (select 1 from public.quiz_answers where game_id = p_game_id and number = v_number
             and member_id = v_member) then
    raise exception 'Play the joker before you answer.' using errcode = '55000';
  end if;
  update public.quiz_scores set jokers = jokers - 1, joker_on = v_number
  where game_id = p_game_id and member_id = v_member and jokers > 0
  returning * into v_score;
  if not found then
    raise exception 'You don''t have a joker to play.' using errcode = '55000';
  end if;
  return v_score;
end;
$$;

-- ---------------------------------------------------------------------------
-- The quiz master's API (game_api: only game_master_svc)
-- ---------------------------------------------------------------------------

-- Everything the quiz master may know, including the live question's answer.
create function game_api.get_quiz_state(p_game_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'game', jsonb_build_object(
      'id', g.id, 'room_id', g.room_id, 'kind', g.kind, 'phase', g.phase, 'step', g.step, 'round', g.round,
      'settings', g.settings, 'config', g.config, 'phase_deadline', g.phase_deadline,
      'paused', g.paused_at is not null, 'moves_in', g.moves_in, 'resolved', g.resolved),
    'age_rating', r.age_rating,
    'asked', (select count(*) from public.quiz_questions q where q.game_id = g.id),
    'total', (g.config ->> 'rounds')::int * (g.config ->> 'per_round')::int,
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'member_id', p.member_id, 'nickname', m.nickname, 'topic', m.topic, 'in_room', m.left_at is null,
                  'points', s.points, 'correct', s.correct, 'jokers', s.jokers) order by s.points desc, p.seat), '[]')
                from public.game_players p
                join public.room_members m on m.id = p.member_id
                join public.quiz_scores s on s.game_id = p.game_id and s.member_id = p.member_id
                where p.game_id = g.id),
    'question', (select to_jsonb(q) - 'room_id' || jsonb_build_object('key', k.answer)
                 from public.quiz_questions q join private.quiz_keys k using (game_id, number)
                 where q.game_id = g.id order by q.number desc limit 1),
    'topics_asked', (select coalesce(jsonb_agg(q.topic order by q.number), '[]')
                     from public.quiz_questions q where q.game_id = g.id)
  )
  from public.games g join public.rooms r on r.id = g.room_id
  where g.id = p_game_id;
$$;

-- Verified questions this game can use: the room's rating or milder, its region or everywhere, and not asked in
-- this room in the last 12 hours. Optionally one topic, kind or difficulty.
create function game_api.quiz_bank(
  p_game_id uuid, p_topic text default null, p_kind text default null, p_difficulty smallint default null,
  p_limit int default 20
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'topic', b.topic, 'kind', b.kind, 'difficulty', b.difficulty, 'prompt', b.prompt,
           'options', b.options, 'unit', b.unit, 'answer', b.answer, 'picture', b.image_path is not null)), '[]')
  from (
    select b.* from content.quiz_bank b
    join public.games g on g.id = p_game_id
    join public.rooms r on r.id = g.room_id
    where b.status = 'verified' and b.rating <= r.age_rating
      and (b.region is null or b.region = g.settings ->> 'region')
      and (p_topic is null or b.topic = lower(btrim(p_topic)))
      and (p_kind is null or b.kind = p_kind)
      and (p_difficulty is null or b.difficulty = p_difficulty)
      and not exists (select 1 from private.quiz_keys k where k.room_id = g.room_id and k.bank_id = b.id
                      and (k.game_id = g.id or k.created_at > now() - interval '12 hours'))
    order by random()
    limit least(greatest(p_limit, 1), 50)
  ) b;
$$;

-- Asks the next question. Allowed at the start, and after a reveal once its time is up (or the host skipped it).
-- Going into the final round, whoever is last gets the catch-up joker.
create function game_api.gm_ask(p_game_id uuid, p_bank_id uuid, p_for_member uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb := private.applied(p_event_id, 'gm_ask');
  v_game public.games;
  v_room public.rooms;
  v_bank content.quiz_bank;
  v_number int;
  v_total int;
  v_per_round int;
  v_seconds int;
  v_round int;
  v_jokers jsonb := '[]';
begin
  if v_prev is not null then
    return v_prev;
  end if;
  v_game := private.gm_game(p_game_id, p_event_id);
  if v_game.kind <> 'quiz' then
    raise exception 'That''s not a quiz.' using errcode = '22023';
  end if;
  if v_game.paused_at is not null then
    raise exception 'The game is paused.' using errcode = '55000';
  end if;
  if not (v_game.phase = 'setup' or (v_game.phase = 'reveal' and v_game.phase_deadline is null)) then
    raise exception 'The next question opens after the last one''s reveal has had its time.' using errcode = '55000';
  end if;
  v_per_round := (v_game.config ->> 'per_round')::int;
  v_total := (v_game.config ->> 'rounds')::int * v_per_round;
  select count(*) + 1 into v_number from public.quiz_questions where game_id = p_game_id;
  if v_number > v_total then
    raise exception 'Every question has been asked.' using errcode = '55000';
  end if;

  select * into v_room from public.rooms where id = v_game.room_id;
  select * into v_bank from content.quiz_bank where id = p_bank_id and status = 'verified';
  if not found or v_bank.rating > v_room.age_rating
     or (v_bank.region is not null and v_bank.region is distinct from v_game.settings ->> 'region')
     or exists (select 1 from private.quiz_keys k where k.room_id = v_game.room_id and k.bank_id = p_bank_id
                and (k.game_id = p_game_id or k.created_at > now() - interval '12 hours')) then
    raise exception 'That question can''t be used here (unknown, not for this room, or asked tonight).'
      using errcode = '22023';
  end if;
  if p_for_member is not null and not exists (
       select 1 from public.game_players where game_id = p_game_id and member_id = p_for_member) then
    raise exception 'Credit a question to a player in this game.' using errcode = '22023';
  end if;

  v_round := (v_number - 1) / v_per_round + 1;
  v_seconds := (v_game.config ->> 'seconds')::int
             + case when v_bank.kind = 'estimate' then (v_game.config ->> 'estimate_extra_seconds')::int else 0 end;

  -- Into the final round: the catch-up joker for whoever's last (nobody, if everyone's level).
  if v_number = v_total - v_per_round + 1 then
    with low as (select min(points) as low, max(points) as high from public.quiz_scores where game_id = p_game_id)
    update public.quiz_scores s set jokers = 1
    from low where s.game_id = p_game_id and s.points = low.low and low.low < low.high;
    select coalesce(jsonb_agg(member_id), '[]') into v_jokers from public.quiz_scores
    where game_id = p_game_id and jokers > 0;
  end if;

  update public.games
  set phase = 'question', step = step + 1, round = v_round, phase_deadline = now() + make_interval(secs => v_seconds),
      moves_in = 0, resolved = false
  where id = p_game_id
  returning * into v_game;
  insert into private.quiz_keys (game_id, number, room_id, bank_id, answer)
  values (p_game_id, v_number, v_game.room_id, p_bank_id, v_bank.answer);
  insert into public.quiz_questions (game_id, room_id, number, round, step, kind, topic, for_member, difficulty,
                                     prompt, options, unit, image_path, image_credit, seconds)
  values (p_game_id, v_game.room_id, v_number, v_round, v_game.step, v_bank.kind, v_bank.topic, p_for_member,
          v_bank.difficulty, v_bank.prompt, v_bank.options, v_bank.unit, v_bank.image_path, v_bank.image_credit,
          v_seconds);

  return private.record_applied(p_event_id, 'gm_ask', p_game_id, jsonb_build_object(
    'number', v_number, 'of', v_total, 'round', v_round, 'kind', v_bank.kind, 'seconds', v_seconds,
    'step', v_game.step, 'jokers_to', v_jokers, 'final_round', v_round = (v_game.config ->> 'rounds')::int));
end;
$$;

-- Reveals the question once its answers are closed (time's up, everyone answered, or the host skipped), scores it,
-- and holds the reveal for a few seconds. After the last question, the game ends.
--   right answer (choice, true or false, picture): 500 to 1,000 points, more the faster it came
--   closest estimate: 1,000; the others by how close they came, down to 1,000 / the number who answered
--   a joker doubles that question's points
create function game_api.gm_reveal(p_game_id uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb := private.applied(p_event_id, 'gm_reveal');
  v_game public.games;
  v_question public.quiz_questions;
  v_key jsonb;
  v_source text;
  v_results jsonb;
  v_answered int;
  v_total int;
  v_final boolean;
  v_leaders jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  v_game := private.gm_game(p_game_id, p_event_id);
  if v_game.kind <> 'quiz' or v_game.phase <> 'question' or v_game.resolved or v_game.phase_deadline is not null
     or v_game.paused_at is not null then
    raise exception 'Reveal a question once its answers have closed.' using errcode = '55000';
  end if;
  select * into v_question from public.quiz_questions where game_id = p_game_id and step = v_game.step;
  select k.answer, b.source_url into v_key, v_source
  from private.quiz_keys k join content.quiz_bank b on b.id = k.bank_id
  where k.game_id = p_game_id and k.number = v_question.number;
  select count(*) into v_answered from public.quiz_answers where game_id = p_game_id and number = v_question.number;

  if v_question.kind = 'estimate' then
    with ranked as (
      select member_id, rank() over (order by abs((answer ->> 'value')::numeric - (v_key ->> 'value')::numeric)) as place
      from public.quiz_answers where game_id = p_game_id and number = v_question.number
    )
    update public.quiz_answers a
    set correct = r.place = 1,
        points = round(1000.0 * (v_answered - r.place + 1) / v_answered)::int * case when a.joker then 2 else 1 end
    from ranked r
    where a.game_id = p_game_id and a.number = v_question.number and a.member_id = r.member_id;
    select jsonb_build_object('answered', v_answered, 'closest', coalesce(jsonb_agg(jsonb_build_object(
             'member_id', member_id, 'value', answer -> 'value') order by points desc) filter (where correct), '[]'))
    into v_results from public.quiz_answers where game_id = p_game_id and number = v_question.number;
  else
    update public.quiz_answers a
    set correct = a.answer = v_key,
        points = case when a.answer = v_key then
                   (500 + round(500 * greatest(0.0, 1 - extract(epoch from a.answered_at - v_question.opened_at)
                                                        / v_question.seconds)))::int
                   * case when a.joker then 2 else 1 end
                 else 0 end
    where a.game_id = p_game_id and a.number = v_question.number;
    select jsonb_build_object(
             'answered', v_answered,
             'right', count(*) filter (where correct),
             'picks', case when v_question.kind = 'true_false'
                        then jsonb_build_object('true', count(*) filter (where answer -> 'value' = 'true'),
                                                'false', count(*) filter (where answer -> 'value' = 'false'))
                        else (select coalesce(jsonb_agg(c order by i), '[]') from (
                                select i, count(*) filter (where (x.answer ->> 'option')::int = i) as c
                                from generate_series(0, jsonb_array_length(v_question.options) - 1) i
                                left join public.quiz_answers x on x.game_id = p_game_id and x.number = v_question.number
                                group by i) t) end)
    into v_results from public.quiz_answers where game_id = p_game_id and number = v_question.number;
  end if;

  update public.quiz_scores s
  set points = s.points + a.points, correct = s.correct + case when a.correct then 1 else 0 end
  from public.quiz_answers a
  where a.game_id = p_game_id and a.number = v_question.number and s.game_id = a.game_id and s.member_id = a.member_id;

  update public.quiz_questions
  set answer = v_key, source_url = v_source, results = v_results, revealed_at = now()
  where game_id = p_game_id and number = v_question.number;

  v_total := (v_game.config ->> 'rounds')::int * (v_game.config ->> 'per_round')::int;
  v_final := v_question.number >= v_total;
  select coalesce(jsonb_agg(jsonb_build_object('member_id', member_id, 'points', points) order by points desc), '[]')
  into v_leaders from (select member_id, points from public.quiz_scores where game_id = p_game_id
                       order by points desc limit 3) t;
  if v_final then
    perform private.end_game(p_game_id, null);
  else
    update public.games
    set phase = 'reveal', step = step + 1, resolved = true,
        phase_deadline = now() + make_interval(secs => (config ->> 'reveal_seconds')::int)
    where id = p_game_id;
  end if;

  return private.record_applied(p_event_id, 'gm_reveal', p_game_id, jsonb_build_object(
    'number', v_question.number, 'answer', v_key, 'results', v_results, 'leaders', v_leaders, 'game_over', v_final,
    'next_is_new_round', not v_final and v_question.number % (v_game.config ->> 'per_round')::int = 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared machinery, now game-aware
-- ---------------------------------------------------------------------------

-- The end of any game. A quiz ends on its final standings (no team wins; the leaderboard says who did).
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

  update public.rooms set status = 'lobby' where id = v_game.room_id and status = 'playing';
  perform private.emit_game_event(v_game, 'game_ended', jsonb_build_object('winner', p_winner));
end;
$$;

-- The host skips ahead: a quiz question closes now (and is revealed), or a reveal's wait ends.
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
  elsif (v_game.phase in ('clues', 'discussion', 'vote', 'guess', 'question') and not v_game.resolved)
        or (v_game.phase = 'reveal' and v_game.phase_deadline is not null) then
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

-- The host's lines may not single out the live answer: naming the right option while leaving out the others (a
-- line may still read all the options out), or saying an estimate's number.
create function private.live_answer_in(p_room_id uuid, p_text text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.quiz_questions q
    join public.games g on g.id = q.game_id and g.phase <> 'ended'
    join private.quiz_keys k on k.game_id = q.game_id and k.number = q.number
    where q.room_id = p_room_id and q.revealed_at is null
      and (
        (q.kind in ('choice', 'picture')
         and p_text ~* ('\m' || private.regex_escape(btrim(q.options ->> (k.answer ->> 'option')::int)) || '\M')
         and exists (select 1 from jsonb_array_elements_text(q.options) with ordinality o(opt, i)
                     where i - 1 <> (k.answer ->> 'option')::int
                       and p_text !~* ('\m' || private.regex_escape(btrim(o.opt)) || '\M')))
        or (q.kind = 'estimate' and p_text ~ ('(^|[^0-9.])' || private.regex_escape(k.answer ->> 'value') || '($|[^0-9])'))
      )
  );
$$;

create or replace function private.say(p_room_id uuid, p_text text, p_kind text, p_event_id uuid)
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
  if private.live_words_in(p_room_id, v_text) or private.live_answer_in(p_room_id, v_text) then
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
-- Picture rounds: images in a private bucket, readable only once their question is asked in your room
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-images', 'quiz-images', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create function private.can_see_quiz_image(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.quiz_questions q
                 where q.image_path = p_path and private.can_view_room(q.room_id));
$$;

create policy "players and TVs see a picture once it's asked in their room" on storage.objects
  for select to authenticated
  using (bucket_id = 'quiz-images' and private.can_see_quiz_image(name));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.set_topic(uuid, text) from public, anon;
revoke all on function public.answer_question(uuid, jsonb, uuid) from public, anon;
revoke all on function public.play_joker(uuid) from public, anon;
grant execute on function public.set_topic(uuid, text) to authenticated;
grant execute on function public.answer_question(uuid, jsonb, uuid) to authenticated;
grant execute on function public.play_joker(uuid) to authenticated;

revoke all on function private.quiz_revealed(uuid, smallint) from public, anon;
grant execute on function private.quiz_revealed(uuid, smallint) to authenticated;  -- the answers' RLS calls it
revoke all on function private.can_see_quiz_image(text) from public, anon;
grant execute on function private.can_see_quiz_image(text) to authenticated;  -- Storage's RLS calls it
revoke all on function private.quiz_player(uuid) from public, anon, authenticated;
revoke all on function private.live_answer_in(uuid, text) from public, anon, authenticated;

revoke all on all functions in schema game_api from public;
grant execute on all functions in schema game_api to game_master_svc;
