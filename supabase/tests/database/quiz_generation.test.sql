begin;
create extension if not exists pgtap with schema extensions;

-- Quiz Night, 5b: picking a topic in the lobby tells the room's agent (topic_picked); the agent reads a topic's
-- coverage (counts only) and saves verified questions, checked again here.

select plan(16);

create function pg_temp.act_as(p_uid uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;
create temp table ids (k text primary key, id uuid, v text) on commit drop;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select id from ids where k = p_k $$;
-- The agents' calls, as agents_svc (pgTAP can't run as it, so the role switch stays inside).
create function pg_temp.coverage(p_topic text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role agents_svc;
  r := agents_api.quiz_coverage(pg_temp.id('room'), p_topic);
  reset role;
  return r;
end $$;
create function pg_temp.save(p_kind text, p_prompt text, p_options jsonb, p_answer jsonb,
                             p_source text default 'https://en.wikipedia.org/wiki/Mars') returns uuid
language plpgsql as $$
declare r uuid;
begin
  set local role agents_svc;
  r := agents_api.save_quiz_question('Space ', p_kind, 1::smallint, 'family', ' ' || p_prompt || ' ', p_options,
                                     p_answer, null, p_source, 'Mars is the fourth planet from the Sun.');
  reset role;
  return r;
end $$;

grant agents_svc to postgres;
grant select on ids to authenticated, agents_svc;
grant execute on function pg_temp.id(text) to agents_svc;

insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false);
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-000000000101', true);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.create_room('Priya');
select pg_temp.act_as_admin();
insert into ids (k, id, v) select 'room', id, code from public.rooms where host_id = '00000000-0000-0000-0000-00000000000a';
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select public.join_room((select v from ids where k = 'room'), 'Asha');
select pg_temp.act_as_admin();
insert into ids (k, id) select 'asha', id from public.room_members where room_id = pg_temp.id('room') and nickname = 'Asha';

-- ---- topic_picked -------------------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select public.set_topic(pg_temp.id('room'), 'Cricket');
select public.set_topic(pg_temp.id('room'), 'Cricket');  -- the same topic again: nothing new to prepare
select pg_temp.act_as_admin();
select is((select count(*)::int from dispatch.events where room_id = pg_temp.id('room') and kind = 'topic_picked'), 1,
          'picking a topic tells the room''s agent once');
select is((select payload from dispatch.events where room_id = pg_temp.id('room') and kind = 'topic_picked'),
          jsonb_build_object('member_id', pg_temp.id('asha'), 'topic', (select topic from public.room_members
                                                                       where id = pg_temp.id('asha'))),
          'the event says who picked which topic');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select public.set_topic(pg_temp.id('room'), 'Bollywood');
select pg_temp.act_as_admin();
select is((select count(*)::int from dispatch.events where room_id = pg_temp.id('room') and kind = 'topic_picked'), 2,
          'changing it tells the agent again');

-- ---- coverage: counts only ----------------------------------------------------------------------------------------
select is(pg_temp.coverage('Cricket '),
          (select jsonb_object_agg(kind, n) from (select kind, count(*) as n from content.quiz_bank
                                                  where topic = 'cricket' and status = 'verified' group by kind) t),
          'coverage counts a topic''s verified questions by kind (any case, trimmed)');
select is(pg_temp.coverage('no such topic'), '{}'::jsonb, 'a topic with no questions has no coverage');
select ok(pg_temp.coverage('cricket')::text !~ 'answer|prompt', 'coverage never carries a question or an answer');

-- ---- saving a verified question -----------------------------------------------------------------------------------
insert into ids (k, id) values ('saved', pg_temp.save('choice', 'Which planet is fourth from the Sun?',
                                                      '["Venus", "Mars", "Jupiter", "Saturn"]', '{"option": 1}'));
select isnt(pg_temp.id('saved'), null, 'a verified question is saved');
select is((select row(topic, prompt, origin, status)::text from content.quiz_bank where id = pg_temp.id('saved')),
          row('space', 'Which planet is fourth from the Sun?', 'generated', 'verified')::text,
          'filed under its topic, trimmed, as generated and ready to use');
select is(pg_temp.coverage('space'), '{"choice": 1}'::jsonb, 'and it counts towards the topic''s coverage');
select is(pg_temp.save('choice', 'Which planet is fourth from the Sun?', '["Venus", "Mars", "Jupiter", "Saturn"]',
                       '{"option": 1}'), null, 'the same question twice is skipped');
select throws_ok($$ select pg_temp.save('picture', 'Which planet is this?', '["Venus", "Mars"]', '{"option": 1}') $$,
                 '22023', null, 'generated questions are never pictures (those need an image checked by hand)');
select throws_ok($$ select pg_temp.save('choice', 'Which planet is red?', '["Venus", "Mars"]', '{"option": 1}',
                                        'https://example.com/wiki/Mars') $$,
                 '22023', null, 'the source must be English Wikipedia');
select throws_ok($$ select pg_temp.save('choice', 'Which planet is red?', '["Venus", "Mars"]', '{"option": 1}',
                                        'https://en.wikipedia.org/wiki/Mars?action=edit') $$,
                 '22023', null, 'an article, not any page on the site');
select throws_ok($$ select pg_temp.save('choice', 'Which planet is red?', '["Venus", "Mars"]', '{"option": 7}') $$,
                 null, null, 'the bank''s own checks still apply (the answer must be one of the options)');

-- ---- who may call them --------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'agents_api.save_quiz_question(text, text, smallint, '
          'public.age_rating, text, jsonb, jsonb, text, text, text)', 'execute'), 'players can''t save questions');
select ok(not has_function_privilege('game_master_svc', 'agents_api.quiz_coverage(uuid, text)', 'execute'),
          'only the agents service reads coverage');

select * from finish();
rollback;
