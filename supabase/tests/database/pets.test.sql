begin;
create extension if not exists pgtap with schema extensions;

-- The TV's pets: on in a new room, and only the room's host can switch them off and on again.

select plan(5);

create function pg_temp.act_as(p_uid uuid) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object(
           'sub', p_uid, 'role', 'authenticated', 'app_metadata', json_build_object('provider', 'email'))::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false);
insert into auth.users (id, is_anonymous) values ('00000000-0000-0000-0000-000000000101', true);

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table r on commit drop as select * from public.create_room('Host');
grant select on r to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select public.join_room((select code from r), 'Asha');
select pg_temp.act_as_admin();

select is((select pets from public.rooms where id = (select id from r)), true, 'a new room has its pets on');

select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select throws_ok($$ select public.set_pets((select id from r), false) $$, '42501', null,
                 'a player can''t switch the pets off');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select lives_ok($$ select public.set_pets((select id from r), false) $$, 'the host switches them off');
select pg_temp.act_as_admin();
select is((select pets from public.rooms where id = (select id from r)), false, 'and they stay off');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok($$ select public.set_pets((select id from r), null) $$, '22023', null, 'on or off, nothing else');

select pg_temp.act_as_admin();
select * from finish();
rollback;
