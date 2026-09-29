begin;
create extension if not exists pgtap with schema extensions;

-- The AI game master's way in: the host agent starts a game only for the room's real host, and the
-- game master narrates only into its own game's room, through the same checks as every host line.

select plan(10);

create function pg_temp.act_as(p_uid uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

grant game_master_svc, agents_svc to postgres;  -- rolled back with the test

insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false),
  ('00000000-0000-0000-0000-00000000000b', 'other-host@example.com', false);
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-000000000101', true), ('00000000-0000-0000-0000-000000000102', true);

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table r on commit drop as select * from public.create_room('Host');
grant select on r to authenticated, agents_svc, game_master_svc;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select public.join_room((select code from r), 'Asha');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102');
select public.join_room((select code from r), 'Ben');
select pg_temp.act_as_admin();

select throws_ok(format($$ set local role agents_svc; select agents_api.start_game(%L, %L) $$,
                        (select id from r), '00000000-0000-0000-0000-00000000000b'),
                 '42501', null, 'the host agent can''t start a game for someone who doesn''t host the room');
select lives_ok(format($$ set local role agents_svc; select agents_api.start_game(%L, %L, '{"theme": "food"}'); reset role $$,
                       (select id from r), '00000000-0000-0000-0000-00000000000a'),
                'the host agent starts a game for the room''s host');
select is((select settings ->> 'theme' from public.games where room_id = (select id from r)), 'food',
          'with the host''s settings');
select ok(exists (select 1 from dispatch.events where kind = 'game_started' and room_id = (select id from r)),
          'and the game master is told, as when the host taps Start');

create temp table g on commit drop as select id from public.games where room_id = (select id from r);
grant select on g to game_master_svc, agents_svc;
insert into private.game_words (game_id, room_id, pair_id)
  select (select id from g), (select id from r), id from content.word_pairs where word_a = 'pizza' and source = 'seed';

select lives_ok($$ set local role game_master_svc;
  select game_api.say((select id from g), 'The detective arrives. Nobody leaves.', 'c0000000-0000-4000-8000-000000000001');
  reset role $$, 'the game master narrates');
select is((select kind || ':' || text from public.host_lines where event_id = 'c0000000-0000-4000-8000-000000000001'),
          'narration:The detective arrives. Nobody leaves.', 'into its game''s room, as narration');
select lives_ok($$ set local role game_master_svc;
  select game_api.say((select id from g), 'A different line', 'c0000000-0000-4000-8000-000000000001');
  reset role $$, 'a retried narration is accepted');
select is((select count(*)::int from public.host_lines where room_id = (select id from r) and kind = 'narration'), 1,
          'but shown once');
select throws_ok($$ set local role game_master_svc;
  select game_api.say((select id from g), 'Mmm, PIZZAS tonight?', gen_random_uuid()) $$,
                 'GN001', null, 'the game master can''t say a live secret word either');
select throws_ok($$ set local role agents_svc; select game_api.say((select id from g), 'hi', gen_random_uuid()) $$,
                 '42501', null, 'the host agent''s login can''t narrate as the game master');

select * from finish();
rollback;
