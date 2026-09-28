begin;
create extension if not exists pgtap with schema extensions;

select plan(22);

-- ---- helpers: act as a given user, the way PostgREST does with a verified JWT ----------
create function pg_temp.act_as(p_uid uuid, p_guest boolean default false) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims',
                    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_guest)::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

-- ---- fixtures: one host, one outsider host, and 17 guests ------------------------------
insert into auth.users (id, email, is_anonymous, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false, '{"display_name": "Lekhana"}'),
  ('00000000-0000-0000-0000-00000000000b', 'other@example.com', false, '{}');
insert into auth.users (id, is_anonymous)
select ('00000000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0'))::uuid, true
from generate_series(1, 17) g;

select is((select display_name from public.profiles where id = '00000000-0000-0000-0000-00000000000a'),
          'Lekhana', 'signing up as a host creates a profile');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-000000000101'),
          0, 'guests do not get a profile');

-- ---- creating rooms ------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table r on commit drop as select * from public.create_room('Lekhana');
grant select on r to authenticated;

select matches((select code from r), '^[A-HJ-NP-Z2-9]{6}$', 'room codes use 6 unambiguous characters');
select is((select role::text from public.room_members where room_id = (select id from r)), 'host',
          'the host is the room''s first member, because the host plays too');

select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select throws_ok($$ select public.create_room('Guest') $$, '42501', null, 'guests cannot create rooms');
select throws_ok($$ insert into public.rooms (code, host_id) values ('ABCDEF', auth.uid()) $$, '42501', null,
                 'nobody can insert rooms directly');

-- ---- joining -------------------------------------------------------------------------------
select lives_ok(format($$ select public.join_room(%L, 'Riya') $$, (select code from r)), 'a guest joins with the code');
select is((select nickname from public.join_room((select code from r), 'Riya')), 'Riya',
          'joining again is a no-op, not an error');
select is((select count(*)::int from public.room_members), 2, 'members see everyone in their room');

select pg_temp.act_as('00000000-0000-0000-0000-000000000102', true);
select throws_ok(format($$ select public.join_room(%L, ' riya ') $$, (select code from r)), '23505', null,
                 'nicknames are unique per room, ignoring case and spaces');
select throws_ok($$ select public.join_room('ZZZZZZ', 'Mei') $$, 'P0002', null, 'unknown codes are rejected');
select lives_ok(format($$ select public.join_room(lower(%L), 'Mei') $$, (select code from r)),
                'codes are case-insensitive');

-- ---- capacity: 16 players including the host ------------------------------------------
select pg_temp.act_as_admin();
create function pg_temp.fill(p_code text, p_upto int) returns void language plpgsql as $$
begin
  for g in 3..p_upto loop
    perform set_config('request.jwt.claims', json_build_object('sub',
      ('00000000-0000-0000-0000-0000000001' || lpad(g::text, 2, '0')), 'role', 'authenticated',
      'is_anonymous', true)::text, true);
    perform public.join_room(p_code, 'player' || g);
  end loop;
end $$;
select pg_temp.fill((select code from r), 15);  -- host + Riya + Mei + 13 more = 16
select is((select count(*)::int from public.room_members where left_at is null), 16, 'the room holds 16 players');
select pg_temp.act_as('00000000-0000-0000-0000-000000000117', true);
select throws_ok(format($$ select public.join_room(%L, 'late') $$, (select code from r)), '53400', null,
                 'the 17th player is turned away');

-- ---- isolation between rooms --------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.rooms), 0, 'outsiders cannot see a room they are not in');
select is((select count(*)::int from public.room_members), 0, 'outsiders cannot see its members');
select ok(not public.can_access_room_topic('room:' || (select id from r)::text),
          'outsiders cannot subscribe to the room''s realtime topic');
select ok(not public.can_access_room_topic('room:not-a-uuid'), 'malformed topics are refused');

select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select ok(public.can_access_room_topic('room:' || (select id from r)::text), 'members can subscribe to their room''s topic');

-- ---- adult rooms ---------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b');
select throws_ok($$ select public.create_room('Host', 'adult') $$, '42501', null,
                 'hosting an adult room needs an 18+ confirmation');
create temp table adult on commit drop as select * from public.create_room('Host', 'adult', true);
grant select on adult to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000117', true);
select throws_ok(format($$ select public.join_room(%L, 'Zara') $$, (select code from adult)), '42501', null,
                 'joining an adult room needs an 18+ confirmation');
select lives_ok(format($$ select public.join_room(%L, 'Zara', true) $$, (select code from adult)),
                'guests who confirm can join an adult room');

select * from finish();
rollback;
