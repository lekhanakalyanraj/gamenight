begin;
create extension if not exists pgtap with schema extensions;

-- Schema-wide security invariants. These hold for every table and function, including ones
-- added by future migrations, so a new table without RLS or a new API-callable SECURITY DEFINER
-- function fails CI until it's deliberately allowed here.

select plan(8);

select is_empty(
  $$ select c.relname::text
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity $$,
  'every table in public has row-level security enabled'
);

select is_empty(
  $$ select n.nspname || '.' || p.proname
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private', 'dispatch', 'agents_api', 'game_api', 'content') and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%') $$,
  'every SECURITY DEFINER function pins its search_path'
);

select is_empty(
  $$ select p.oid::regprocedure::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') $$,
  'signed-out visitors (anon) cannot call any SECURITY DEFINER function through the API'
);

select set_eq(
  $$ select p.proname::text
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute') $$,
  array['create_room', 'join_room', 'leave_room', 'kick_member',
        'start_display_pairing', 'pair_display', 'remove_display',
        'start_game', 'submit_action', 'pause_game', 'resume_game', 'extend_phase', 'skip_turn', 'skip_phase',
        'settle_judgement', 'end_game'],
  'the only SECURITY DEFINER functions signed-in users can call through the API are the room and game RPCs'
);

select ok(
  not has_function_privilege('authenticated', 'public.handle_new_user()', 'execute')
  and not has_function_privilege('authenticated', 'public.broadcast_room_member_change()', 'execute'),
  'trigger functions cannot be called directly'
);

select ok(
  has_function_privilege('authenticated', 'private.is_room_member(uuid)', 'execute')
  and has_function_privilege('authenticated', 'private.can_view_room(uuid)', 'execute')
  and has_function_privilege('authenticated', 'private.can_access_topic(text)', 'execute'),
  'signed-in users can still evaluate the RLS helpers that policies depend on'
);

select ok(
  not has_schema_privilege('anon', 'private', 'usage')
  and not has_schema_privilege('anon', 'content', 'usage')
  and not has_schema_privilege('authenticated', 'content', 'usage'),
  'signed-out visitors cannot use the private schema, and nobody outside the game master can reach the word bank'
);

select is_empty(
  $$ select table_name::text || ' (' || grantee || ')'
     from information_schema.role_table_grants
     where table_schema in ('private', 'content') and grantee in ('anon', 'authenticated') $$,
  'signed-in users and visitors have no direct access to any table in the private or content schemas'
);

select * from finish();
rollback;
