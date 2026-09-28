begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

-- ---- helpers: act as a given user, the way PostgREST does with a verified JWT ----------
create function pg_temp.act_as(p_uid uuid, p_guest boolean default false) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims',
                    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_guest)::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;
-- Wrong guesses in a loop, so every call really runs (a set-returning query could call once).
create function pg_temp.miss_joins(n int) returns int language plpgsql as $$
declare
  v_misses int := 0;
begin
  for i in 1..n loop
    if (public.join_room('ZZZZZZ', 'Spy')).id is null then
      v_misses := v_misses + 1;
    end if;
  end loop;
  return v_misses;
end $$;
create function pg_temp.miss_pairings(p_room_id uuid, n int) returns void language plpgsql as $$
begin
  for i in 1..n loop
    perform public.pair_display(p_room_id, 'ZZZZZZ');
  end loop;
end $$;

-- ---- fixtures: two hosts, two TVs, three guests, one stranger ---------------------------
insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false),
  ('00000000-0000-0000-0000-00000000000b', 'other@example.com', false);
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-000000000201', true),  -- TV
  ('00000000-0000-0000-0000-000000000202', true),  -- another TV
  ('00000000-0000-0000-0000-000000000101', true),  -- Asha
  ('00000000-0000-0000-0000-000000000102', true),  -- Ben
  ('00000000-0000-0000-0000-000000000104', true);  -- a stranger guessing codes

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table r on commit drop as select * from public.create_room('Host');
create temp table codes (who text, code text) on commit drop;
grant select on r to authenticated;
grant all on codes to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
create temp table asha on commit drop as select * from public.join_room((select code from r), 'Asha');
grant select on asha to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000102', true);
select public.join_room((select code from r), 'Ben');

-- ---- pairing a TV ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000201', true);
insert into codes select 'tv-first', public.start_display_pairing();
select matches((select code from codes where who = 'tv-first'), '^[A-HJ-NP-Z2-9]{6}$',
               'a TV gets a 6-character pairing code');
select is(public.start_display_pairing(), (select code from codes where who = 'tv-first'),
          'asking again while the code is fresh returns the same code');
select pg_temp.act_as_admin();
update public.display_pairings set expires_at = now() + interval '1 minute'
where user_id = '00000000-0000-0000-0000-000000000201';
select pg_temp.act_as('00000000-0000-0000-0000-000000000201', true);
insert into codes select 'tv', public.start_display_pairing();
select ok((select count(*) from public.display_pairings) = 1
          and (select code from public.display_pairings) = (select code from codes where who = 'tv')
          and (select expires_at from public.display_pairings) > now() + interval '9 minutes',
          'near expiry, asking again replaces the old code with a fresh one');

select pg_temp.act_as('00000000-0000-0000-0000-000000000202', true);
insert into codes select 'tv2', public.start_display_pairing();
select is((select count(*)::int from public.display_pairings), 1, 'a TV can only see its own code');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select throws_ok(format($$ select public.pair_display(%L, %L) $$, (select id from r), (select code from codes where who = 'tv')),
                 '42501', null, 'another host cannot put this room on a TV');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select throws_ok(format($$ select public.pair_display(%L, %L) $$, (select id from r), (select code from codes where who = 'tv')),
                 '42501', null, 'players cannot connect a TV; only the host can');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is((select id from public.pair_display((select id from r), 'ZZZZZZ')), null, 'a wrong code pairs nothing');
create temp table display on commit drop as
  select * from public.pair_display((select id from r), lower((select code from codes where who = 'tv')));
grant select on display to authenticated;
select is((select user_id from display), '00000000-0000-0000-0000-000000000201'::uuid,
          'the host pairs the TV by entering its code (case-insensitive)');
select is((select id from public.pair_display((select id from r), (select code from codes where who = 'tv'))), null,
          'a code works once');

select pg_temp.act_as_admin();
select ok(exists (select 1 from realtime.messages
                  where topic = 'display:00000000-0000-0000-0000-000000000201' and event = 'paired'),
          'pairing tells the TV which room to show');
update public.display_pairings set expires_at = now() - interval '1 second'
where user_id = '00000000-0000-0000-0000-000000000202';
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select is((select id from public.pair_display((select id from r), (select code from codes where who = 'tv2'))), null,
          'expired codes pair nothing');

-- ---- what a TV can and can't do -------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000201', true);
select is((select code from public.rooms), (select code from r), 'a paired TV can read its room');
select is((select count(*)::int from public.room_members), 3, 'a paired TV can read the lobby');
select ok(private.can_access_topic('room:' || (select id from r)::text)
          and private.can_access_topic('display:00000000-0000-0000-0000-000000000201'),
          'a paired TV can subscribe to its room''s topic and its own');
select ok(not private.can_access_topic('display:00000000-0000-0000-0000-000000000202'),
          'a TV cannot listen to another TV''s topic');
select throws_ok(format($$ select public.join_room(%L, 'TV') $$, (select code from r)), '42501', null,
                 'the room''s TV cannot join as a player');
select throws_ok(format($$ select public.kick_member(%L) $$, (select id from asha)), '42501', null,
                 'a TV cannot remove players');

-- ---- removing players -----------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000102', true);
select throws_ok(format($$ select public.kick_member(%L) $$, (select id from asha)), '42501', null,
                 'players cannot remove each other');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok(format($$ select public.kick_member(%L) $$,
                        (select id from public.room_members where role = 'host')), '42501', null,
                 'the host cannot remove themselves');
select lives_ok(format($$ select public.kick_member(%L) $$, (select id from asha)), 'the host removes a player');
select is((select count(*)::int from public.room_members where left_at is null), 2, 'the lobby shrinks');

select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select is((select count(*)::int from public.rooms), 0, 'a removed player can no longer see the room');
select throws_ok(format($$ select public.join_room(%L, 'Asha again') $$, (select code from r)), '42501',
                 'The host removed you from this room.', 'a removed player cannot rejoin');

-- ---- disconnecting a TV ---------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select throws_ok(format($$ select public.remove_display(%L) $$, (select id from display)), '42501', null,
                 'another host cannot disconnect the TV');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.remove_display((select id from display));
select pg_temp.act_as('00000000-0000-0000-0000-000000000201', true);
select is((select count(*)::int from public.rooms), 0, 'a disconnected TV can no longer see the room');

-- ---- rate limit on guessing codes -----------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000104', true);
select is(pg_temp.miss_joins(10), 10, 'ten wrong codes each find nothing');
select throws_ok(format($$ select public.join_room(%L, 'Spy') $$, (select code from r)), 'PT429', null,
                 'the 11th attempt is refused, even with the right code');
select pg_temp.act_as_admin();
update private.join_attempts set attempted_at = attempted_at - interval '11 minutes'
where user_id = '00000000-0000-0000-0000-000000000104';
select pg_temp.act_as('00000000-0000-0000-0000-000000000104', true);
select lives_ok(format($$ select public.join_room(%L, 'Spy') $$, (select code from r)),
                'the limit lifts after 10 minutes');

-- The host has already missed 3 pairing codes above (wrong, used, expired). 7 more make 10.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select pg_temp.miss_pairings((select id from r), 7);
select throws_ok(format($$ select public.join_room(%L, 'Host') $$, (select code from r)), 'PT429', null,
                 'missed pairing codes count toward the same limit');

-- ---- room changes reach everyone watching ---------------------------------------------------
select public.leave_room((select id from r));
select pg_temp.act_as_admin();
select ok(exists (select 1 from realtime.messages
                  where topic = 'room:' || (select id from r)::text and event = 'UPDATE'
                    and payload ->> 'table' = 'rooms'),
          'closing the room is broadcast on the room''s topic');

select * from finish();
rollback;
