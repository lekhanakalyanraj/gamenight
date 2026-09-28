begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

create function pg_temp.act_as(p_uid uuid, p_guest boolean default false) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims',
                    json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_guest)::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true),
         set_config('request.headers', '', true);
$$;

insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false);
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-000000000101', true),
  ('00000000-0000-0000-0000-000000000102', true),
  ('00000000-0000-0000-0000-000000000103', true);  -- outsider

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table r on commit drop as select * from public.create_room('Host');
grant select on r to authenticated;

-- ---- a join becomes an event, in the same transaction, carrying the trace ------------------
select pg_temp.act_as_admin();
select is((select count(*)::int from dispatch.events where room_id = (select id from r)), 0,
          'the host creating the room is not a join event');

select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select set_config('request.headers',
  '{"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}', true);
select public.join_room((select code from r), 'Asha');

select pg_temp.act_as_admin();
select is((select kind || ':' || (payload ->> 'nickname') from dispatch.events where room_id = (select id from r)),
          'member_joined:Asha', 'a player joining writes a member_joined event');
select is((select traceparent from dispatch.events where room_id = (select id from r)),
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', 'the event carries the request''s traceparent');

select pg_temp.act_as('00000000-0000-0000-0000-000000000102', true);
select public.join_room((select code from r), 'Ben');
select public.leave_room((select id from r));
select public.join_room((select code from r), 'Ben');
select pg_temp.act_as_admin();
select is((select count(*)::int from dispatch.events where room_id = (select id from r)), 3,
          'leaving and rejoining counts as a new join');
select is((select traceparent from dispatch.events where payload ->> 'nickname' = 'Ben' limit 1), null,
          'a request without a traceparent gives an event without one');

-- ---- who can see and work the outbox --------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select throws_ok($$ select * from dispatch.events $$, '42501', null, 'players cannot read the outbox');
select pg_temp.act_as_admin();
grant dispatcher_svc, agents_svc to postgres;  -- rolled back with the test
select lives_ok($$ set local role dispatcher_svc; update dispatch.events set attempts = attempts; reset role $$,
                'the dispatcher can claim and update events');
select throws_ok($$ set local role dispatcher_svc; delete from dispatch.events $$, '42501', null,
                 'the dispatcher cannot delete events (they are the audit trail)');

-- ---- the AI host speaks through agents_api only ---------------------------------------------
select lives_ok(format($$ set local role agents_svc;
  select agents_api.host_say(%L, '  Welcome, Asha and Ben!  ', 'welcome', '11111111-1111-4111-8111-111111111111'); reset role $$,
  (select id from r)), 'the agents can say something in a room');
select is((select text from public.host_lines where event_id = '11111111-1111-4111-8111-111111111111'),
          'Welcome, Asha and Ben!', 'lines are trimmed');
select lives_ok(format($$ set local role agents_svc;
  select agents_api.host_say(%L, 'A different line', 'welcome', '11111111-1111-4111-8111-111111111111'); reset role $$,
  (select id from r)), 'a retried event is accepted');
select is((select count(*)::int from public.host_lines where room_id = (select id from r)), 1,
          'but never says the line twice (idempotent by event)');
select throws_ok(format($$ set local role agents_svc; select agents_api.host_say(%L, repeat('x', 281), 'announce') $$,
                 (select id from r)), '23514', null, 'lines longer than 280 characters are refused');
select is((select array_agg(p ->> 'nickname' order by p ->> 'nickname')
           from jsonb_array_elements(agents_api.room_snapshot((select id from r)) -> 'players') p),
          array['Asha', 'Ben', 'Host'], 'the snapshot lists the lobby');
select ok(agents_api.room_snapshot((select id from r))::text not like '%user_id%'
          and agents_api.room_snapshot((select id from r))::text not like '%00000000-0000%',
          'the snapshot contains no user ids');

select pg_temp.act_as('00000000-0000-0000-0000-000000000103', true);
select is((select count(*)::int from public.host_lines), 0, 'outsiders cannot read a room''s host lines');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101', true);
select is((select count(*)::int from public.host_lines), 1, 'members can');

select * from finish();
rollback;
