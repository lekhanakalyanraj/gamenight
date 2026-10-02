begin;
create extension if not exists pgtap with schema extensions;

-- A game of Heads Up played through the database: interests, settings, dealing, the rotation, the countdown and the
-- buzzer, Got it and Pass (only from the guesser or the host, once each), the host's skips, and the end. Above all,
-- the card: it reaches only the room's TV, never the guesser (nor any phone, nor the room topic), and the host's
-- lines can't name it until its turn's recap.

select plan(53);

create function pg_temp.act_as(p_uid uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;
create temp table ids (k text primary key, id uuid, v text) on commit drop;
create function pg_temp.id(p_k text) returns uuid language sql as $$ select id from ids where k = p_k $$;
create function pg_temp.uid(p_k text) returns uuid language sql as $$ select v::uuid from ids where k = p_k $$;
-- The game master's moves, as game_master_svc, each with a fresh event id.
create function pg_temp.next_turn() returns jsonb language plpgsql as $$
declare r jsonb;
begin
  set local role game_master_svc;
  r := game_api.gm_next_turn(pg_temp.id('game'), gen_random_uuid());
  reset role;
  return r;
end $$;
create function pg_temp.say(p_text text) returns void language plpgsql as $$
begin
  set local role game_master_svc;
  perform game_api.say(pg_temp.id('game'), p_text, gen_random_uuid());
  reset role;
end $$;
-- Time runs out: the dispatcher fires the deadline.
create function pg_temp.time_up() returns void language plpgsql as $$
begin
  update public.games set phase_deadline = now() - interval '1 second' where id = pg_temp.id('game');
  set local role dispatcher_svc;
  perform dispatch.fire_due_deadlines();
  reset role;
end $$;
create function pg_temp.tap(p_who text, p_result text, p_card_no int, p_action uuid default gen_random_uuid())
returns public.headsup_turns language plpgsql as $$
declare r public.headsup_turns;
begin
  perform pg_temp.act_as(pg_temp.uid(p_who));
  r := public.headsup_move(pg_temp.id('game'), p_result, p_card_no, p_action);
  perform pg_temp.act_as_admin();
  return r;
end $$;
create function pg_temp.live_card() returns text language sql as $$
  select d.card from private.headsup_live l join private.headsup_deck d using (game_id)
  where l.game_id = pg_temp.id('game') and d.position = l.position
$$;
create function pg_temp.phase() returns text language sql as $$
  select phase::text from public.games where id = pg_temp.id('game')
$$;
create function pg_temp.turn() returns public.headsup_turns language sql as $$
  select * from public.headsup_turns where game_id = pg_temp.id('game') order by number desc limit 1
$$;

grant game_master_svc, dispatcher_svc to postgres;
grant select on ids to authenticated, game_master_svc, dispatcher_svc;
grant execute on function pg_temp.id(text) to game_master_svc, dispatcher_svc;

-- ---- a room: the host and two guests, a TV, and an outsider ---------------------------------------------------
insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false);
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-000000000101', true), ('00000000-0000-0000-0000-000000000102', true),
  ('00000000-0000-0000-0000-000000000105', true), ('00000000-0000-0000-0000-0000000000f1', true);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.create_room('Priya');
select pg_temp.act_as_admin();
insert into ids (k, id, v) select 'room', id, code from public.rooms where host_id = '00000000-0000-0000-0000-00000000000a';
select pg_temp.act_as('00000000-0000-0000-0000-000000000101'); select public.join_room((select v from ids where k = 'room'), 'Asha');
select pg_temp.act_as('00000000-0000-0000-0000-000000000102'); select public.join_room((select v from ids where k = 'room'), 'Ben');
select pg_temp.act_as_admin();
insert into ids (k, id, v) select lower(nickname), id, user_id::text from public.room_members where room_id = pg_temp.id('room');
insert into ids (k, v) values ('outsider', '00000000-0000-0000-0000-000000000105'), ('tv', '00000000-0000-0000-0000-0000000000f1');
insert into public.room_displays (room_id, user_id) values (pg_temp.id('room'), pg_temp.uid('tv'));

-- ---- interests, in the lobby ------------------------------------------------------------------------------------
select pg_temp.act_as(pg_temp.uid('asha'));
select is((public.set_interests(pg_temp.id('room'), array['  Cricket ', 'food', 'CRICKET', ''])).interests,
          array['Cricket', 'food'], 'interests are trimmed, blanks dropped, and repeats (any case) kept once');
select throws_ok(format($$ select public.set_interests(%L, array['a1', 'b2', 'c3', 'd4']) $$, pg_temp.id('room')),
                 '22023', null, 'up to three interests');
select throws_ok(format($$ select public.set_interests(%L, array['<b>x</b>']) $$, pg_temp.id('room')),
                 '22023', null, 'no markup in an interest');
select pg_temp.act_as(pg_temp.uid('outsider'));
select throws_ok(format($$ select public.set_interests(%L, array['music']) $$, pg_temp.id('room')),
                 '42501', null, 'only players in the room pick interests');

-- ---- starting ---------------------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok(format($$ select public.start_game(%L, 'heads_up', '{"turns": 3}') $$, pg_temp.id('room')),
                 '22023', null, '1 or 2 turns each');
select throws_ok(format($$ select public.start_game(%L, 'heads_up', '{"seconds": 30}') $$, pg_temp.id('room')),
                 '22023', null, '45, 60 or 90 seconds a turn');
select lives_ok(format($$ select public.start_game(%L, 'heads_up', '{"turns": 1, "seconds": 45}') $$, pg_temp.id('room')),
                'the host starts Heads Up: a turn each, 45 seconds');
select pg_temp.act_as_admin();
insert into ids (k, id) select 'game', id from public.games where room_id = pg_temp.id('room');
select is((select config from public.games where id = pg_temp.id('game')),
          '{"turns": 1, "seconds": 45, "ready_seconds": 5, "recap_seconds": 8, "total_turns": 3}'::jsonb,
          'the host''s choices become the game''s config');
select is((select turn_order from public.games where id = pg_temp.id('game')),
          (select array_agg(member_id order by seat) from public.game_players where game_id = pg_temp.id('game')),
          'guessers go in seat order');
-- The guessers in turn, by user; and a clue-giver for the first turn who isn't the host.
insert into ids (k, id, v)
select 'g' || i, m.id, m.user_id::text
from public.games g cross join lateral unnest(g.turn_order) with ordinality o(member_id, i)
join public.room_members m on m.id = o.member_id
where g.id = pg_temp.id('game');
insert into ids (k, id, v)
select 'clue', m.id, m.user_id::text from public.room_members m
where m.room_id = pg_temp.id('room') and m.id <> pg_temp.id('g1') and m.role <> 'host' limit 1;
select ok((select count(*) from private.headsup_deck where game_id = pg_temp.id('game')) >= 60, 'the deck is dealt');
select ok((select count(*) from (select topic from private.headsup_deck d join content.headsup_cards c on c.id = d.card_id
                                 where d.game_id = pg_temp.id('game') and d.position <= 20) t
           where t.topic in ('cricket', 'food')) > 0, 'the deck leans toward the players'' interests');
select is((select count(*)::int from (select card_id from private.headsup_deck where game_id = pg_temp.id('game')
                                      group by card_id having count(*) > 1) t), 0, 'no card is dealt twice');

-- ---- nobody but the database reaches the deck ---------------------------------------------------------------------
select pg_temp.act_as(pg_temp.uid('asha'));
select throws_ok($$ select * from private.headsup_deck $$, '42501', null, 'players can''t read the deck');
select throws_ok($$ select * from content.headsup_cards $$, '42501', null, 'players can''t read the card bank');
select throws_ok(format($$ select public.set_interests(%L, array['music']) $$, pg_temp.id('room')), '55000', null,
                 'interests are picked in the lobby, not mid-game');

-- ---- the first turn ----------------------------------------------------------------------------------------------
select pg_temp.act_as_admin();
select is((pg_temp.next_turn() ->> 'guesser')::uuid, pg_temp.id('g1'), 'the first turn goes to the first seat');
select is(pg_temp.phase(), 'ready', 'a countdown first: the guesser turns their back to the TV');
select throws_ok($$ select pg_temp.next_turn() $$, '55000', null, 'one turn at a time');
select pg_temp.time_up();
select is(pg_temp.phase(), 'guessing', 'the countdown ends and the guessing starts');
select is((pg_temp.turn()).shown, 1::smallint, 'the first card is up');
select isnt(pg_temp.live_card(), null, 'the database knows the card on the TV');
insert into ids (k, v) values ('card1', pg_temp.live_card());

-- The card reaches the room's TV, on its own topic, and nowhere else.
select ok(exists (select 1 from realtime.messages where topic = 'display:' || pg_temp.uid('tv')
                  and payload ->> 'card' = (select v from ids where k = 'card1')), 'the TV is sent the card');
select ok(not exists (select 1 from realtime.messages
                      where (topic = 'room:' || pg_temp.id('room')
                             or topic in (select 'member:' || id from public.room_members where room_id = pg_temp.id('room')))
                        and payload::text ilike '%' || (select v from ids where k = 'card1') || '%'),
          'no other topic carries it: not the room''s (the guesser listens there), not anyone''s own');
select is((select cards from public.headsup_turns where game_id = pg_temp.id('game') and number = 1), null,
          'the turn''s cards stay private while it''s on');
select pg_temp.act_as(pg_temp.uid('tv'));
select is(public.headsup_live_card(pg_temp.id('game')) ->> 'card', (select v from ids where k = 'card1'),
          'a TV that reloads gets the card back');
select pg_temp.act_as(pg_temp.uid('g1'));
select throws_ok(format($$ select public.headsup_live_card(%L) $$, pg_temp.id('game')), '42501', null,
                 'the guesser can''t ask for the card');
select pg_temp.act_as(pg_temp.uid('clue'));
select throws_ok(format($$ select public.headsup_live_card(%L) $$, pg_temp.id('game')), '42501', null,
                 'nor can any other phone (only TVs show it)');
select ok(not private.can_access_topic('display:' || pg_temp.uid('tv')), 'and no phone may join the TV''s topic');
select pg_temp.act_as(pg_temp.uid('tv'));
select ok(private.can_access_topic('display:' || pg_temp.uid('tv')), 'only the TV itself');

-- The host's lines can't name it, nor any card still to come.
select pg_temp.act_as_admin();
select throws_ok(format($$ select pg_temp.say(%L) $$, 'Come on, it''s ' || (select v from ids where k = 'card1') || '!'),
                 'GN001', null, 'the host can''t say the card on the TV');
select throws_ok(format($$ select pg_temp.say(%L) $$, 'Up next: ' || (select card from private.headsup_deck
                   where game_id = pg_temp.id('game') and shown_at is null order by position desc limit 1)),
                 'GN001', null, 'nor a card still to come');
select lives_ok($$ select pg_temp.say('On fire! Keep those clues coming!') $$, 'a line without a card is fine');

-- ---- Got it and Pass ---------------------------------------------------------------------------------------------
select throws_ok($$ select pg_temp.tap('clue', 'got', 1) $$, '42501', null,
                 'only the guesser (or the host) says Got it: not a clue-giver');
select is((pg_temp.tap('g1', 'got', 1, '11111111-1111-4111-8111-111111111111')).got, 1::smallint, 'the guesser gets it');
select is((pg_temp.tap('g1', 'got', 1, '11111111-1111-4111-8111-111111111111')).got, 1::smallint,
          'a retried tap counts once');
select is((pg_temp.turn()).shown, 2::smallint, 'and the next card is up');
select throws_ok($$ select pg_temp.tap('g1', 'pass', 1) $$, '55000', null,
                 'a late tap can''t answer the next card');
select is((pg_temp.tap('g1', 'pass', 2)).passed, 1::smallint, 'a pass');
insert into ids (k, v) values ('host', '00000000-0000-0000-0000-00000000000a');
select is((pg_temp.tap('host', 'got', 3)).got, 2::smallint, 'the host''s phone may tap for the guesser');

-- ---- the buzzer ---------------------------------------------------------------------------------------------------
select pg_temp.time_up();
select is(pg_temp.phase(), 'recap', 'time''s up: the recap');
select is(jsonb_array_length((pg_temp.turn()).cards), 4, 'the turn''s cards go public: got, passed, and the one on screen');
select is((pg_temp.turn()).cards -> 0, jsonb_build_object('card', (select v from ids where k = 'card1'), 'result', 'got'),
          'in order, with how each went');
select lives_ok(format($$ select pg_temp.say(%L) $$, 'They got ' || (select v from ids where k = 'card1') || '!'),
                'once public, a card may be said');
select ok(exists (select 1 from realtime.messages where topic = 'display:' || pg_temp.uid('tv') and payload ->> 'card' is null
                  and (payload ->> 'turn')::int = 1), 'the TV is told to take the card down');
select ok(exists (select 1 from dispatch.events where room_id = pg_temp.id('room') and kind = 'phase_complete'
                  and payload ->> 'phase' = 'guessing' and payload ->> 'got' = '2'), 'the game master hears how it went');
select throws_ok($$ select pg_temp.next_turn() $$, '55000', null, 'the recap has its time before the next turn');

-- ---- the host skips through the second turn -------------------------------------------------------------------------
select pg_temp.time_up();
select is((pg_temp.next_turn() ->> 'guesser')::uuid, pg_temp.id('g2'), 'then the second seat''s turn');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.skip_phase(pg_temp.id('game'));
select pg_temp.act_as_admin();
select is(pg_temp.phase(), 'guessing', 'the host cuts the countdown short');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.skip_phase(pg_temp.id('game'));
select pg_temp.act_as_admin();
select is(pg_temp.phase(), 'recap', 'and ends the turn early');

-- ---- the third turn, then the end -----------------------------------------------------------------------------------
select pg_temp.time_up();
select pg_temp.next_turn();
select pg_temp.time_up();
select pg_temp.tap('g3', 'got', 1);
select pg_temp.time_up();
select pg_temp.time_up();
select is(pg_temp.next_turn() ->> 'game_over', 'true', 'after everyone''s turn, the game ends');
select is(pg_temp.phase(), 'ended', 'it''s over');
select is((select reveal -> 'standings' -> 0 ->> 'member_id' from public.games where id = pg_temp.id('game')),
          pg_temp.id('g1')::text, 'the standings put the first guesser (2 got) first');
select is((select status from public.rooms where id = pg_temp.id('room')), 'lobby'::public.room_status,
          'the room goes back to its lobby');

select * from finish();
rollback;
