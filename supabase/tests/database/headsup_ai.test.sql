begin;
create extension if not exists pgtap with schema extensions;

-- Heads Up, 6b: picking interests tells the room's agent (interests_picked); the agent reads an interest's coverage
-- (a count) and saves reviewed cards, checked again here; a run of Got it tells the game master (streak).

select plan(15);

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

create function pg_temp.save(p_topic text, p_card text) returns uuid language plpgsql as $$
declare r uuid;
begin
  set local role agents_svc;
  r := agents_api.save_headsup_card(p_topic, p_card, 'family');
  reset role;
  return r;
end $$;
create function pg_temp.coverage(p_topic text) returns int language plpgsql as $$
declare r int;
begin
  set local role agents_svc;
  r := agents_api.headsup_coverage(pg_temp.id('room'), p_topic);
  reset role;
  return r;
end $$;
grant agents_svc to postgres;
grant select on ids to agents_svc;
grant execute on function pg_temp.id(text) to agents_svc;

-- ---- interests_picked ---------------------------------------------------------------------------------------------
select pg_temp.act_as(pg_temp.uid('asha'));
select public.set_interests(pg_temp.id('room'), array['Cricket', 'Space travel']);
select public.set_interests(pg_temp.id('room'), array['cricket', 'space travel']);  -- the same, but cased
select public.set_interests(pg_temp.id('room'), array['Cricket', 'Space travel', 'Music']);  -- a real change
select pg_temp.act_as_admin();
select is((select count(*)::int from dispatch.events where room_id = pg_temp.id('room') and kind = 'interests_picked'), 2,
          'picking interests tells the room''s agent, and a change tells it again (the same ones in another case don''t)');
select is((select payload -> 'interests' from dispatch.events where room_id = pg_temp.id('room') and kind = 'interests_picked'
           order by created_at limit 1), '["Cricket", "Space travel"]'::jsonb, 'with the interests picked');

-- ---- coverage and saving ------------------------------------------------------------------------------------------
select is(pg_temp.coverage(' Cricket '), (select count(*)::int from content.headsup_cards where topic = 'cricket'),
          'coverage counts an interest''s cards (any case, trimmed)');
select is(pg_temp.coverage('space travel'), 0, 'an interest with no cards yet has none');
select isnt(pg_temp.save('Space Travel', '  International   Space Station '), null, 'a reviewed card is saved');
select is((select row(topic, card, origin, status)::text from content.headsup_cards where card = 'International Space Station'),
          row('space travel', 'International Space Station', 'generated', 'verified')::text,
          'filed under its interest, spaces tidied, ready to deal');
select is(pg_temp.save('space travel', 'international space station'), null, 'the same card again (any case) is skipped');
select throws_ok($$ select pg_temp.save('space travel', '<img src=x onerror=alert(1)>') $$, '22023', null, 'no markup in a card');
select throws_ok($$ select pg_temp.save('space travel', 'A card far too long to read from across the living room') $$,
                 '22023', null, 'a card fits on the TV: 40 characters at most');
select ok(not has_function_privilege('authenticated', 'agents_api.save_headsup_card(text, text, public.age_rating)', 'execute'),
          'players can''t save cards');

-- ---- a streak -----------------------------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.start_game(pg_temp.id('room'), 'heads_up', '{"turns": 1, "seconds": 45}');
select pg_temp.act_as_admin();
insert into ids (k, id) select 'game', id from public.games where room_id = pg_temp.id('room');
insert into ids (k, id, v) select 'g1', m.id, m.user_id::text from public.games g join public.room_members m on m.id = g.turn_order[1]
where g.id = pg_temp.id('game');
select pg_temp.next_turn();
select pg_temp.time_up();
select pg_temp.tap('g1', 'got', 1);
select pg_temp.tap('g1', 'got', 2);
select is((select count(*)::int from dispatch.events where room_id = pg_temp.id('room') and kind = 'streak'), 0,
          'two in a row isn''t a streak yet');
select pg_temp.tap('g1', 'got', 3);
select is((select payload ->> 'streak' from dispatch.events where room_id = pg_temp.id('room') and kind = 'streak'), '3',
          'three in a row tells the game master');
select ok((select (payload ->> 'game_id')::uuid = pg_temp.id('game') and payload ->> 'guesser' = pg_temp.id('g1')::text
           from dispatch.events where room_id = pg_temp.id('room') and kind = 'streak'), 'for this game and guesser');
select pg_temp.tap('g1', 'pass', 4);
select pg_temp.tap('g1', 'got', 5);
select pg_temp.tap('g1', 'got', 6);
select pg_temp.tap('g1', 'got', 7);
select is((select count(*)::int from dispatch.events where room_id = pg_temp.id('room') and kind = 'streak'), 2,
          'a pass breaks the run; the next three make a new one');
select ok(not exists (select 1 from dispatch.events where room_id = pg_temp.id('room') and kind = 'streak'
                      and payload::text ilike '%' || (select card from private.headsup_deck where game_id = pg_temp.id('game')
                                                          and position = (select position from private.headsup_live
                                                                          where game_id = pg_temp.id('game'))) || '%'),
          'a streak event never carries a card');

select * from finish();
rollback;
