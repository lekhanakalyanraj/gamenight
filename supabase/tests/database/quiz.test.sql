begin;
create extension if not exists pgtap with schema extensions;

-- A game of Quiz Night played through the database: settings, topics, asking, answering, who can see the answer
-- when, scoring (speed bonus, estimates, the joker), timers, the host's skip, the reveal, picture rounds, the
-- host's lines never singling out the live answer, and the end.

select plan(56);

create function pg_temp.act_as(p_uid uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;
create temp table ids (k text primary key, id uuid, v text) on commit drop;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select id from ids where k = p_k $$;
create function pg_temp.bank(p_prompt text, p_image boolean default false) returns uuid language sql as $$
  select id from content.quiz_bank where prompt = p_prompt and (image_path is not null) = p_image
  order by image_path limit 1
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

grant game_master_svc, dispatcher_svc to postgres;
grant select on ids to authenticated, game_master_svc, dispatcher_svc;
grant execute on function pg_temp.id(text) to game_master_svc;

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

-- ---- starting ---------------------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok(format($$ select public.start_game(%L, 'quiz', '{"rounds": 6}') $$, pg_temp.id('room')), '22023', null,
                 'a quiz is 3 to 5 rounds');
select throws_ok(format($$ select public.start_game(%L, 'quiz', '{"seconds": 15}') $$, pg_temp.id('room')), '22023', null,
                 'seconds are 10, 20 or 30');
select throws_ok(format($$ select public.start_game(%L, 'quiz', '{"theme": "food"}') $$, pg_temp.id('room')), '22023', null,
                 'a quiz takes only its own settings');
select lives_ok(format($$ select public.start_game(%L, 'quiz', '{"rounds": 3, "seconds": 20}') $$, pg_temp.id('room')),
                'the host starts a 3-round quiz with 20 seconds a question');
select pg_temp.act_as_admin();
insert into ids (k, id) select 'game', id from public.games where room_id = pg_temp.id('room');
select is((select config from public.games where id = pg_temp.id('game')) - 'round_kinds',
          '{"rounds": 3, "per_round": 5, "seconds": 20, "estimate_extra_seconds": 10, "reveal_seconds": 8}'::jsonb,
          'the host''s choices become the game''s config');
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
create temp table bank_seen on commit drop as select game_api.quiz_bank(pg_temp.id('game'), 'general') as b;
reset role;
select ok((select jsonb_array_length(b) from bank_seen) > 0, 'the quiz master finds questions for a topic');
select ok((select bool_and(q ->> 'topic' = 'general') from bank_seen, jsonb_array_elements(b) q),
          'only that topic');

-- ---- a question -----------------------------------------------------------------------------------------------
select throws_ok(format($$ select pg_temp.ask(%L) $$, gen_random_uuid()), '22023', null,
                 'an unknown question is refused');
select is((pg_temp.ask(pg_temp.bank('Which planet is known as the Red Planet?'), pg_temp.id('asha')) ->> 'number')::int, 1,
          'the first question is asked, for Asha');
select is((select phase::text from public.games where id = pg_temp.id('game')), 'question', 'the question is open');
select throws_ok($$ select pg_temp.ask(pg_temp.bank('What is the capital of Australia?')) $$, '55000', null,
                 'one question at a time');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select prompt from public.quiz_questions where game_id = pg_temp.id('game') and number = 1),
          'Which planet is known as the Red Planet?', 'players see the question');
select is((select answer from public.quiz_questions where game_id = pg_temp.id('game') and number = 1), null,
          'but not its answer');

-- ---- answers ----------------------------------------------------------------------------------------------------
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
-- Asha answered in 5 of 20 seconds, Chen in 15: the faster right answer scores more.
update public.quiz_answers a set answered_at = q.opened_at + make_interval(secs => case a.member_id
         when pg_temp.id('asha') then 5 else 15 end)
from public.quiz_questions q where q.game_id = a.game_id and q.number = a.number and a.game_id = pg_temp.id('game');
select pg_temp.answer('priya', '{"option": 2}');
select is((select phase_deadline from public.games where id = pg_temp.id('game')), null,
          'everyone has answered: the question closes');
select ok(exists (select 1 from dispatch.events where room_id = pg_temp.id('room') and kind = 'phase_complete'
                  and payload ->> 'phase' = 'question'), 'and the quiz master is told');

-- ---- the reveal -------------------------------------------------------------------------------------------------
select is((pg_temp.reveal() -> 'answer'), '{"option": 1}'::jsonb, 'the reveal gives the answer');
select is((select jsonb_object_agg(member_id, points) from public.quiz_answers where game_id = pg_temp.id('game')),
          jsonb_build_object(pg_temp.id('asha'), 875, pg_temp.id('chen'), 625, pg_temp.id('ben'), 0,
                             pg_temp.id('priya'), 0),
          'right answers score 500 to 1,000 by speed; wrong ones score nothing');
select is((select results -> 'picks' from public.quiz_questions where game_id = pg_temp.id('game') and number = 1),
          '[1, 2, 1, 0]'::jsonb, 'the reveal shows how the room answered');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select is((select count(*)::int from public.quiz_answers where game_id = pg_temp.id('game')), 4,
          'after the reveal, everyone''s answers can be seen');
select pg_temp.act_as_admin();
select is((select phase::text from public.games where id = pg_temp.id('game')), 'reveal', 'the reveal holds');
select throws_ok($$ select pg_temp.ask(pg_temp.bank('What is the capital of Australia?')) $$, '55000', null,
                 'the next question waits for the reveal''s time');
select pg_temp.time_up();

-- ---- the host's lines can't single out the live answer ------------------------------------------------------------
select pg_temp.ask(pg_temp.bank('What is the capital of Australia?'));
select throws_ok($$ select pg_temp.say('It''s Canberra, obviously!') $$, 'GN001', null,
                 'a line naming only the right answer is refused');
select lives_ok($$ select pg_temp.say('Sydney, Melbourne, Canberra or Perth?') $$, 'reading out every option is fine');

-- ---- the host skips, and time runs out ------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select lives_ok(format($$ select public.skip_phase(%L) $$, pg_temp.id('game')), 'the host closes the question early');
select pg_temp.act_as_admin();
select is(pg_temp.reveal() -> 'results' ->> 'answered', '0', 'nobody answered: nobody scores');

-- ---- an estimate: closest wins ------------------------------------------------------------------------------------------
select pg_temp.time_up();
select is((pg_temp.ask(pg_temp.bank('How tall is Mount Everest, in metres?')) ->> 'seconds')::int, 30,
          'an estimate gets 10 more seconds');
select throws_ok($$ select pg_temp.say('Is it 8848.86 metres?') $$, 'GN001', null,
                 'a line saying the estimate''s number is refused');
select pg_temp.answer('asha', '{"value": 9000}');
select pg_temp.answer('ben', '{"value": 8800}');
select pg_temp.answer('chen', '{"value": 5000}');
select pg_temp.time_up();
select pg_temp.reveal();
select is((select jsonb_object_agg(member_id, points) from public.quiz_answers
           where game_id = pg_temp.id('game') and number = 3),
          jsonb_build_object(pg_temp.id('ben'), 1000, pg_temp.id('asha'), 667, pg_temp.id('chen'), 333),
          'estimates score by how close they came');

-- ---- a picture round: the image is readable only once its question is asked ----------------------------------------
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

-- ---- into the final round: the catch-up joker ----------------------------------------------------------------------------
-- Questions 5 to 10, nobody answering, then question 11 opens the final round.
do $$
declare q record;
begin
  for q in select id from content.quiz_bank b where b.kind = 'true_false' and b.region is null
           and not exists (select 1 from private.quiz_keys k where k.game_id = pg_temp.id('game') and k.bank_id = b.id)
           limit 6 loop
    perform pg_temp.time_up();
    perform pg_temp.ask(q.id);
    perform pg_temp.time_up();
    perform pg_temp.reveal();
  end loop;
end $$;
select pg_temp.time_up();
select is((pg_temp.ask(pg_temp.bank('Which country does paella come from?')) -> 'jokers_to'),
          jsonb_build_array(pg_temp.id('priya')), 'going into the final round, whoever is last gets the joker');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select throws_ok(format($$ select public.play_joker(%L) $$, pg_temp.id('game')), '55000', null,
                 'only the player in last place has one');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select lives_ok(format($$ select public.play_joker(%L) $$, pg_temp.id('game')), 'Priya plays her joker');
select pg_temp.act_as_admin();
select pg_temp.answer('priya', '{"option": 1}');
update public.quiz_answers set answered_at = answered_at + interval '10 seconds'
where game_id = pg_temp.id('game') and number = 11;
select pg_temp.time_up();
select pg_temp.reveal();
select is((select points from public.quiz_answers where game_id = pg_temp.id('game') and number = 11
           and member_id = pg_temp.id('priya')), 1500, 'the joker doubles her points (750, halfway through)');

-- ---- the end -------------------------------------------------------------------------------------------------------------
do $$
declare q record;
begin
  for q in select id from content.quiz_bank b where b.kind = 'choice' and b.region is null
           and not exists (select 1 from private.quiz_keys k where k.game_id = pg_temp.id('game') and k.bank_id = b.id)
           limit 4 loop
    perform pg_temp.time_up();
    perform pg_temp.ask(q.id);
    perform pg_temp.time_up();
    perform pg_temp.reveal();
  end loop;
end $$;
select is((select phase::text from public.games where id = pg_temp.id('game')), 'ended', 'after question 15, it''s over');
select is((select reveal -> 'standings' -> 0 ->> 'member_id' from public.games where id = pg_temp.id('game')),
          pg_temp.id('asha')::text, 'the final standings, Asha on top');
select is((select status::text from public.rooms where id = pg_temp.id('room')), 'lobby', 'the room is back in the lobby');
select ok((select bool_and(answer is not null) from public.quiz_questions where game_id = pg_temp.id('game')),
          'every answer was revealed');
select throws_ok($$ select pg_temp.ask(pg_temp.bank('What is the capital of Canada?')) $$, '55000', null,
                 'nothing more can be asked');

select pg_temp.act_as_admin();
select * from finish();
rollback;
