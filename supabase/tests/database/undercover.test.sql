begin;
create extension if not exists pgtap with schema extensions;

-- A whole game of Undercover played through the database: the deal, who can see which card, clue
-- turns and timers, votes, a tie and a revote, Mr. White's guess and the host's overrule, and every
-- place a secret word could leak on the way.

select plan(73);

create function pg_temp.act_as(p_uid uuid, p_guest boolean default false) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims',
                    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_guest)::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true),
         set_config('request.headers', '', true);
$$;

-- Names for everything the test refers to: rooms, members by nickname or by dealt role, words.
create temp table ids (k text primary key, id uuid, v text) on commit drop;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select id from ids where k = p_k $$;
create function pg_temp.act_as_key(p_k text) returns void language sql as $$
  select pg_temp.act_as((select v::uuid from ids where k = p_k), true);
$$;

grant game_master_svc, dispatcher_svc, agents_svc to postgres;  -- rolled back with the test
grant select on ids to authenticated, game_master_svc, dispatcher_svc, agents_svc;

insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false);
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-000000000101', true),
  ('00000000-0000-0000-0000-000000000102', true),
  ('00000000-0000-0000-0000-000000000103', true),
  ('00000000-0000-0000-0000-000000000104', true),
  ('00000000-0000-0000-0000-000000000105', true),  -- outsider
  ('00000000-0000-0000-0000-000000000106', true);  -- the TV

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.create_room('Host');
select pg_temp.act_as_admin();
insert into ids (k, id, v) select 'room', id, code from public.rooms where host_id = '00000000-0000-0000-0000-00000000000a';

select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select public.join_room((select v from ids where k = 'room'), 'Asha');

-- ---- starting a game ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok(format($$ select public.start_game(%L, 'undercover') $$, pg_temp.id('room')),
                 '55000', 'Undercover needs 3 to 16 players.', 'a game needs at least 3 players');

select pg_temp.act_as('00000000-0000-0000-0000-000000000102', true);
select public.join_room((select v from ids where k = 'room'), 'Ben');
select pg_temp.act_as('00000000-0000-0000-0000-000000000103', true);
select public.join_room((select v from ids where k = 'room'), 'Chen');
select pg_temp.act_as('00000000-0000-0000-0000-000000000104', true);
select public.join_room((select v from ids where k = 'room'), 'Dev');

select pg_temp.act_as('00000000-0000-0000-0000-000000000106', true);
select public.start_display_pairing();
select pg_temp.act_as_admin();
insert into ids (k, v) select 'tv_code', code from public.display_pairings where user_id = '00000000-0000-0000-0000-000000000106';
insert into ids (k, id, v) select lower(nickname), id, user_id::text from public.room_members where room_id = pg_temp.id('room');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.pair_display(pg_temp.id('room'), (select v from ids where k = 'tv_code'));

select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select throws_ok(format($$ select public.start_game(%L, 'undercover') $$, pg_temp.id('room')),
                 '42501', null, 'only the host starts a game');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok(format($$ select public.start_game(%L, 'undercover', '{"region": "India"}') $$, pg_temp.id('room')),
                 '22023', null, 'settings are checked (a region is a two-letter code)');
select set_config('request.headers', '{"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}', true);
select lives_ok(format($$ select public.start_game(%L, 'undercover', '{"theme": "drinks"}') $$, pg_temp.id('room')),
                'the host starts Undercover');
select throws_ok(format($$ select public.start_game(%L, 'undercover') $$, pg_temp.id('room')),
                 '55000', 'A game is already running.', 'one game at a time');

select pg_temp.act_as_admin();
insert into ids (k, id) select 'game', id from public.games where room_id = pg_temp.id('room');
select is((select count(*)::int from public.game_players where game_id = pg_temp.id('game')), 5,
          'everyone in the lobby is in the game, the host too');
select is((select status::text from public.rooms where id = pg_temp.id('room')), 'playing', 'the room is playing');
select is((select traceparent from dispatch.events where kind = 'game_started' and payload ->> 'game_id' = pg_temp.id('game')::text),
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', 'starting tells the game master, carrying the trace');

-- ---- setup and the deal --------------------------------------------------------------------------
insert into content.word_pairs (theme, rating, word_a, word_b) values ('party', 'adult', 'tequila', 'mezcal');
insert into ids (k, id) select 'adult_pair', id from content.word_pairs where word_a = 'tequila' and theme = 'party';
insert into ids (k, id) select 'pair', id from content.word_pairs where word_a = 'coffee' and source = 'seed';

select throws_ok(format($$ set local role game_master_svc; select game_api.gm_setup(%L, %L, 1, 2, 20, gen_random_uuid()) $$,
                        pg_temp.id('game'), pg_temp.id('pair')),
                 '22023', null, 'the database refuses a role mix that doesn''t fit the players');
select throws_ok(format($$ set local role game_master_svc; select game_api.gm_setup(%L, %L, 1, 1, 20, gen_random_uuid()) $$,
                        pg_temp.id('game'), pg_temp.id('adult_pair')),
                 '22023', null, 'an 18+ pair can''t be used in a family room');
select throws_ok(format($$ set local role game_master_svc; select game_api.gm_deal(%L, gen_random_uuid()) $$, pg_temp.id('game')),
                 '55000', null, 'no deal before setup');
select throws_ok(format($$ set local role agents_svc; select game_api.get_game_state(%L) $$, pg_temp.id('game')),
                 '42501', null, 'the host agent''s login can''t reach the game master''s API');

set local role game_master_svc;
create temp table setup1 on commit drop as
  select game_api.gm_setup((select id from ids where k = 'game'), (select id from ids where k = 'pair'), 1, 1, 20,
                           'e0000000-0000-4000-8000-000000000001') as r;
create temp table setup2 on commit drop as
  select game_api.gm_setup((select id from ids where k = 'game'), (select id from ids where k = 'pair'), 2, 0, 15,
                           'e0000000-0000-4000-8000-000000000001') as r;
select game_api.gm_deal((select id from ids where k = 'game'), 'e0000000-0000-4000-8000-000000000002');
reset role;

select is((select r -> 'config' ->> 'civilians' from setup1), '3', 'the game master picks the role mix');
select is((select r from setup2), (select r from setup1), 'a repeated event returns the first result');
select is((select config ->> 'mr_whites' from public.games where id = pg_temp.id('game')), '1', 'and changes nothing');

insert into ids (k, v) select 'civilian_word', civilian_word from private.game_words where game_id = pg_temp.id('game');
insert into ids (k, v) select 'undercover_word', undercover_word from private.game_words where game_id = pg_temp.id('game');
insert into ids (k, id, v)
  select case s.payload ->> 'role' when 'mr_white' then 'white' when 'undercover' then 'under'
              else 'c' || row_number() over (partition by s.payload ->> 'role' order by p.seat) end,
         s.member_id, m.user_id::text
  from public.secrets s
  join public.game_players p on p.game_id = s.game_id and p.member_id = s.member_id
  join public.room_members m on m.id = s.member_id
  where s.game_id = pg_temp.id('game');

select is((select array_agg(payload ->> 'role' order by payload ->> 'role') from public.secrets where game_id = pg_temp.id('game')),
          array['civilian', 'civilian', 'civilian', 'mr_white', 'undercover'],
          'the deal gives 3 civilians, 1 undercover and 1 Mr. White');
select ok(
  (select count(distinct payload ->> 'word') = 1 and min(payload ->> 'word') = (select v from ids where k = 'civilian_word')
   from public.secrets where game_id = pg_temp.id('game') and payload ->> 'role' = 'civilian')
  and (select payload ->> 'word' from public.secrets where member_id = pg_temp.id('under')) = (select v from ids where k = 'undercover_word')
  and (select not (payload ? 'word') from public.secrets where member_id = pg_temp.id('white'))
  and array[(select v from ids where k = 'civilian_word'), (select v from ids where k = 'undercover_word')] <@ array['coffee', 'tea'],
  'civilians share one word of the pair, the undercover has the other, Mr. White has none');

-- ---- who can see which card ------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select results_eq($$ select member_id from public.secrets $$, $$ select id from ids where k = 'asha' $$,
                  'a player sees only their own card');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select results_eq($$ select member_id from public.secrets $$, $$ select id from ids where k = 'host' $$,
                  'the host, who also plays, sees only their own card');
select pg_temp.act_as('00000000-0000-0000-0000-000000000106', true);
select is_empty($$ select * from public.secrets $$, 'the TV sees no cards');
select is((select count(*)::int from public.game_players), 5, 'but the TV follows the game');
select pg_temp.act_as('00000000-0000-0000-0000-000000000105', true);
select is_empty($$ select id::text from public.games union all select member_id::text from public.secrets $$,
                'an outsider sees nothing of the game');

select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select ok(private.can_access_topic('member:' || pg_temp.id('asha')), 'a player may listen on their own private topic');
select ok(not private.can_access_topic('member:' || pg_temp.id('ben')), 'but not on anyone else''s');
select pg_temp.act_as('00000000-0000-0000-0000-000000000106', true);
select ok(private.can_access_topic('room:' || pg_temp.id('room')) and not private.can_access_topic('member:' || pg_temp.id('asha')),
          'the TV hears the room, never a player''s topic');

-- Everything public is broadcast whole to the room, so none of it may carry a word.
select pg_temp.act_as_admin();
create function pg_temp.public_rows_mention_a_word() returns boolean language sql as $$
  select exists (
    select 1 from (
      select to_jsonb(g)::text as t from public.games g where g.id = pg_temp.id('game')
      union all select to_jsonb(p)::text from public.game_players p where p.game_id = pg_temp.id('game')
      union all select to_jsonb(r)::text from public.game_results r where r.game_id = pg_temp.id('game')
    ) x
    where x.t ~* ('\m' || (select v from ids where k = 'civilian_word') || '\M')
       or x.t ~* ('\m' || (select v from ids where k = 'undercover_word') || '\M')
  );
$$;
select ok(not pg_temp.public_rows_mention_a_word(), 'no public row mentions either word after the deal');
select is((select count(*)::int from public.game_players where game_id = pg_temp.id('game') and revealed_role is not null), 0,
          'no role is shown before anyone is out');

-- ---- clue turns --------------------------------------------------------------------------------------
set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'clues', null, 'e0000000-0000-4000-8000-000000000003',
  array[(select id from ids where k = 'white'), (select id from ids where k = 'under'), (select id from ids where k = 'c1'),
        (select id from ids where k = 'c2'), (select id from ids where k = 'c3')]);
reset role;
select is((select turn_order[1] from public.games where id = pg_temp.id('game')), pg_temp.id('under'),
          'Mr. White never speaks first: the order quietly rotates by one');

select pg_temp.act_as_key('c1');
select throws_ok(format($$ select public.submit_action(%L, 'done', '{}', gen_random_uuid()) $$, pg_temp.id('game')),
                 '55000', 'It''s not your turn.', 'only the speaker can end their turn');
select pg_temp.act_as_key('under');
select public.submit_action(pg_temp.id('game'), 'done', '{}', 'a0000000-0000-4000-8000-000000000001');
select public.submit_action(pg_temp.id('game'), 'done', '{}', 'a0000000-0000-4000-8000-000000000001');
select pg_temp.act_as_admin();
select is((select turn_index from public.games where id = pg_temp.id('game')), 1::smallint,
          'the speaker''s tap moves to the next speaker, and a retried tap doesn''t move it twice');
select pg_temp.act_as_key('c1');
select throws_ok(format($$ select public.submit_action(%L, 'done', '{}', 'a0000000-0000-4000-8000-000000000001') $$, pg_temp.id('game')),
                 '42501', null, 'a move id can''t be reused by someone else');

select pg_temp.act_as_admin();
update public.games set turn_deadline = now() - interval '1 second' where id = pg_temp.id('game');
select lives_ok($$ set local role dispatcher_svc; select dispatch.fire_due_deadlines(); reset role $$, 'the dispatcher fires due deadlines');
select is((select turn_index from public.games where id = pg_temp.id('game')), 2::smallint,
          'when a speaker runs out of time, the next one is up');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select lives_ok(format($$ select public.skip_turn(%L) $$, pg_temp.id('game')), 'the host can skip a speaker');
select pg_temp.act_as_key('c3');
select public.submit_action(pg_temp.id('game'), 'done', '{}', gen_random_uuid());
select pg_temp.act_as_key('white');
select public.submit_action(pg_temp.id('game'), 'done', '{}', gen_random_uuid());
select pg_temp.act_as_admin();
select ok((select turn_index is null and turn_deadline is null from public.games where id = pg_temp.id('game'))
          and exists (select 1 from dispatch.events where kind = 'phase_complete'
                      and payload ->> 'game_id' = pg_temp.id('game')::text and payload ->> 'phase' = 'clues'),
          'after the last clue, the game master is told the clues are in');

-- ---- discussion, pause, vote ----------------------------------------------------------------------------
select pg_temp.act_as_key('c1');
select throws_ok(format($$ select public.submit_action(%L, 'vote', %L, gen_random_uuid()) $$,
                        pg_temp.id('game'), json_build_object('target', pg_temp.id('white'))),
                 '55000', 'Voting isn''t open.', 'no voting before the vote');

select pg_temp.act_as_admin();
select throws_ok(format($$ set local role game_master_svc; select game_api.gm_open_phase(%L, 'discussion', 600, gen_random_uuid()) $$,
                        pg_temp.id('game')),
                 '22023', null, 'the game master''s timers are bounded (discussion: 30 to 180 seconds)');
set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'discussion', 90, 'e0000000-0000-4000-8000-000000000004');
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.pause_game(pg_temp.id('game'));
select pg_temp.act_as_admin();
select ok((select phase_deadline is null and paused_phase_left = interval '90 seconds' from public.games where id = pg_temp.id('game')),
          'pausing stops the clock and keeps the time left');
select throws_ok(format($$ set local role game_master_svc; select game_api.gm_open_phase(%L, 'vote', 30, gen_random_uuid()) $$,
                        pg_temp.id('game')),
                 '55000', 'The host has paused the game.', 'the game master waits while the host has paused');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.resume_game(pg_temp.id('game'));
select public.extend_phase(pg_temp.id('game'), 30);
select pg_temp.act_as_admin();
select ok((select phase_deadline = now() + interval '120 seconds' and turn_deadline is null from public.games where id = pg_temp.id('game')),
          'resuming restores the time left (and no clue timer), and the host can add more');

set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'vote', 45, 'e0000000-0000-4000-8000-000000000005');
reset role;

select pg_temp.act_as_key('c1');
select throws_ok(format($$ select public.submit_action(%L, 'vote', %L, gen_random_uuid()) $$,
                        pg_temp.id('game'), json_build_object('target', pg_temp.id('c1'))),
                 '22023', null, 'you can''t vote for yourself');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('under'))::jsonb, gen_random_uuid());
select throws_ok(format($$ select public.submit_action(%L, 'vote', %L, gen_random_uuid()) $$,
                        pg_temp.id('game'), json_build_object('target', pg_temp.id('white'))),
                 '23505', null, 'one vote per player');
select pg_temp.act_as_key('c2');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('under'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('c3');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('under'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('white');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('under'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('under');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c1'))::jsonb, gen_random_uuid());

select pg_temp.act_as_key('c1');
select is_empty($$ select * from public.game_actions where kind = 'vote' and member_id <> (select id from ids where k = 'c1') $$,
                'nobody sees anyone else''s vote while voting is open');
select pg_temp.act_as_admin();
select ok((select phase_deadline is null and moves_in = 5 from public.games where id = pg_temp.id('game'))
          and exists (select 1 from dispatch.events where kind = 'phase_complete' and payload ->> 'phase' = 'vote'
                      and payload ->> 'game_id' = pg_temp.id('game')::text),
          'once everyone has voted, the timer stops and the game master is told');

set local role game_master_svc;
create temp table resolve1 on commit drop as
  select game_api.gm_resolve_vote((select id from ids where k = 'game'), 'e0000000-0000-4000-8000-000000000006') as r;
create temp table resolve2 on commit drop as
  select game_api.gm_resolve_vote((select id from ids where k = 'game'), 'e0000000-0000-4000-8000-000000000006') as r;
reset role;
select is((select r ->> 'eliminated' from resolve1), pg_temp.id('under')::text, 'the most-voted player is out');
select is((select r from resolve2), (select r from resolve1), 'counting the same event twice returns the first count');
select is((select array_agg(member_id::text || '=' || revealed_role) from public.game_players
           where game_id = pg_temp.id('game') and revealed_role is not null),
          array[pg_temp.id('under')::text || '=undercover'], 'their role is shown, and only theirs');
select is((select votes ->> pg_temp.id('c1')::text from public.game_results where game_id = pg_temp.id('game')),
          pg_temp.id('under')::text, 'once counted, the room sees who voted for whom');

-- ---- round 2: a tie and a revote ----------------------------------------------------------------------------
set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'clues', null, 'e0000000-0000-4000-8000-000000000007');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.skip_phase(pg_temp.id('game'));
select pg_temp.act_as_admin();
select is((select turn_index from public.games where id = pg_temp.id('game')), null, 'the host can skip the rest of the clues');
set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'discussion', 30, 'e0000000-0000-4000-8000-000000000008');
select game_api.gm_open_phase((select id from ids where k = 'game'), 'vote', 30, 'e0000000-0000-4000-8000-000000000009');
reset role;
select pg_temp.act_as_key('c1');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c2'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('c2');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c1'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('c3');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c1'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('under');
select throws_ok(format($$ select public.submit_action(%L, 'vote', %L, gen_random_uuid()) $$,
                        pg_temp.id('game'), json_build_object('target', pg_temp.id('c1'))),
                 '55000', null, 'players who are out can''t vote');
select pg_temp.act_as_key('white');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c2'))::jsonb, gen_random_uuid());

select pg_temp.act_as_admin();
set local role game_master_svc;
create temp table tie on commit drop as
  select game_api.gm_resolve_vote((select id from ids where k = 'game'), 'e0000000-0000-4000-8000-000000000010') as r;
reset role;
select is((select r -> 'options' from tie), '["revote", "no_elimination"]'::jsonb, 'a tie offers a revote or no elimination');
select throws_ok(format($$ set local role game_master_svc; select game_api.gm_open_phase(%L, 'vote', 30, gen_random_uuid(), null, array[%L, %L]::uuid[]) $$,
                        pg_temp.id('game'), pg_temp.id('c1'), pg_temp.id('c3')),
                 '22023', null, 'a revote is only between the tied players');
set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'vote', 30, 'e0000000-0000-4000-8000-000000000011', null,
                              array[(select id from ids where k = 'c1'), (select id from ids where k = 'c2')]);
reset role;
select pg_temp.act_as_key('c3');
select throws_ok(format($$ select public.submit_action(%L, 'vote', %L, gen_random_uuid()) $$,
                        pg_temp.id('game'), json_build_object('target', pg_temp.id('white'))),
                 '22023', null, 'in a revote you can only vote for the tied players');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c1'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('c1');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c2'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('c2');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c1'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('white');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c1'))::jsonb, gen_random_uuid());
select pg_temp.act_as_admin();
set local role game_master_svc;
select game_api.gm_resolve_vote((select id from ids where k = 'game'), 'e0000000-0000-4000-8000-000000000012');
reset role;
select throws_ok(format($$ set local role game_master_svc; select game_api.gm_open_phase(%L, 'vote', 30, gen_random_uuid(), null, array[%L, %L]::uuid[]) $$,
                        pg_temp.id('game'), pg_temp.id('c2'), pg_temp.id('c3')),
                 '55000', null, 'one revote per round');
select is((select winner from public.games where id = pg_temp.id('game')), null,
          'two civilians and Mr. White left: nobody has won yet');

-- ---- round 3: Mr. White is caught and guesses -----------------------------------------------------------------
set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'clues', null, 'e0000000-0000-4000-8000-000000000013');
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.skip_phase(pg_temp.id('game'));
select pg_temp.act_as_admin();
set local role game_master_svc;
select game_api.gm_open_phase((select id from ids where k = 'game'), 'discussion', 30, 'e0000000-0000-4000-8000-000000000014');
select game_api.gm_open_phase((select id from ids where k = 'game'), 'vote', 30, 'e0000000-0000-4000-8000-000000000015');
reset role;
select pg_temp.act_as_key('c2');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('white'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('c3');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('white'))::jsonb, gen_random_uuid());
select pg_temp.act_as_key('white');
select public.submit_action(pg_temp.id('game'), 'vote', json_build_object('target', pg_temp.id('c2'))::jsonb, gen_random_uuid());
select pg_temp.act_as_admin();
set local role game_master_svc;
create temp table caught on commit drop as
  select game_api.gm_resolve_vote((select id from ids where k = 'game'), 'e0000000-0000-4000-8000-000000000016') as r;
reset role;
select is((select r ->> 'guess' from caught), 'true', 'when Mr. White is voted out, they get to guess');

select pg_temp.act_as_key('c2');
select throws_ok(format($$ select public.submit_action(%L, 'guess', '{"text": "coffee"}', gen_random_uuid()) $$, pg_temp.id('game')),
                 '55000', null, 'only Mr. White guesses');
select pg_temp.act_as_key('white');
select public.submit_action(pg_temp.id('game'), 'guess', json_build_object('text', (select v from ids where k = 'undercover_word'))::jsonb,
                            gen_random_uuid());
select pg_temp.act_as_admin();
select ok(not pg_temp.public_rows_mention_a_word(),
          'the guess is never in public state (a wrong guess could be the undercover word)');

select throws_ok(format($$ set local role agents_svc; select agents_api.host_say(%L, %L, 'narration') $$,
                        pg_temp.id('room'), 'Could the word be... ' || upper((select v from ids where k = 'civilian_word')) || 's?'),
                 'GN001', null, 'the database refuses a line with a live secret word, in any case and in the plural');
select lives_ok(format($$ set local role agents_svc; select agents_api.host_say(%L, 'Mr. White, the pressure is on...', 'narration'); reset role $$,
                       pg_temp.id('room')),
                'lines without the words are fine');

select throws_ok(format($$ set local role game_master_svc; select game_api.gm_judge(%L, true, 'x', gen_random_uuid()) $$,
                        gen_random_uuid()),
                 'P0002', null, 'the game master can only judge a game that exists');
set local role game_master_svc;
select game_api.gm_judge((select id from ids where k = 'game'), false, 'That''s the other side''s word, not the civilians''.',
                         'e0000000-0000-4000-8000-000000000017');
reset role;
select is((select judgement ->> 'verdict' from public.games where id = pg_temp.id('game')), 'false',
          'the verdict waits 10 seconds for the host');
select pg_temp.act_as_key('ben');
select throws_ok(format($$ select public.settle_judgement(%L, true) $$, pg_temp.id('game')), '42501', null,
                 'only the host can overrule');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.settle_judgement(pg_temp.id('game'), true);

-- ---- the end ------------------------------------------------------------------------------------------------
select pg_temp.act_as_admin();
select is((select winner from public.games where id = pg_temp.id('game')), 'mr_white', 'the host overrules the judge, and Mr. White wins');
select ok((select reveal -> 'words' ->> 'civilian' = (select v from ids where k = 'civilian_word')
                  and reveal -> 'guesses' -> 0 ->> 'overruled' = 'true'
                  and reveal -> 'guesses' -> 0 ->> 'reasoning' is not null
           from public.games where id = pg_temp.id('game')),
          'the end reveals both words, the guess and the reasoning');
select is((select count(*)::int from public.game_players where game_id = pg_temp.id('game') and revealed_role is null), 0,
          'and every role');
select is((select status::text from public.rooms where id = pg_temp.id('room')), 'lobby', 'the room goes back to the lobby');
select ok(exists (select 1 from dispatch.events where kind = 'game_ended' and payload ->> 'winner' = 'mr_white'),
          'the game master is told the game is over');
select lives_ok(format($$ set local role agents_svc; select agents_api.host_say(%L, %L, 'narration'); reset role $$,
                       pg_temp.id('room'), 'The word was ' || (select v from ids where k = 'civilian_word') || '!'),
                'once the game is over, the words can be said');
select pg_temp.act_as_key('c2');
select throws_ok(format($$ select public.submit_action(%L, 'done', '{}', gen_random_uuid()) $$, pg_temp.id('game')),
                 '55000', 'This game is over.', 'no moves after the end');

-- ---- a second game in the same room -------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.start_game(pg_temp.id('room'), 'undercover');
select pg_temp.act_as_admin();
insert into ids (k, id) select 'game2', id from public.games where room_id = pg_temp.id('room') and phase <> 'ended';
set local role game_master_svc;
create temp table pairs on commit drop as select game_api.word_pairs((select id from ids where k = 'game2'), null, 50) as r;
reset role;
select ok(not exists (select 1 from pairs, jsonb_array_elements(r) p where p ->> 'id' = pg_temp.id('pair')::text)
          and not exists (select 1 from pairs, jsonb_array_elements(r) p where p ->> 'rating' <> 'family'),
          'the bank offers only family pairs this room hasn''t played tonight');
select throws_ok(format($$ set local role game_master_svc; select game_api.gm_setup(%L, %L, 1, 1, 20, gen_random_uuid()) $$,
                        pg_temp.id('game2'), pg_temp.id('pair')),
                 '22023', 'This room already played that pair tonight.', 'and refuses a repeat');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.leave_room(pg_temp.id('room'));
select pg_temp.act_as_admin();
select is((select phase::text || '/' || coalesce(winner, 'none') from public.games where id = pg_temp.id('game2')), 'ended/none',
          'closing the room ends its game');

select * from finish();
rollback;
