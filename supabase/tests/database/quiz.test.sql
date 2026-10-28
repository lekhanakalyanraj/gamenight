begin;
create extension if not exists pgtap with schema extensions;

-- Quiz Night played through the database: settings, topics, the rounds (each asks its own kinds), asking, answering
-- every kind, who can see the answer and its hook when, scoring (speed bonus, in order, estimates, the joker), timers
-- (lightning's 6 seconds and short reveals), the host's skip, picture rounds, the host's lines never singling out
-- the live answer, and the end. Two games: a short one (3 rounds) and a full one (8 rounds).

select plan(81);

create function pg_temp.act_as(p_uid uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;
create temp table ids (k text primary key, id uuid, v text) on commit drop;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select id from ids where k = p_k $$;
-- A test question: "Test <kind> <n>".
create function pg_temp.q(p_kind text, p_n int) returns uuid language sql as $$
  select id from content.quiz_bank where topic = 'testing' and prompt = format('Test %s %s', p_kind, p_n)
$$;
-- The quiz master's moves, as game_master_svc (with a fresh event id each time).
create function pg_temp.ask(p_bank uuid, p_for uuid default null) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role game_master_svc;
  r := game_api.gm_ask(pg_temp.id('game'), p_bank, p_for, gen_random_uuid());
  reset role;
  return r;
end $$;
create function pg_temp.reveal() returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role game_master_svc;
  r := game_api.gm_reveal(pg_temp.id('game'), gen_random_uuid());
  reset role;
  return r;
end $$;
-- The quiz master says a line (pgTAP can't run as game_master_svc, so the role switch stays inside).
create function pg_temp.say(p_text text) returns void language plpgsql as $$
begin
  set local role game_master_svc;
  perform game_api.say(pg_temp.id('game'), p_text, gen_random_uuid());
  reset role;
end $$;
-- Time runs out: the dispatcher fires the deadline, as it does every second.
create function pg_temp.time_up() returns void language plpgsql as $$
begin
  update public.games set phase_deadline = now() - interval '1 second' where id = pg_temp.id('game');
  set local role dispatcher_svc;
  perform dispatch.fire_due_deadlines();
  reset role;
end $$;
create function pg_temp.answer(p_who text, p_answer jsonb) returns public.quiz_answers language plpgsql as $$
declare r public.quiz_answers;
begin
  perform pg_temp.act_as((select v::uuid from ids where k = p_who));
  r := public.answer_question(pg_temp.id('game'), p_answer, gen_random_uuid());
  perform pg_temp.act_as_admin();
  return r;
end $$;
-- Ask questions n to m of a kind with nobody answering, each revealed and its reveal timed out.
create function pg_temp.play(p_kind text, p_from int, p_to int) returns void language plpgsql as $$
begin
  for i in p_from .. p_to loop
    perform pg_temp.time_up();
    perform pg_temp.ask(pg_temp.q(p_kind, i));
    perform pg_temp.time_up();
    perform pg_temp.reveal();
  end loop;
end $$;
-- Answered this many seconds after the question opened.
create function pg_temp.answered_after(p_who text, p_number int, p_seconds int) returns void language sql as $$
  update public.quiz_answers a set answered_at = q.opened_at + make_interval(secs => p_seconds)
  from public.quiz_questions q
  where q.game_id = a.game_id and q.number = a.number and a.game_id = pg_temp.id('game') and a.number = p_number
    and a.member_id = pg_temp.id(p_who);
$$;

grant game_master_svc, dispatcher_svc to postgres;
grant select on ids to authenticated, game_master_svc, dispatcher_svc;
grant execute on function pg_temp.id(text) to game_master_svc;

-- ---- test questions: every kind --------------------------------------------------------------------------------
insert into content.quiz_bank (topic, kind, difficulty, prompt, options, answer, unit, source_url, source_quote, hook,
                               clues, grounded)
select 'testing', k.kind, 1, format('Test %s %s', k.kind, n),
       case k.kind
         when 'teaser' then case when n = 2 then '["Sydney", "Melbourne", "Canberra", "Perth"]'
                                 else '["Venus", "Mars", "Jupiter", "Saturn"]' end::jsonb
         when 'lightning' then '["Yes", "No"]'::jsonb
         when 'order' then '["A", "B", "C", "D"]'::jsonb
         when 'connect' then '["Red", "Blue", "Green", "Pink"]'::jsonb
         when 'choice' then '["Red", "Blue", "Green", "Pink"]'::jsonb end,
       case k.kind
         when 'teaser' then case when n = 2 then '{"option": 2}' else '{"option": 1}' end::jsonb
         when 'fake_real' then jsonb_build_object('value', n % 2 = 0)
         when 'order' then '{"order": [2, 0, 3, 1]}'::jsonb
         when 'estimate' then '{"value": 8848.86}'::jsonb
         when 'lightning' then '{"option": 0}'::jsonb
         else '{"option": 1}'::jsonb end,
       case k.kind when 'order' then 'oldest first' when 'estimate' then 'metres' end,
       case when k.kind <> 'teaser' then 'https://en.wikipedia.org/wiki/Test' end,
       case when k.kind <> 'teaser' then 'A sentence that backs the answer.' end,
       'Mars is red because of rust.',
       case when k.kind = 'connect' then '["one", "two", "three"]'::jsonb end,
       k.kind <> 'teaser'
from (values ('teaser', 15), ('fake_real', 15), ('lightning', 8), ('choice', 5), ('order', 5), ('estimate', 5),
             ('connect', 15)) k(kind, many),
     generate_series(1, k.many) n;

-- ---- a room: the host and three guests, a TV, and an outsider --------------------------------------------------
insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false);
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-000000000101', true), ('00000000-0000-0000-0000-000000000102', true),
  ('00000000-0000-0000-0000-000000000103', true), ('00000000-0000-0000-0000-000000000105', true);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.create_room('Priya');
select pg_temp.act_as_admin();
insert into ids (k, id, v) select 'room', id, code from public.rooms where host_id = '00000000-0000-0000-0000-00000000000a';
select pg_temp.act_as('00000000-0000-0000-0000-000000000101'); select public.join_room((select v from ids where k = 'room'), 'Asha');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102'); select public.join_room((select v from ids where k = 'room'), 'Ben');
select pg_temp.act_as('00000000-0000-0000-0000-000000000103'); select public.join_room((select v from ids where k = 'room'), 'Chen');
select pg_temp.act_as_admin();
insert into ids (k, id, v) select lower(nickname), id, user_id::text from public.room_members where room_id = pg_temp.id('room');
insert into ids (k, v) values ('outsider', '00000000-0000-0000-0000-000000000105');

-- ---- topics, in the lobby -------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select is((public.set_topic(pg_temp.id('room'), '  Cricket  ')).topic, 'Cricket', 'a player picks a topic');
select throws_ok(format($$ select public.set_topic(%L, 'x') $$, pg_temp.id('room')), '22023', null,
                 'a topic is 2 to 30 letters and numbers');
select throws_ok(format($$ select public.set_topic(%L, '<script>alert(1)</script>') $$, pg_temp.id('room')), '22023', null,
                 'no markup in a topic');
select pg_temp.act_as('00000000-0000-0000-0000-000000000105');
select throws_ok(format($$ select public.set_topic(%L, 'music') $$, pg_temp.id('room')), '42501', null,
                 'only players in the room pick topics');

-- ---- starting a short quiz ----------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok(format($$ select public.start_game(%L, 'quiz', '{"rounds": 4}') $$, pg_temp.id('room')), '22023', null,
                 'a quiz is 3, 5 or 8 rounds');
select throws_ok(format($$ select public.start_game(%L, 'quiz', '{"seconds": 15}') $$, pg_temp.id('room')), '22023', null,
                 'seconds are 10, 20 or 30');
select throws_ok(format($$ select public.start_game(%L, 'quiz', '{"theme": "food"}') $$, pg_temp.id('room')), '22023', null,
                 'a quiz takes only its own settings');
select lives_ok(format($$ select public.start_game(%L, 'quiz', '{"rounds": 3, "seconds": 20}') $$, pg_temp.id('room')),
                'the host starts a short quiz with 20 seconds a question');
select pg_temp.act_as_admin();
insert into ids (k, id) select 'game', id from public.games where room_id = pg_temp.id('room');
select is((select array_agg(r ->> 'round' order by i) from public.games g,
           jsonb_array_elements(g.config -> 'plan') with ordinality t(r, i) where g.id = pg_temp.id('game')),
          array['teasers', 'fake_real', 'connect'], 'a short quiz: brain teasers first, connections last');
select is((select (config ->> 'seconds')::int from public.games where id = pg_temp.id('game')), 20,
          'with the host''s seconds');
select is((select count(*)::int from public.quiz_scores where game_id = pg_temp.id('game')), 4,
          'everyone starts on the leaderboard');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select throws_ok(format($$ select public.set_topic(%L, 'music') $$, pg_temp.id('room')), '42501', null,
                 'topics are picked in the lobby, not mid-game');

-- ---- nobody but the quiz master reaches the bank or the keys ------------------------------------------------------
select throws_ok($$ select * from content.quiz_bank $$, '42501', null, 'players can''t read the question bank');
select throws_ok($$ select * from private.quiz_keys $$, '42501', null, 'players can''t read the answer keys');
select pg_temp.act_as_admin();
set local role game_master_svc;
create temp table bank_seen on commit drop as select game_api.quiz_bank(pg_temp.id('game'), 'testing', 'teaser') as b;
reset role;
select ok((select jsonb_array_length(b) from bank_seen) > 0, 'the quiz master finds questions by topic and kind');
select ok((select bool_and(q ->> 'topic' = 'testing' and q ->> 'kind' = 'teaser') from bank_seen, jsonb_array_elements(b) q),
          'only those');

-- ---- round one: brain teasers ---------------------------------------------------------------------------------------
select throws_ok(format($$ select pg_temp.ask(%L) $$, gen_random_uuid()), '22023', null,
                 'an unknown question is refused');
select throws_ok($$ select pg_temp.ask(pg_temp.q('fake_real', 1)) $$, '22023', null,
                 'each round asks its own kinds: no fake or real in the teasers');
select is((pg_temp.ask(pg_temp.q('teaser', 1), pg_temp.id('asha')) ->> 'round_name'), 'teasers',
          'the first question is a teaser, for Asha');
select throws_ok($$ select pg_temp.ask(pg_temp.q('teaser', 2)) $$, '55000', null, 'one question at a time');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select row(prompt, answer, hook)::text from public.quiz_questions where game_id = pg_temp.id('game') and number = 1),
          row('Test teaser 1', null::jsonb, null::text)::text, 'players see the question, not its answer or hook');

select pg_temp.act_as_admin();
select throws_ok($$ select pg_temp.answer('asha', '{"option": 7}') $$, '22023', null, 'an option that doesn''t exist');
select throws_ok($$ select pg_temp.answer('asha', '{"value": true}') $$, '22023', null, 'an answer of the wrong kind');
select throws_ok($$ select pg_temp.answer('asha', '{"option": "Mars"}') $$, '22023', null, 'an option as text');
select lives_ok($$ select pg_temp.answer('asha', '{"option": 1}') $$, 'Asha answers Mars');
select throws_ok($$ select pg_temp.answer('asha', '{"option": 0}') $$, '23505', null, 'one answer each');
select pg_temp.act_as('00000000-0000-0000-0000-000000000105');
select throws_ok(format($$ select public.answer_question(%L, '{"option": 1}', gen_random_uuid()) $$, pg_temp.id('game')),
                 '42501', null, 'outsiders can''t answer');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select count(*)::int from public.quiz_answers where game_id = pg_temp.id('game')), 0,
          'Ben can''t see Asha''s answer before the reveal');
select pg_temp.act_as_admin();
select throws_ok($$ select pg_temp.reveal() $$, '55000', null, 'no reveal while answers are open');
select pg_temp.answer('ben', '{"option": 0}');
select pg_temp.answer('chen', '{"option": 1}');
select pg_temp.answered_after('asha', 1, 5);
select pg_temp.answered_after('chen', 1, 15);
select pg_temp.answer('priya', '{"option": 2}');
select is((select phase_deadline from public.games where id = pg_temp.id('game')), null,
          'everyone has answered: the question closes');

select is((pg_temp.reveal() -> 'hook'), '"Mars is red because of rust."'::jsonb, 'the reveal gives the hook');
select is((select jsonb_object_agg(member_id, points) from public.quiz_answers where game_id = pg_temp.id('game')),
          jsonb_build_object(pg_temp.id('asha'), 875, pg_temp.id('chen'), 625, pg_temp.id('ben'), 0,
                             pg_temp.id('priya'), 0),
          'right answers score 500 to 1,000 by speed; wrong ones score nothing');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select row(answer, hook, grounded, source_url, results -> 'picks')::text from public.quiz_questions
           where game_id = pg_temp.id('game') and number = 1),
          row('{"option": 1}'::jsonb, 'Mars is red because of rust.', false, null::text, '[1, 2, 1, 0]'::jsonb)::text,
          'after the reveal: the answer, the hook, no source (a puzzle), and how the room answered');
select pg_temp.act_as_admin();
select throws_ok($$ select pg_temp.ask(pg_temp.q('teaser', 2)) $$, '55000', null,
                 'the next question waits for the reveal''s time');
select pg_temp.time_up();

-- the host's lines can't single out the live answer
select pg_temp.ask(pg_temp.q('teaser', 2));
select throws_ok($$ select pg_temp.say('It''s Canberra, obviously!') $$, 'GN001', null,
                 'a line naming only the right answer is refused');
select lives_ok($$ select pg_temp.say('Sydney, Melbourne, Canberra or Perth?') $$, 'reading out every option is fine');
-- the host skips
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select lives_ok(format($$ select public.skip_phase(%L) $$, pg_temp.id('game')), 'the host closes the question early');
select pg_temp.act_as_admin();
select is(pg_temp.reveal() -> 'results' ->> 'answered', '0', 'nobody answered: nobody scores');
select pg_temp.play('teaser', 3, 5);

-- ---- round two: fake or real ---------------------------------------------------------------------------------------
select pg_temp.time_up();
select is((pg_temp.ask(pg_temp.q('fake_real', 1)) ->> 'round_name'), 'fake_real', 'round two is fake or real');
select throws_ok($$ select pg_temp.answer('ben', '{"option": 0}') $$, '22023', null, 'fake or real takes true or false');
select pg_temp.answer('ben', '{"value": false}');
select pg_temp.answer('asha', '{"value": true}');
select pg_temp.time_up();
select pg_temp.reveal();
select is((select row(results -> 'picks', results -> 'right')::text from public.quiz_questions
           where game_id = pg_temp.id('game') and number = 6),
          row('{"true": 1, "false": 1}'::jsonb, '1'::jsonb)::text, 'Ben spots the fake; Asha falls for it');
select pg_temp.play('fake_real', 2, 5);

-- ---- the finale: connections, and the catch-up joker ----------------------------------------------------------------
select pg_temp.time_up();
create temp table finale on commit drop as select pg_temp.ask(pg_temp.q('connect', 1)) as r;
select is((select r -> 'jokers_to' from finale), jsonb_build_array(pg_temp.id('priya')),
          'going into the final round, whoever is last gets the joker');
select is((select (r ->> 'seconds')::int from finale), 30, 'connections get 10 more seconds');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select clues from public.quiz_questions where game_id = pg_temp.id('game') and number = 11),
          '["one", "two", "three"]'::jsonb, 'players see the clues');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select throws_ok(format($$ select public.play_joker(%L) $$, pg_temp.id('game')), '55000', null,
                 'only the player in last place has a joker');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select lives_ok(format($$ select public.play_joker(%L) $$, pg_temp.id('game')), 'Priya plays her joker');
select pg_temp.act_as_admin();
select pg_temp.answer('priya', '{"option": 1}');
select pg_temp.answered_after('priya', 11, 10);
select pg_temp.time_up();
select pg_temp.reveal();
select is((select points from public.quiz_answers where game_id = pg_temp.id('game') and number = 11
           and member_id = pg_temp.id('priya')), 1666, 'the joker doubles her points (833, a third of the way in)');
select pg_temp.play('connect', 2, 5);
select is((select phase::text from public.games where id = pg_temp.id('game')), 'ended', 'after question 15, it''s over');
select is((select reveal -> 'standings' -> 0 ->> 'member_id' from public.games where id = pg_temp.id('game')),
          pg_temp.id('priya')::text, 'the final standings, Priya on top after her joker');
select is((select status::text from public.rooms where id = pg_temp.id('room')), 'lobby', 'the room is back in the lobby');
select ok((select bool_and(answer is not null) from public.quiz_questions where game_id = pg_temp.id('game')),
          'every answer was revealed');
select throws_ok($$ select pg_temp.ask(pg_temp.q('connect', 6)) $$, '55000', null, 'nothing more can be asked');

-- ---- a full quiz: every round --------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.start_game(pg_temp.id('room'), 'quiz', '{"rounds": 8, "seconds": 10}');
select pg_temp.act_as_admin();
update ids set id = (select id from public.games where room_id = pg_temp.id('room') and phase <> 'ended') where k = 'game';
select is((select array_agg(r ->> 'round' order by i) from public.games g,
           jsonb_array_elements(g.config -> 'plan') with ordinality t(r, i) where g.id = pg_temp.id('game')),
          array['teasers', 'fake_real', 'lightning', 'picture', 'mix', 'order', 'closest', 'connect'],
          'a full quiz has every round, in order');
select pg_temp.play('teaser', 6, 10);
select pg_temp.play('fake_real', 6, 10);

-- lightning: 6 seconds whatever the host picked, and a short reveal
select pg_temp.time_up();
select is((pg_temp.ask(pg_temp.q('lightning', 1)) ->> 'seconds')::int, 6, 'a lightning question gets 6 seconds');
select pg_temp.time_up();
select pg_temp.reveal();
select is((select extract(epoch from phase_deadline - now())::int from public.games where id = pg_temp.id('game')), 4,
          'and its reveal holds for 4');
select pg_temp.play('lightning', 2, 8);

-- pictures: an image is readable only once its question is asked, and only by the room
insert into ids (k, v) select 'saturn', image_path from content.quiz_bank where prompt = 'Which planet is this?'
  and options ->> 1 = 'Saturn';
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select count(*)::int from storage.objects where bucket_id = 'quiz-images'
           and name = (select v from ids where k = 'saturn')), 0, 'a picture can''t be seen before it''s asked');
select pg_temp.act_as_admin();
select pg_temp.time_up();
select pg_temp.ask((select id from content.quiz_bank where image_path = (select v from ids where k = 'saturn')));
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select count(*)::int from storage.objects where bucket_id = 'quiz-images'
           and name = (select v from ids where k = 'saturn')), 1, 'once asked, the room sees it');
select pg_temp.act_as('00000000-0000-0000-0000-000000000105');
select is((select count(*)::int from storage.objects where bucket_id = 'quiz-images'
           and name = (select v from ids where k = 'saturn')), 0, 'an outsider never does');
select pg_temp.act_as_admin();
select pg_temp.time_up();
select pg_temp.reveal();
do $$
declare q record;
begin
  for q in select id from content.quiz_bank b where b.kind = 'picture' and b.status = 'verified' and b.region is null
           and not exists (select 1 from private.quiz_keys k where k.game_id = pg_temp.id('game') and k.bank_id = b.id)
           limit 4 loop
    perform pg_temp.time_up();
    perform pg_temp.ask(q.id);
    perform pg_temp.time_up();
    perform pg_temp.reveal();
  end loop;
end $$;
select pg_temp.play('choice', 1, 5);

-- in order: all right scores by speed; otherwise 100 for each item in its place
select pg_temp.time_up();
select is((pg_temp.ask(pg_temp.q('order', 1)) ->> 'seconds')::int, 20, 'an in-order question gets 10 more seconds');
select throws_ok($$ select pg_temp.answer('chen', '{"order": [0, 0, 1, 2]}') $$, '22023', null,
                 'an order uses every item once');
select throws_ok($$ select pg_temp.answer('chen', '{"order": [0, 1, 2]}') $$, '22023', null, 'and all of them');
select pg_temp.answer('asha', '{"order": [2, 0, 3, 1]}');
select pg_temp.answered_after('asha', 29, 10);
select pg_temp.answer('ben', '{"order": [2, 0, 1, 3]}');
select pg_temp.answer('chen', '{"order": [3, 1, 2, 0]}');
select pg_temp.time_up();
select pg_temp.reveal();
select is((select jsonb_object_agg(member_id, points) from public.quiz_answers
           where game_id = pg_temp.id('game') and number = 29),
          jsonb_build_object(pg_temp.id('asha'), 750, pg_temp.id('ben'), 200, pg_temp.id('chen'), 0),
          'Asha has it all right (halfway through: 750); Ben has two in place (200)');
select pg_temp.play('order', 2, 5);

-- closest wins
select pg_temp.time_up();
select is((pg_temp.ask(pg_temp.q('estimate', 1)) ->> 'seconds')::int, 20, 'an estimate gets 10 more seconds');
select throws_ok($$ select pg_temp.say('Is it 8848.86 metres?') $$, 'GN001', null,
                 'a line saying the estimate''s number is refused');
select pg_temp.answer('asha', '{"value": 9000}');
select pg_temp.answer('ben', '{"value": 8800}');
select pg_temp.answer('chen', '{"value": 5000}');
select pg_temp.time_up();
select pg_temp.reveal();
select is((select jsonb_object_agg(member_id, points) from public.quiz_answers
           where game_id = pg_temp.id('game') and number = 34),
          jsonb_build_object(pg_temp.id('ben'), 1000, pg_temp.id('asha'), 667, pg_temp.id('chen'), 333),
          'estimates score by how close they came');
select pg_temp.play('estimate', 2, 5);
select pg_temp.play('connect', 6, 10);
select is((select phase::text from public.games where id = pg_temp.id('game')), 'ended',
          'after question 43, the full quiz is over');

-- ---- topics with context ------------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select is((public.set_topic(pg_temp.id('room'), 'F1', '  The Verstappen era,
and Monaco  ')).topic_context, 'The Verstappen era, and Monaco', 'a topic comes with its context, tidied to one line');
select throws_ok(format($$ select public.set_topic(%L, 'F1', '<b>bold</b>') $$, pg_temp.id('room')), '22023', null,
                 'no markup in a topic''s context');
select pg_temp.act_as_admin();
select is((select payload ->> 'context' from dispatch.events where room_id = pg_temp.id('room') and kind = 'topic_picked'
           and payload ->> 'topic' = 'F1'), 'The Verstappen era, and Monaco', 'and the room''s agent is told it');

-- ---- a planned quiz: the database runs it ----------------------------------------------------------------------------
create function pg_temp.plan(p_items jsonb) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role game_master_svc;
  r := game_api.gm_plan_quiz(pg_temp.id('game'), p_items, gen_random_uuid());
  reset role;
  return r;
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.start_game(pg_temp.id('room'), 'quiz', '{"rounds": 3, "seconds": 20}');
select pg_temp.act_as_admin();
update ids set id = (select id from public.games where room_id = pg_temp.id('room') and phase <> 'ended') where k = 'game';
create temp table running on commit drop as
select jsonb_agg(jsonb_build_object('bank_id', pg_temp.q(kind, n), 'for_member', null,
                                    'lead_in', format('Lead-in %s.', i), 'reveal_line', format('Reveal line %s.', i))
                 order by i) as items
from (select row_number() over () as i, kind, n from (
        select 'teaser' as kind, n, 1 as r from generate_series(11, 15) n union all
        select 'fake_real', n, 2 from generate_series(11, 15) n union all
        select 'connect', n, 3 from generate_series(11, 15) n order by r, n) o) t;
select throws_ok($$ select pg_temp.plan((select items - 0 from running)) $$, '22023', null,
                 'a running order fills every slot');
select throws_ok($$ select pg_temp.plan(jsonb_set((select items from running), '{0,bank_id}',
                                                  to_jsonb(pg_temp.q('connect', 11)))) $$, '22023', null,
                 'and every slot holds a kind its round asks');
select is((pg_temp.plan((select items from running)) ->> 'planned')::int, 15, 'the quiz master hands over the whole quiz');
select is((select row(phase::text, (select count(*) from public.quiz_questions where game_id = pg_temp.id('game')))::text
           from public.games where id = pg_temp.id('game')), row('question', 1)::text, 'and the first question opens');
select ok(exists (select 1 from public.host_lines where room_id = pg_temp.id('room') and text = 'Lead-in 1.'),
          'with its lead-in said');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select throws_ok($$ select * from private.quiz_running_order $$, '42501', null, 'players can''t read the running order');
select pg_temp.act_as_admin();
select pg_temp.answer('priya', '{"option": 1}');
select pg_temp.answer('asha', '{"option": 1}');
select pg_temp.answer('ben', '{"option": 0}');
select pg_temp.answer('chen', '{"option": 1}');
select is((select row(phase::text, resolved)::text from public.games where id = pg_temp.id('game')),
          row('reveal', true)::text, 'everyone''s in: the database reveals it, no quiz master needed');
select ok(exists (select 1 from public.host_lines where room_id = pg_temp.id('room') and text = 'Reveal line 1.'),
          'and says the reveal line, only now');
select pg_temp.time_up();
select is((select count(*)::int from public.quiz_questions where game_id = pg_temp.id('game')), 2,
          'the reveal''s hold ends: the next question opens by itself');
do $$ begin
  for i in 2 .. 15 loop
    perform pg_temp.time_up();  -- answers close
    if i < 15 then perform pg_temp.time_up(); end if;  -- the reveal's hold ends, the next opens
  end loop;
end $$;
select is((select phase::text from public.games where id = pg_temp.id('game')), 'ended', 'the planned quiz plays to the end');
select ok(exists (select 1 from public.host_lines where room_id = pg_temp.id('room') and text like 'That''s a wrap.%'),
          'and the winner is named');
select is((select count(*)::int from public.host_lines where room_id = pg_temp.id('room')
           and (text like 'Lead-in %' or text like 'Reveal line %')), 30,
          'every line of the script is said, though the whole quiz played in an instant (it isn''t rate-limited)');

select pg_temp.act_as_admin();
select * from finish();
rollback;
