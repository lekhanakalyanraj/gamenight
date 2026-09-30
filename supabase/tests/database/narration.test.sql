begin;
create extension if not exists pgtap with schema extensions;

-- The narrator's voice: every host line is queued for voicing with it, only the voice service reaches its
-- tables, and in the narration bucket only the voice service writes, while a room hears only its own clips.

select plan(18);

create function pg_temp.act_as(p_uid uuid, p_service text default null) returns void language sql as $$
  select set_config('role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object(
           'sub', p_uid, 'role', 'authenticated',
           'app_metadata', json_strip_nulls(json_build_object('provider', 'email', 'service', p_service)))::text, true);
$$;
create function pg_temp.act_as_admin() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

-- ---- fixtures: a host and a guest in one room, a stranger, and the voice service's account ---------------
insert into auth.users (id, email, is_anonymous) values
  ('00000000-0000-0000-0000-00000000000a', 'host@example.com', false),
  ('00000000-0000-0000-0000-00000000000f', 'voice@example.com', false);
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-000000000101', true),  -- Asha, in the room
  ('00000000-0000-0000-0000-000000000104', true);  -- a stranger

select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
create temp table r on commit drop as select * from public.create_room('Host');
grant select on r to authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select public.join_room((select code from r), 'Asha');
select pg_temp.act_as_admin();

-- ---- every host line is queued, with the right voice ------------------------------------------------------
insert into public.host_lines (room_id, kind, text) values ((select id from r), 'welcome', 'Welcome, Asha!');
select is((select persona from narration.requests q join public.host_lines l on l.id = q.line_id
           where l.text = 'Welcome, Asha!'), 'host', 'a lobby line is queued for voicing in the host''s voice');

insert into public.games (room_id, kind) values ((select id from r), 'undercover');
insert into public.host_lines (room_id, kind, text) values ((select id from r), 'narration', 'Interesting clue...');
select is((select persona from narration.requests q join public.host_lines l on l.id = q.line_id
           where l.text = 'Interesting clue...'), 'undercover', 'narration is queued in the game master''s voice');
select is((select q.text from narration.requests q join public.host_lines l on l.id = q.line_id
           where l.text = 'Interesting clue...'), 'Interesting clue...', 'the request carries the line as shown');

-- ---- only the voice service reaches its tables ------------------------------------------------------------
select throws_ok($$ select pg_temp.act_as('00000000-0000-0000-0000-000000000101'); select * from narration.clips $$,
                 '42501', null, 'players cannot read the voice service''s tables');
select pg_temp.act_as_admin();
grant voice_svc to postgres;
set local role voice_svc;
create temp table voice_sees on commit drop as select count(*)::int as n from narration.requests;
reset role;
select ok((select n from voice_sees) >= 2, 'the voice service reads its requests');
select throws_ok($$ set local role voice_svc; select * from public.host_lines $$,
                 '42501', null, 'the voice service cannot read the game''s tables (only its own queue)');

-- ---- a clip goes to the room ------------------------------------------------------------------------------
insert into narration.clips (line_id, room_id, path)
select q.line_id, q.room_id, 'clips/abc.mp3' from narration.requests q
join public.host_lines l on l.id = q.line_id where l.text = 'Interesting clue...';
select ok(exists (select 1 from realtime.messages where topic = 'room:' || (select id from r)::text
                  and payload ->> 'table' = 'clips' and payload -> 'record' ->> 'path' = 'clips/abc.mp3'),
          'a clip is broadcast to the room');

-- ---- the bucket: only the voice service writes; a room hears only its own clips ----------------------------
select is((select public from storage.buckets where id = 'narration'), false, 'the narration bucket is private');

select pg_temp.act_as('00000000-0000-0000-0000-00000000000f', 'voice');
select lives_ok($$ insert into storage.objects (bucket_id, name) values ('narration', 'clips/abc.mp3') $$,
                'the voice service stores a clip');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('narration', 'clips/fake.mp3') $$,
                 '42501', null, 'a host cannot put audio in the bucket');
select pg_temp.act_as('00000000-0000-0000-0000-000000000104', 'dispatcher');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('narration', 'clips/fake.mp3') $$,
                 '42501', null, 'nor can an account marked as another service');

select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select is((select count(*)::int from storage.objects where bucket_id = 'narration' and name = 'clips/abc.mp3'), 1,
          'a player hears a clip of their room');
select pg_temp.act_as('00000000-0000-0000-0000-000000000104');
select is((select count(*)::int from storage.objects where bucket_id = 'narration'), 0,
          'a stranger hears nothing');
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select is((select count(*)::int from storage.objects where bucket_id = 'narration' and name <> 'clips/abc.mp3'), 0,
          'a player can''t see other clips in the bucket');

-- ---- the host's voice switch ---------------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-000000000101');
select throws_ok($$ select public.set_voice((select id from r), false) $$, '42501', null,
                 'only the host can turn the voice off');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.set_voice((select id from r), false);
select pg_temp.act_as_admin();
select is((select voice from public.rooms where id = (select id from r)), false, 'the host turns the voice off');
insert into public.host_lines (room_id, kind, text) values ((select id from r), 'narration', 'Said while muted.');
select is((select count(*)::int from narration.requests q join public.host_lines l on l.id = q.line_id
           where l.text = 'Said while muted.'), 0, 'while the voice is off, a line stays a caption: nothing is queued');
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a');
select public.set_voice((select id from r), true);
select pg_temp.act_as_admin();
insert into public.host_lines (room_id, kind, text) values ((select id from r), 'narration', 'Back on air.');
select is((select count(*)::int from narration.requests q join public.host_lines l on l.id = q.line_id
           where l.text = 'Back on air.'), 1, 'turned back on, lines are voiced again');

select pg_temp.act_as_admin();
select * from finish();
rollback;
