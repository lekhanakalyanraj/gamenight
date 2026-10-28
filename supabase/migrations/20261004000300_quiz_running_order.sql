-- Quiz Night, slice 9b: topics with context, and a quiz prepared in full before it starts.
--
-- Topics and interests: a player picks a short label (for the TV and the bank) and may describe what they're into
-- ("90s Bollywood songs and SRK films"). The description goes to the room's agent with the lobby event, as data.
--
-- The running order: when a quiz starts, the quiz master assembles every question of every round and writes the
-- host's lines for them, then hands it all over in one call (game_api.gm_plan_quiz). From then on the database runs
-- the quiz by itself: when a question's answers close it reveals it, and when a reveal's hold ends it asks the next,
-- saying the prepared line each time (through the same checks as any host line). No model call is needed during play,
-- and no question can go missing: every slot is checked before the first is asked.
-- The running order is private: lead-ins were written without the answers; reveal lines (which may name the answer)
-- are released only at their reveal.

-- ---------------------------------------------------------------------------
-- Topics and interests with context
-- ---------------------------------------------------------------------------

alter table public.room_members
  add column topic_context text check (topic_context is null or char_length(topic_context) between 3 and 160),
  add column interests_context text check (interests_context is null or char_length(interests_context) between 3 and 160);

-- A player's description, tidied: one line, no markup. Null if there's nothing left.
create function private.clean_context(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(regexp_replace(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), '');
begin
  if v is not null and (v ~ '[<>{}]' or char_length(v) not between 3 and 160) then
    raise exception 'Describe it in 3 to 160 characters, without < > { }.' using errcode = '22023';
  end if;
  return v;
end;
$$;

drop function public.set_topic(uuid, text);
create function public.set_topic(p_room_id uuid, p_topic text, p_context text default null)
returns public.room_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.room_members;
  v_topic text := nullif(btrim(regexp_replace(coalesce(p_topic, ''), '\s+', ' ', 'g')), '');
  v_context text := private.clean_context(p_context);
begin
  if v_topic is not null and v_topic !~ '^[[:alpha:][:digit:] &''.,-]{2,30}$' then
    raise exception 'A topic is 2 to 30 letters, numbers and spaces.' using errcode = '22023';
  end if;
  update public.room_members m set topic = v_topic, topic_context = case when v_topic is null then null else v_context end
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

create or replace function private.enqueue_topic_picked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.topic is null or new.left_at is not null
     or (new.topic is not distinct from old.topic and new.topic_context is not distinct from old.topic_context) then
    return null;
  end if;
  insert into dispatch.events (room_id, kind, payload, traceparent)
  values (
    new.room_id, 'topic_picked',
    jsonb_build_object('member_id', new.id, 'topic', new.topic, 'context', new.topic_context),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'traceparent'
  );
  perform pg_notify('dispatch_events', new.room_id::text);
  return null;
end;
$$;
drop trigger room_members_enqueue_topic_picked on public.room_members;
create trigger room_members_enqueue_topic_picked
  after update of topic, topic_context on public.room_members
  for each row execute function private.enqueue_topic_picked();

drop function public.set_interests(uuid, text[]);
create function public.set_interests(p_room_id uuid, p_interests text[], p_context text default null)
returns public.room_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.room_members;
  v_clean text[];
  v_context text := private.clean_context(p_context);
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
  update public.room_members set interests = v_clean, interests_context = case when v_clean is null then null else v_context end
  where id = v_member.id returning * into v_member;
  return v_member;
end;
$$;

create or replace function private.enqueue_interests_picked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only a real change: the same interests in another case are the same interests.
  if new.interests is null or new.left_at is not null
     or ((select array_agg(lower(i) order by lower(i)) from unnest(new.interests) i)
         is not distinct from (select array_agg(lower(i) order by lower(i)) from unnest(old.interests) i)
         and new.interests_context is not distinct from old.interests_context) then
    return null;
  end if;
  insert into dispatch.events (room_id, kind, payload, traceparent)
  values (
    new.room_id, 'interests_picked',
    jsonb_build_object('member_id', new.id, 'interests', to_jsonb(new.interests), 'context', new.interests_context),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'traceparent'
  );
  perform pg_notify('dispatch_events', new.room_id::text);
  return null;
end;
$$;
drop trigger room_members_enqueue_interests_picked on public.room_members;
create trigger room_members_enqueue_interests_picked
  after update of interests, interests_context on public.room_members
  for each row execute function private.enqueue_interests_picked();

-- ---------------------------------------------------------------------------
-- The running order
-- ---------------------------------------------------------------------------

create table private.quiz_running_order (
  game_id uuid not null references public.games (id) on delete cascade,
  number smallint not null check (number >= 1),
  bank_id uuid not null references content.quiz_bank (id),
  for_member uuid references public.room_members (id) on delete set null,
  lead_in text check (lead_in is null or char_length(btrim(lead_in)) between 2 and 200),
  reveal_line text check (reveal_line is null or char_length(btrim(reveal_line)) between 2 and 200),
  primary key (game_id, number),
  unique (game_id, bank_id)
);
create index quiz_running_order_bank_id_idx on private.quiz_running_order (bank_id);
create index quiz_running_order_for_member_idx on private.quiz_running_order (for_member);
alter table private.quiz_running_order enable row level security;  -- no policies: services only, via functions

-- The question-asking core, shared by the quiz master's own move and the running order. The caller holds the game's
-- row lock. Checks the phase, the question (usable here, not asked tonight, a kind this round asks) and the credit.
create function private.quiz_ask(p_game public.games, p_bank_id uuid, p_for_member uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := p_game;
  v_room public.rooms;
  v_bank content.quiz_bank;
  v_number int;
  v_total int;
  v_slot jsonb;
  v_jokers jsonb := '[]';
begin
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
  select count(*) + 1 into v_number from public.quiz_questions where game_id = v_game.id;
  if v_number > v_total then
    raise exception 'Every question has been asked.' using errcode = '55000';
  end if;
  v_slot := private.quiz_slot(v_game.config, v_number);

  select * into v_room from public.rooms where id = v_game.room_id;
  select * into v_bank from content.quiz_bank where id = p_bank_id and status = 'verified';
  if not found or v_bank.rating > v_room.age_rating
     or (v_bank.region is not null and v_bank.region is distinct from v_game.settings ->> 'region')
     or exists (select 1 from private.quiz_keys k where k.room_id = v_game.room_id and k.bank_id = p_bank_id
                and (k.game_id = v_game.id or k.created_at > now() - interval '12 hours')) then
    raise exception 'That question can''t be used here (unknown, not for this room, or asked tonight).'
      using errcode = '22023';
  end if;
  if not (v_slot -> 'kinds') ? v_bank.kind then
    raise exception 'This round (%) asks % questions, not %.', v_slot ->> 'name',
      array_to_string(array(select jsonb_array_elements_text(v_slot -> 'kinds')), ' or '), v_bank.kind
      using errcode = '22023';
  end if;
  if p_for_member is not null and not exists (
       select 1 from public.game_players where game_id = v_game.id and member_id = p_for_member) then
    raise exception 'Credit a question to a player in this game.' using errcode = '22023';
  end if;

  -- Into the final round: the catch-up joker for whoever's last (nobody, if everyone's level).
  if (v_slot ->> 'first_of_round')::boolean and (v_slot ->> 'final_round')::boolean then
    with low as (select min(points) as low, max(points) as high from public.quiz_scores where game_id = v_game.id)
    update public.quiz_scores s set jokers = 1
    from low where s.game_id = v_game.id and s.points = low.low and low.low < low.high;
    select coalesce(jsonb_agg(member_id), '[]') into v_jokers from public.quiz_scores
    where game_id = v_game.id and jokers > 0;
  end if;

  update public.games
  set phase = 'question', step = step + 1, round = (v_slot ->> 'round')::int,
      phase_deadline = now() + make_interval(secs => (v_slot ->> 'seconds')::int), moves_in = 0, resolved = false
  where id = v_game.id
  returning * into v_game;
  insert into private.quiz_keys (game_id, number, room_id, bank_id, answer)
  values (v_game.id, v_number, v_game.room_id, p_bank_id, v_bank.answer);
  insert into public.quiz_questions (game_id, room_id, number, round, step, kind, topic, for_member, difficulty,
                                     prompt, options, unit, image_path, image_credit, clues, seconds)
  values (v_game.id, v_game.room_id, v_number, (v_slot ->> 'round')::int, v_game.step, v_bank.kind, v_bank.topic,
          p_for_member, v_bank.difficulty, v_bank.prompt, v_bank.options, v_bank.unit, v_bank.image_path,
          v_bank.image_credit, v_bank.clues, (v_slot ->> 'seconds')::int);

  return jsonb_build_object(
    'number', v_number, 'of', v_total, 'round', (v_slot ->> 'round')::int, 'round_name', v_slot ->> 'name',
    'kind', v_bank.kind, 'seconds', (v_slot ->> 'seconds')::int, 'step', v_game.step, 'jokers_to', v_jokers,
    'final_round', (v_slot ->> 'final_round')::boolean);
end;
$$;

-- The reveal core: scores the question once its answers have closed, holds the reveal (shorter in lightning), and ends
-- the game after the last question. The caller holds the game's row lock.
create function private.quiz_reveal(p_game public.games)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games := p_game;
  v_question public.quiz_questions;
  v_key jsonb;
  v_source text;
  v_hook text;
  v_grounded boolean;
  v_results jsonb;
  v_answered int;
  v_final boolean;
  v_leaders jsonb;
  v_next jsonb;
begin
  if v_game.kind <> 'quiz' or v_game.phase <> 'question' or v_game.resolved or v_game.phase_deadline is not null
     or v_game.paused_at is not null then
    raise exception 'Reveal a question once its answers have closed.' using errcode = '55000';
  end if;
  select * into v_question from public.quiz_questions where game_id = v_game.id and step = v_game.step;
  select k.answer, b.source_url, b.hook, b.grounded into v_key, v_source, v_hook, v_grounded
  from private.quiz_keys k join content.quiz_bank b on b.id = k.bank_id
  where k.game_id = v_game.id and k.number = v_question.number;
  select count(*) into v_answered from public.quiz_answers where game_id = v_game.id and number = v_question.number;

  if v_question.kind = 'estimate' then
    with ranked as (
      select member_id, rank() over (order by abs((answer ->> 'value')::numeric - (v_key ->> 'value')::numeric)) as place
      from public.quiz_answers where game_id = v_game.id and number = v_question.number
    )
    update public.quiz_answers a
    set correct = r.place = 1,
        points = round(1000.0 * (v_answered - r.place + 1) / v_answered)::int * case when a.joker then 2 else 1 end
    from ranked r
    where a.game_id = v_game.id and a.number = v_question.number and a.member_id = r.member_id;
    select jsonb_build_object('answered', v_answered, 'closest', coalesce(jsonb_agg(jsonb_build_object(
             'member_id', member_id, 'value', answer -> 'value') order by points desc) filter (where correct), '[]'))
    into v_results from public.quiz_answers where game_id = v_game.id and number = v_question.number;
  elsif v_question.kind = 'order' then
    update public.quiz_answers a
    set correct = a.answer = v_key,
        points = case when a.answer = v_key then
                   (500 + round(500 * greatest(0.0, 1 - extract(epoch from a.answered_at - v_question.opened_at)
                                                        / v_question.seconds)))::int
                 else 100 * (select count(*) from generate_series(0, jsonb_array_length(v_key -> 'order') - 1) i
                             where a.answer -> 'order' -> i = v_key -> 'order' -> i)::int end
                 * case when a.joker then 2 else 1 end
    where a.game_id = v_game.id and a.number = v_question.number;
    select jsonb_build_object('answered', v_answered, 'right', count(*) filter (where correct))
    into v_results from public.quiz_answers where game_id = v_game.id and number = v_question.number;
  else
    update public.quiz_answers a
    set correct = a.answer = v_key,
        points = case when a.answer = v_key then
                   (500 + round(500 * greatest(0.0, 1 - extract(epoch from a.answered_at - v_question.opened_at)
                                                        / v_question.seconds)))::int
                   * case when a.joker then 2 else 1 end
                 else 0 end
    where a.game_id = v_game.id and a.number = v_question.number;
    select jsonb_build_object(
             'answered', v_answered,
             'right', count(*) filter (where correct),
             'picks', case when v_question.kind in ('true_false', 'fake_real')
                        then jsonb_build_object('true', count(*) filter (where answer -> 'value' = 'true'),
                                                'false', count(*) filter (where answer -> 'value' = 'false'))
                        else (select coalesce(jsonb_agg(c order by i), '[]') from (
                                select i, count(*) filter (where (x.answer ->> 'option')::int = i) as c
                                from generate_series(0, jsonb_array_length(v_question.options) - 1) i
                                left join public.quiz_answers x on x.game_id = v_game.id and x.number = v_question.number
                                group by i) t) end)
    into v_results from public.quiz_answers where game_id = v_game.id and number = v_question.number;
  end if;

  update public.quiz_scores s
  set points = s.points + a.points, correct = s.correct + case when a.correct then 1 else 0 end
  from public.quiz_answers a
  where a.game_id = v_game.id and a.number = v_question.number and s.game_id = a.game_id and s.member_id = a.member_id;

  update public.quiz_questions
  set answer = v_key, source_url = v_source, hook = v_hook, grounded = v_grounded, results = v_results,
      revealed_at = now()
  where game_id = v_game.id and number = v_question.number;

  v_final := v_question.number >= private.quiz_total(v_game.config);
  v_next := private.quiz_slot(v_game.config, v_question.number + 1);
  select coalesce(jsonb_agg(jsonb_build_object('member_id', member_id, 'points', points) order by points desc), '[]')
  into v_leaders from (select member_id, points from public.quiz_scores where game_id = v_game.id
                       order by points desc limit 3) t;
  if v_final then
    perform private.end_game(v_game.id, null);
  else
    update public.games
    set phase = 'reveal', step = step + 1, resolved = true,
        phase_deadline = now() + make_interval(secs => (private.quiz_slot(config, v_question.number) ->> 'reveal_seconds')::int)
    where id = v_game.id;
  end if;

  return jsonb_build_object(
    'number', v_question.number, 'answer', v_key, 'hook', v_hook, 'results', v_results, 'leaders', v_leaders,
    'game_over', v_final, 'next_is_new_round', not v_final and coalesce((v_next ->> 'first_of_round')::boolean, false),
    'next_round', case when v_final then null else v_next ->> 'name' end);
end;
$$;

create or replace function game_api.gm_ask(p_game_id uuid, p_bank_id uuid, p_for_member uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb := private.applied(p_event_id, 'gm_ask');
begin
  if v_prev is not null then
    return v_prev;
  end if;
  return private.record_applied(p_event_id, 'gm_ask', p_game_id,
    private.quiz_ask(private.gm_game(p_game_id, p_event_id), p_bank_id, p_for_member));
end;
$$;

create or replace function game_api.gm_reveal(p_game_id uuid, p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb := private.applied(p_event_id, 'gm_reveal');
begin
  if v_prev is not null then
    return v_prev;
  end if;
  return private.record_applied(p_event_id, 'gm_reveal', p_game_id,
    private.quiz_reveal(private.gm_game(p_game_id, p_event_id)));
end;
$$;

-- One round's entry in a quiz plan, by name (as private.quiz_plan builds them).
create function private.quiz_round(p_name text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_name
    when 'lightning' then jsonb_build_object('round', p_name, 'questions', 8, 'seconds', 6, 'reveal', 4)
    when 'closest' then jsonb_build_object('round', p_name, 'questions', 5, 'extra', 10, 'reveal', 8)
    when 'order' then jsonb_build_object('round', p_name, 'questions', 5, 'extra', 10, 'reveal', 8)
    when 'connect' then jsonb_build_object('round', p_name, 'questions', 5, 'extra', 10, 'reveal', 8)
    when 'teasers' then jsonb_build_object('round', p_name, 'questions', 5, 'extra', 0, 'reveal', 8)
    when 'fake_real' then jsonb_build_object('round', p_name, 'questions', 5, 'extra', 0, 'reveal', 8)
    when 'picture' then jsonb_build_object('round', p_name, 'questions', 5, 'extra', 0, 'reveal', 8)
    when 'mix' then jsonb_build_object('round', p_name, 'questions', 5, 'extra', 0, 'reveal', 8)
  end;
$$;

-- The quiz master hands over the whole quiz: one item per question, in order ({"bank_id", "for_member", "lead_in",
-- "reveal_line"}). It may swap a round the bank can't fill tonight for another (p_rounds: every round's name, same
-- count, teasers still first and connections still last). Every slot is checked before anything is stored (a kind
-- its round asks, usable here, no repeats), then the first question is asked and its lead-in said.
create function game_api.gm_plan_quiz(p_game_id uuid, p_items jsonb, p_event_id uuid, p_rounds text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb := private.applied(p_event_id, 'gm_plan_quiz');
  v_game public.games;
  v_room public.rooms;
  v_total int;
  v_item jsonb;
  v_n int := 0;
  v_slot jsonb;
  v_bank content.quiz_bank;
  v_asked jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  v_game := private.gm_game(p_game_id, p_event_id);
  if v_game.kind <> 'quiz' or v_game.phase <> 'setup' then
    raise exception 'A quiz is planned once, before its first question.' using errcode = '55000';
  end if;
  if exists (select 1 from private.quiz_running_order where game_id = p_game_id) then
    raise exception 'This quiz already has its running order.' using errcode = '55000';
  end if;
  if p_rounds is not null then
    if cardinality(p_rounds) <> jsonb_array_length(v_game.config -> 'plan') or p_rounds[1] <> 'teasers'
       or p_rounds[cardinality(p_rounds)] <> 'connect'
       or exists (select 1 from unnest(p_rounds) r where private.quiz_round(r) is null)
       or (select count(distinct r) from unnest(p_rounds) r) <> cardinality(p_rounds) then
      raise exception 'Swapped rounds keep their count, teasers first, connections last, each once.' using errcode = '22023';
    end if;
    update public.games set config = config || jsonb_build_object('plan',
      (select jsonb_agg(private.quiz_round(r) order by i) from unnest(p_rounds) with ordinality t(r, i)))
    where id = p_game_id returning * into v_game;
  end if;
  v_total := private.quiz_total(v_game.config);
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) <> v_total then
    raise exception 'The running order needs exactly % questions.', v_total using errcode = '22023';
  end if;
  select * into v_room from public.rooms where id = v_game.room_id;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    v_slot := private.quiz_slot(v_game.config, v_n);
    select * into v_bank from content.quiz_bank where id = (v_item ->> 'bank_id')::uuid and status = 'verified';
    if not found or v_bank.rating > v_room.age_rating
       or (v_bank.region is not null and v_bank.region is distinct from v_game.settings ->> 'region')
       or exists (select 1 from private.quiz_keys k where k.room_id = v_game.room_id and k.bank_id = v_bank.id
                  and k.created_at > now() - interval '12 hours') then
      raise exception 'Question % can''t be used here (unknown, not for this room, or asked tonight).', v_n
        using errcode = '22023';
    end if;
    if not (v_slot -> 'kinds') ? v_bank.kind then
      raise exception 'Question % is in the % round, which asks %, not %.', v_n, v_slot ->> 'name',
        array_to_string(array(select jsonb_array_elements_text(v_slot -> 'kinds')), ' or '), v_bank.kind
        using errcode = '22023';
    end if;
    if v_item ->> 'for_member' is not null and not exists (
         select 1 from public.game_players where game_id = p_game_id and member_id = (v_item ->> 'for_member')::uuid) then
      raise exception 'Question % is credited to someone not in this game.', v_n using errcode = '22023';
    end if;
    insert into private.quiz_running_order (game_id, number, bank_id, for_member, lead_in, reveal_line)
    values (p_game_id, v_n, v_bank.id, (v_item ->> 'for_member')::uuid,
            nullif(btrim(coalesce(v_item ->> 'lead_in', '')), ''), nullif(btrim(coalesce(v_item ->> 'reveal_line', '')), ''));
  end loop;

  v_asked := private.quiz_ask_planned(v_game, 1);
  return private.record_applied(p_event_id, 'gm_plan_quiz', p_game_id,
    jsonb_build_object('planned', v_total, 'asked', v_asked));
end;
$$;

-- A host line through every check. The rate limit is for lines a model writes as it goes; a planned quiz's script is
-- fixed before it starts (a lead-in and a reveal line per question), so it isn't limited, or a fast round would lose
-- its lines. It still can't say a live answer or a secret word.
create function private.speak(p_room_id uuid, p_text text, p_kind text, p_event_id uuid, p_limited boolean)
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
  if p_limited and (select count(*) from public.host_lines
                    where room_id = p_room_id and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'The host has said enough for now in room %.', p_room_id using errcode = 'PT429';
  end if;

  insert into public.host_lines (room_id, kind, text, event_id)
  values (p_room_id, p_kind, v_text, p_event_id)
  returning * into v_line;
  return v_line;
end;
$$;

revoke all on function private.speak(uuid, text, text, uuid, boolean) from public, anon, authenticated;

create or replace function private.say(p_room_id uuid, p_text text, p_kind text, p_event_id uuid)
returns public.host_lines
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.speak(p_room_id, p_text, p_kind, p_event_id, true);
end;
$$;

-- Asks a planned question and says its lead-in. A line the checks refuse is dropped, never the question.
create function private.quiz_ask_planned(p_game public.games, p_number int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order private.quiz_running_order;
  v_asked jsonb;
begin
  select * into v_order from private.quiz_running_order where game_id = p_game.id and number = p_number;
  v_asked := private.quiz_ask(p_game, v_order.bank_id, v_order.for_member);
  if v_order.lead_in is not null then
    begin
      perform private.speak(p_game.room_id, v_order.lead_in, 'narration', null, false);
    exception when others then
      null;  -- a refused line (a live answer): the question goes on without it
    end;
  end if;
  return v_asked;
end;
$$;

-- The quiz runs itself once planned: when a question's answers close (everyone's in, time's up, or the host closed
-- it) it's revealed; when a reveal's hold ends, the next question opens. A pause clears the deadline too, but sets
-- paused_at in the same update, so it doesn't count.
create function private.quiz_autopilot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_number int;
  v_line text;
  v_top record;
begin
  if not exists (select 1 from private.quiz_running_order where game_id = new.id) then
    return null;
  end if;
  select * into v_game from public.games where id = new.id for update;
  if v_game.paused_at is not null or v_game.phase_deadline is not null then
    return null;
  end if;
  if v_game.phase = 'question' and not v_game.resolved then
    select count(*) into v_number from public.quiz_questions where game_id = v_game.id;
    perform private.quiz_reveal(v_game);
    select reveal_line into v_line from private.quiz_running_order where game_id = v_game.id and number = v_number;
    if v_line is not null then
      begin
        perform private.speak(v_game.room_id, v_line, 'narration', null, false);
      exception when others then
        null;
      end;
    end if;
    select * into v_game from public.games where id = new.id;
    if v_game.phase = 'ended' then  -- the last question: the winner, from the final standings
      select m.nickname, s.points into v_top from public.quiz_scores s join public.room_members m on m.id = s.member_id
      where s.game_id = v_game.id order by s.points desc limit 1;
      if found then
        begin
          perform private.speak(v_game.room_id, format('That''s a wrap. %s takes it with %s points.', v_top.nickname,
                                                      v_top.points), 'narration', null, false);
        exception when others then
          null;
        end;
      end if;
    end if;
  elsif v_game.phase = 'reveal' then
    select count(*) + 1 into v_number from public.quiz_questions where game_id = v_game.id;
    if exists (select 1 from private.quiz_running_order where game_id = v_game.id and number = v_number) then
      perform private.quiz_ask_planned(v_game, v_number);
    end if;
  end if;
  return null;
end;
$$;

create trigger games_quiz_autopilot
  after update of phase_deadline on public.games
  for each row
  when (new.kind = 'quiz' and new.phase_deadline is null and old.phase_deadline is not null and new.paused_at is null)
  execute function private.quiz_autopilot();

-- What the quiz master reads now says whether the quiz is planned (it then has nothing to do during play).
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
    'planned', exists (select 1 from private.quiz_running_order o where o.game_id = g.id),
    'asked', (select count(*) from public.quiz_questions q where q.game_id = g.id),
    'total', private.quiz_total(g.config),
    'next', private.quiz_slot(g.config, (select count(*)::int + 1 from public.quiz_questions q where q.game_id = g.id)),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'member_id', p.member_id, 'nickname', m.nickname, 'topic', m.topic, 'topic_context', m.topic_context,
                  'in_room', m.left_at is null, 'points', s.points, 'correct', s.correct, 'jokers', s.jokers)
                  order by s.points desc, p.seat), '[]')
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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Generated questions from the web: any https page but a user-written or social site
-- ---------------------------------------------------------------------------

-- The same list as the agents' (services/agents/src/gamenight_agents/sources.py): the agents never search these, and
-- the database refuses them anyway.
create function private.source_blocked(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_url is null
      or p_url !~* '^https://[^\s/?#]+\.[a-z]{2,}(/\S*)?$'
      or exists (
        select 1
        from unnest(array['reddit.com', 'quora.com', 'answers.com', 'fandom.com', 'wikia.com', 'facebook.com',
                          'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'threads.net', 'pinterest.com',
                          'tumblr.com', 'youtube.com', 'medium.com', 'substack.com', 'blogspot.com', 'wordpress.com',
                          'stackexchange.com', 'stackoverflow.com', '4chan.org', 'linkedin.com', 'brainly.com',
                          'chegg.com', 'coursehero.com', 'scribd.com', 'wikihow.com', 'everything2.com', 'imdb.com'])
               as d(site),
             lateral (select regexp_replace(lower(substring(p_url from '^https://([^/?#:]+)')), '^www\.', '') as host) h
        where h.host = d.site or h.host like '%.' || d.site);
$$;

create or replace function agents_api.save_quiz_question(
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
  if v_grounded and private.source_blocked(p_source_url) then
    raise exception 'A grounded question''s source is an https page, never a forum or a social site.'
      using errcode = '22023';
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

revoke all on function private.source_blocked(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The TV's pets: a dog and a cat along the bottom of the screen, on unless the host switches them off
-- ---------------------------------------------------------------------------

alter table public.rooms add column pets boolean not null default true;

create function public.set_pets(p_room_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_on is null then
    raise exception 'Say whether the pets are on or off.' using errcode = '22023';
  end if;
  update public.rooms set pets = p_on
  where id = p_room_id and host_id = (select auth.uid()) and status <> 'closed';
  if not found then
    raise exception 'Only the host can turn the pets on or off.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.set_pets(uuid, boolean) from public, anon;
grant execute on function public.set_pets(uuid, boolean) to authenticated;

revoke all on function public.set_topic(uuid, text, text) from public, anon;
grant execute on function public.set_topic(uuid, text, text) to authenticated;
revoke all on function public.set_interests(uuid, text[], text) from public, anon;
grant execute on function public.set_interests(uuid, text[], text) to authenticated;
revoke all on function private.clean_context(text) from public, anon, authenticated;
revoke all on function private.quiz_ask(public.games, uuid, uuid) from public, anon, authenticated;
revoke all on function private.quiz_reveal(public.games) from public, anon, authenticated;
revoke all on function private.quiz_ask_planned(public.games, int) from public, anon, authenticated;
revoke all on function private.quiz_autopilot() from public, anon, authenticated;
revoke all on function private.quiz_round(text) from public, anon, authenticated;
revoke all on all functions in schema game_api from public;
grant execute on all functions in schema game_api to game_master_svc;
