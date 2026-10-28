-- Quiz Night, slice 9: themed rounds and questions that make people think.
--
-- A quiz is now a run of themed rounds, always in this order; the host picks a length (3, 5 or 8 rounds) and the
-- middle rounds fill in from the top:
--   teasers (always first) · fake or real · lightning · picture · the mix · in order · closest wins · connections
--   (always last)
-- New question kinds:
--   teaser     brain teasers: riddles, wordplay, emoji films. Multiple choice. The only kind that may be ungrounded
--              (no source): the generator's reviewer solves each one blind instead.
--   fake_real  a statement, fake or real ({"value": true} is real). A fake is a real fact with one detail changed.
--   lightning  two-option quick fire, 6 seconds.
--   order      put the options in order (unit says by what: "oldest first"); the answer is {"order": [i, ...]},
--              the options' indexes in the right order.
--   connect    what links the clues: 3 or 4 clues shown one at a time, then multiple choice.
-- Every question can carry a hook: the "did you know" line for its reveal. Like the answer and the source, it stays
-- in the bank until the reveal copies it into the public row (a hook can give the answer away).

-- ---------------------------------------------------------------------------
-- The bank
-- ---------------------------------------------------------------------------

-- {"order": [...]} is a permutation of the options' indexes.
create function private.is_order(p_order jsonb, p_options jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p_order) = 'array' and jsonb_typeof(p_options) = 'array'
    and jsonb_array_length(p_order) = jsonb_array_length(p_options)
    and (select bool_and(jsonb_typeof(e) = 'number') from jsonb_array_elements(p_order) e)
    and (select array_agg((e #>> '{}')::numeric order by (e #>> '{}')::numeric) from jsonb_array_elements(p_order) e)
        = (select array_agg(i::numeric order by i) from generate_series(0, jsonb_array_length(p_options) - 1) i),
    false);
$$;

alter table content.quiz_bank drop constraint quiz_bank_kind_check;
alter table content.quiz_bank drop constraint quiz_bank_check;
alter table content.quiz_bank drop constraint quiz_bank_check1;
alter table content.quiz_bank drop constraint quiz_bank_check2;
alter table content.quiz_bank drop constraint quiz_bank_source_quote_check;
alter table content.quiz_bank drop constraint quiz_bank_source_url_check;
alter table content.quiz_bank drop constraint quiz_bank_unit_check;

alter table content.quiz_bank
  alter column source_url drop not null,
  alter column source_quote drop not null,
  add column grounded boolean not null default true,
  add column hook text check (hook is null or char_length(btrim(hook)) between 10 and 200),
  add column clues jsonb;

alter table content.quiz_bank
  add constraint quiz_bank_kind_check check (kind in ('choice', 'true_false', 'estimate', 'picture', 'teaser',
                                                       'fake_real', 'lightning', 'order', 'connect')),
  add constraint quiz_bank_options_shape check (
    (kind in ('choice', 'picture', 'teaser', 'lightning', 'order', 'connect')) = (options is not null)
    and (kind <> 'lightning' or jsonb_array_length(options) = 2)
    and (kind <> 'order' or jsonb_array_length(options) between 3 and 4)),
  add constraint quiz_bank_option_answer check (
    kind not in ('choice', 'picture', 'teaser', 'lightning', 'connect')
    or (jsonb_typeof(answer -> 'option') = 'number'
        and (answer ->> 'option')::int between 0 and jsonb_array_length(options) - 1)),
  add constraint quiz_bank_value_answer check (kind not in ('true_false', 'fake_real')
                                               or jsonb_typeof(answer -> 'value') = 'boolean'),
  add constraint quiz_bank_order_answer check (kind <> 'order' or private.is_order(answer -> 'order', options)),
  add constraint quiz_bank_clues check ((kind = 'connect') = (clues is not null)
    and (clues is null or (jsonb_typeof(clues) = 'array' and jsonb_array_length(clues) between 3 and 4))),
  -- A grounded question names its source and the passage that backs it; only a teaser may have neither.
  add constraint quiz_bank_grounding check (
    (grounded and source_url ~ '^https://' and char_length(source_quote) between 10 and 800)
    or (not grounded and kind = 'teaser' and source_url is null and source_quote is null)),
  -- estimates: "metres"; order: what the order goes by, "oldest first"
  add constraint quiz_bank_unit_check check (unit is null or char_length(unit) between 1 and 30),
  add constraint quiz_bank_order_unit check (kind <> 'order' or unit is not null);

-- One question per prompt, picture and clues: every connections question asks "What links these?".
drop index content.quiz_bank_prompt_uq;
create unique index quiz_bank_prompt_uq on content.quiz_bank (lower(prompt), coalesce(image_path, ''), coalesce(clues::text, ''));

alter table public.quiz_questions drop constraint quiz_questions_kind_check;
alter table public.quiz_questions
  add constraint quiz_questions_kind_check check (kind in ('choice', 'true_false', 'estimate', 'picture', 'teaser',
                                                           'fake_real', 'lightning', 'order', 'connect')),
  add column clues jsonb,              -- connect: shown one at a time while the question is open (not secret)
  add column hook text,                -- null until the reveal
  add column grounded boolean;         -- set at the reveal: false says "a puzzle by the AI host", not a source

-- ---------------------------------------------------------------------------
-- Rounds
-- ---------------------------------------------------------------------------

-- The rounds of a quiz of this length, in order: each round's name, its number of questions, and its timing
-- ("seconds": fixed, or "extra" on top of the host's choice; "reveal": how long its reveals hold).
create function private.quiz_plan(p_rounds int)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_agg(r order by i) from (
    select i, case name
      when 'lightning' then jsonb_build_object('round', name, 'questions', 8, 'seconds', 6, 'reveal', 4)
      when 'closest' then jsonb_build_object('round', name, 'questions', 5, 'extra', 10, 'reveal', 8)
      when 'order' then jsonb_build_object('round', name, 'questions', 5, 'extra', 10, 'reveal', 8)
      when 'connect' then jsonb_build_object('round', name, 'questions', 5, 'extra', 10, 'reveal', 8)
      else jsonb_build_object('round', name, 'questions', 5, 'extra', 0, 'reveal', 8) end as r
    from unnest(case p_rounds
      when 3 then array['teasers', 'fake_real', 'connect']
      when 5 then array['teasers', 'fake_real', 'lightning', 'picture', 'connect']
      else array['teasers', 'fake_real', 'lightning', 'picture', 'mix', 'order', 'closest', 'connect'] end)
      with ordinality as t(name, i)
  ) t;
$$;

-- The question kinds a round asks.
create function private.quiz_round_kinds(p_round text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_round
    when 'teasers' then array['teaser'] when 'fake_real' then array['fake_real']
    when 'lightning' then array['lightning'] when 'picture' then array['picture']
    when 'mix' then array['choice', 'true_false'] when 'order' then array['order']
    when 'closest' then array['estimate'] when 'connect' then array['connect']
    else array[]::text[] end;
$$;

-- Where question p_number falls in a quiz: its round (number and name), the kinds it may be, whether it opens its
-- round, whether that's the final round, its seconds and reveal hold. Null past the last question.
create function private.quiz_slot(p_config jsonb, p_number int)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with rounds as (
    select i::int as round_no, r, sum((r ->> 'questions')::int) over (order by i) as upto,
           count(*) over () as rounds
    from jsonb_array_elements(p_config -> 'plan') with ordinality as t(r, i)
  )
  select jsonb_build_object(
    'number', p_number, 'round', round_no, 'name', r ->> 'round', 'kinds', to_jsonb(private.quiz_round_kinds(r ->> 'round')),
    'first_of_round', p_number = upto - (r ->> 'questions')::int + 1, 'final_round', round_no = rounds,
    'seconds', coalesce((r ->> 'seconds')::int, (p_config ->> 'seconds')::int + coalesce((r ->> 'extra')::int, 0)),
    'reveal_seconds', (r ->> 'reveal')::int)
  from rounds where p_number between 1 and upto order by round_no limit 1;
$$;

create function private.quiz_total(p_config jsonb)
returns int
language sql
immutable
set search_path = ''
as $$
  select coalesce(sum((r ->> 'questions')::int), 0)::int from jsonb_array_elements(p_config -> 'plan') r;
$$;

-- ---------------------------------------------------------------------------
-- Starting a quiz: the host picks a length (3, 5 or 8 rounds)
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
       or (v_settings ? 'rounds' and coalesce(v_settings ->> 'rounds', '') not in ('3', '5', '8'))
       or (v_settings ? 'seconds' and coalesce(v_settings ->> 'seconds', '') not in ('10', '20', '30')) then
      raise exception 'A quiz takes 3, 5 or 8 rounds, 10, 20 or 30 seconds a question, and a region.' using errcode = '22023';
    end if;
    v_rounds := coalesce((v_settings ->> 'rounds')::int, 5);
    v_config := jsonb_build_object('rounds', v_rounds, 'seconds', coalesce((v_settings ->> 'seconds')::int, 20),
                                   'plan', private.quiz_plan(v_rounds));
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

-- ---------------------------------------------------------------------------
-- Answering: each kind's answer shape
-- ---------------------------------------------------------------------------

create or replace function public.answer_question(p_game_id uuid, p_answer jsonb, p_action_id uuid)
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
  -- COALESCE: an answer missing its key makes the CASE null, which an IF would let through.
  if jsonb_typeof(p_answer) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_answer)) <> 1
     or not coalesce((case
          when v_question.kind in ('true_false', 'fake_real') then jsonb_typeof(p_answer -> 'value') = 'boolean'
          when v_question.kind = 'estimate' then (case when jsonb_typeof(p_answer -> 'value') = 'number'
                                                    then abs((p_answer ->> 'value')::numeric) < 1e12 else false end)
          when v_question.kind = 'order' then private.is_order(p_answer -> 'order', v_question.options)
          else (case when jsonb_typeof(p_answer -> 'option') = 'number'
                     then (p_answer ->> 'option')::numeric = trunc((p_answer ->> 'option')::numeric)
                          and (p_answer ->> 'option')::numeric between 0 and jsonb_array_length(v_question.options) - 1
                     else false end)
        end), false) then
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

-- ---------------------------------------------------------------------------
-- The quiz master's API
-- ---------------------------------------------------------------------------

-- Everything the quiz master may know, including the live question's answer, and what the next question must be.
create or replace function game_api.get_quiz_state(p_game_id uuid)
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
    'total', private.quiz_total(g.config),
    'next', private.quiz_slot(g.config, (select count(*)::int + 1 from public.quiz_questions q where q.game_id = g.id)),
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

-- Verified questions this game can use (as before), now with each one's clues and whether it's grounded.
create or replace function game_api.quiz_bank(
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
           'options', b.options, 'clues', b.clues, 'unit', b.unit, 'answer', b.answer, 'hook', b.hook,
           'grounded', b.grounded, 'picture', b.image_path is not null)), '[]')
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

-- Asks the next question: it must be a kind its round asks. Going into the final round, whoever is last gets the
-- catch-up joker.
create or replace function game_api.gm_ask(p_game_id uuid, p_bank_id uuid, p_for_member uuid, p_event_id uuid)
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
  v_slot jsonb;
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
  v_total := private.quiz_total(v_game.config);
  select count(*) + 1 into v_number from public.quiz_questions where game_id = p_game_id;
  if v_number > v_total then
    raise exception 'Every question has been asked.' using errcode = '55000';
  end if;
  v_slot := private.quiz_slot(v_game.config, v_number);

  select * into v_room from public.rooms where id = v_game.room_id;
  select * into v_bank from content.quiz_bank where id = p_bank_id and status = 'verified';
  if not found or v_bank.rating > v_room.age_rating
     or (v_bank.region is not null and v_bank.region is distinct from v_game.settings ->> 'region')
     or exists (select 1 from private.quiz_keys k where k.room_id = v_game.room_id and k.bank_id = p_bank_id
                and (k.game_id = p_game_id or k.created_at > now() - interval '12 hours')) then
    raise exception 'That question can''t be used here (unknown, not for this room, or asked tonight).'
      using errcode = '22023';
  end if;
  if not (v_slot -> 'kinds') ? v_bank.kind then
    raise exception 'This round (%) asks % questions, not %.', v_slot ->> 'name',
      array_to_string(array(select jsonb_array_elements_text(v_slot -> 'kinds')), ' or '), v_bank.kind
      using errcode = '22023';
  end if;
  if p_for_member is not null and not exists (
       select 1 from public.game_players where game_id = p_game_id and member_id = p_for_member) then
    raise exception 'Credit a question to a player in this game.' using errcode = '22023';
  end if;

  -- Into the final round: the catch-up joker for whoever's last (nobody, if everyone's level).
  if (v_slot ->> 'first_of_round')::boolean and (v_slot ->> 'final_round')::boolean then
    with low as (select min(points) as low, max(points) as high from public.quiz_scores where game_id = p_game_id)
    update public.quiz_scores s set jokers = 1
    from low where s.game_id = p_game_id and s.points = low.low and low.low < low.high;
    select coalesce(jsonb_agg(member_id), '[]') into v_jokers from public.quiz_scores
    where game_id = p_game_id and jokers > 0;
  end if;

  update public.games
  set phase = 'question', step = step + 1, round = (v_slot ->> 'round')::int,
      phase_deadline = now() + make_interval(secs => (v_slot ->> 'seconds')::int), moves_in = 0, resolved = false
  where id = p_game_id
  returning * into v_game;
  insert into private.quiz_keys (game_id, number, room_id, bank_id, answer)
  values (p_game_id, v_number, v_game.room_id, p_bank_id, v_bank.answer);
  insert into public.quiz_questions (game_id, room_id, number, round, step, kind, topic, for_member, difficulty,
                                     prompt, options, unit, image_path, image_credit, clues, seconds)
  values (p_game_id, v_game.room_id, v_number, (v_slot ->> 'round')::int, v_game.step, v_bank.kind, v_bank.topic,
          p_for_member, v_bank.difficulty, v_bank.prompt, v_bank.options, v_bank.unit, v_bank.image_path,
          v_bank.image_credit, v_bank.clues, (v_slot ->> 'seconds')::int);

  return private.record_applied(p_event_id, 'gm_ask', p_game_id, jsonb_build_object(
    'number', v_number, 'of', v_total, 'round', (v_slot ->> 'round')::int, 'round_name', v_slot ->> 'name',
    'kind', v_bank.kind, 'seconds', (v_slot ->> 'seconds')::int, 'step', v_game.step, 'jokers_to', v_jokers,
    'final_round', (v_slot ->> 'final_round')::boolean));
end;
$$;

-- Reveals the question once its answers are closed, scores it, and holds the reveal (shorter in lightning).
--   right answer (choice-like, true or false, fake or real): 500 to 1,000 points, more the faster it came
--   in order: all right as above; otherwise 100 for each item in its right place
--   closest estimate: 1,000; the others by how close they came, down to 1,000 / the number who answered
--   a joker doubles that question's points
create or replace function game_api.gm_reveal(p_game_id uuid, p_event_id uuid)
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
  v_hook text;
  v_grounded boolean;
  v_results jsonb;
  v_answered int;
  v_total int;
  v_final boolean;
  v_leaders jsonb;
  v_next jsonb;
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
  select k.answer, b.source_url, b.hook, b.grounded into v_key, v_source, v_hook, v_grounded
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
  elsif v_question.kind = 'order' then
    update public.quiz_answers a
    set correct = a.answer = v_key,
        points = case when a.answer = v_key then
                   (500 + round(500 * greatest(0.0, 1 - extract(epoch from a.answered_at - v_question.opened_at)
                                                        / v_question.seconds)))::int
                 else 100 * (select count(*) from generate_series(0, jsonb_array_length(v_key -> 'order') - 1) i
                             where a.answer -> 'order' -> i = v_key -> 'order' -> i)::int end
                 * case when a.joker then 2 else 1 end
    where a.game_id = p_game_id and a.number = v_question.number;
    select jsonb_build_object('answered', v_answered, 'right', count(*) filter (where correct))
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
             'picks', case when v_question.kind in ('true_false', 'fake_real')
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
  set answer = v_key, source_url = v_source, hook = v_hook, grounded = v_grounded, results = v_results,
      revealed_at = now()
  where game_id = p_game_id and number = v_question.number;

  v_total := private.quiz_total(v_game.config);
  v_final := v_question.number >= v_total;
  v_next := private.quiz_slot(v_game.config, v_question.number + 1);
  select coalesce(jsonb_agg(jsonb_build_object('member_id', member_id, 'points', points) order by points desc), '[]')
  into v_leaders from (select member_id, points from public.quiz_scores where game_id = p_game_id
                       order by points desc limit 3) t;
  if v_final then
    perform private.end_game(p_game_id, null);
  else
    update public.games
    set phase = 'reveal', step = step + 1, resolved = true,
        phase_deadline = now() + make_interval(secs => (private.quiz_slot(config, v_question.number) ->> 'reveal_seconds')::int)
    where id = p_game_id;
  end if;

  return private.record_applied(p_event_id, 'gm_reveal', p_game_id, jsonb_build_object(
    'number', v_question.number, 'answer', v_key, 'hook', v_hook, 'results', v_results, 'leaders', v_leaders,
    'game_over', v_final, 'next_is_new_round', not v_final and coalesce((v_next ->> 'first_of_round')::boolean, false),
    'next_round', case when v_final then null else v_next ->> 'name' end));
end;
$$;

-- The host's lines may not single out the live answer: naming the right option while leaving out the others (a
-- line may still read all the options out), or saying an estimate's number.
create or replace function private.live_answer_in(p_room_id uuid, p_text text)
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
        (q.kind in ('choice', 'picture', 'teaser', 'lightning', 'connect')
         and p_text ~* ('\m' || private.regex_escape(btrim(q.options ->> (k.answer ->> 'option')::int)) || '\M')
         and exists (select 1 from jsonb_array_elements_text(q.options) with ordinality o(opt, i)
                     where i - 1 <> (k.answer ->> 'option')::int
                       and p_text !~* ('\m' || private.regex_escape(btrim(o.opt)) || '\M')))
        or (q.kind = 'estimate' and p_text ~ ('(^|[^0-9.])' || private.regex_escape(k.answer ->> 'value') || '($|[^0-9])'))
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Generated questions: every kind but pictures, with a hook; teasers may be ungrounded
-- ---------------------------------------------------------------------------

drop function agents_api.save_quiz_question(text, text, smallint, public.age_rating, text, jsonb, jsonb, text, text, text);

create function agents_api.save_quiz_question(
  p_topic text, p_kind text, p_difficulty smallint, p_rating public.age_rating, p_prompt text, p_options jsonb,
  p_answer jsonb, p_unit text, p_source_url text, p_source_quote text, p_hook text, p_clues jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_grounded boolean := p_kind <> 'teaser' or p_source_url is not null;
begin
  if p_kind not in ('choice', 'true_false', 'estimate', 'teaser', 'fake_real', 'lightning', 'order', 'connect') then
    raise exception 'Generated questions are any kind but pictures.' using errcode = '22023';
  end if;
  if v_grounded and coalesce(p_source_url, '') !~ '^https://en\.wikipedia\.org/wiki/[^\s?#]+$' then
    raise exception 'A grounded question''s source is an English Wikipedia article.' using errcode = '22023';
  end if;
  insert into content.quiz_bank (topic, kind, difficulty, rating, prompt, options, answer, unit, source_url,
                                 source_quote, hook, clues, grounded, origin)
  values (lower(btrim(p_topic)), p_kind, p_difficulty, p_rating, btrim(p_prompt), p_options, p_answer,
          nullif(btrim(coalesce(p_unit, '')), ''), case when v_grounded then p_source_url end,
          case when v_grounded then btrim(p_source_quote) end, nullif(btrim(coalesce(p_hook, '')), ''), p_clues,
          v_grounded, 'generated')
  on conflict do nothing
  returning id into v_id;
  return v_id;  -- null: already in the bank
end;
$$;

revoke all on function agents_api.save_quiz_question(text, text, smallint, public.age_rating, text, jsonb, jsonb, text,
                                                     text, text, text, jsonb) from public;
grant execute on function agents_api.save_quiz_question(text, text, smallint, public.age_rating, text, jsonb, jsonb,
                                                        text, text, text, text, jsonb) to agents_svc;

revoke all on function private.is_order(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.quiz_plan(int) from public, anon, authenticated;
revoke all on function private.quiz_round_kinds(text) from public, anon, authenticated;
revoke all on function private.quiz_slot(jsonb, int) from public, anon, authenticated;
revoke all on function private.quiz_total(jsonb) from public, anon, authenticated;
revoke all on all functions in schema game_api from public;
grant execute on all functions in schema game_api to game_master_svc;
