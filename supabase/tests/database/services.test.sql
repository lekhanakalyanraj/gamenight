begin;
create extension if not exists pgtap with schema extensions;

-- Each service role reaches only its own schema. These checks cover every table in every
-- application schema, including ones added later, so a cross-service shortcut fails CI.

select plan(8);

create temp table svc (role text, own_schema text) on commit drop;
insert into svc values ('dispatcher_svc', 'dispatch'), ('voice_svc', 'narration'), ('catalog_svc', 'catalog'),
  ('agents_svc', 'agents_api'), ('game_master_svc', 'game_api');

-- Postgres lets every role look inside the public schema by default (Supabase's own roles rely on
-- it), so these checks cover what a role could actually do there: read tables or call privileged functions.
select is_empty(
  $$ select s.role || ' can use ' || n.nspname
     from svc s cross join pg_namespace n
     where n.nspname in ('private', 'auth', 'storage', 'realtime', 'dispatch', 'narration', 'catalog', 'agents_api',
                         'game_api', 'content')
       and n.nspname <> s.own_schema
       and has_schema_privilege(s.role, n.oid, 'usage') $$,
  'each service role can use only its own schema (besides public, which Postgres opens to everyone)'
);

select is_empty(
  $$ select s.role || ' can call ' || p.oid::regprocedure::text
     from svc s cross join pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prosecdef
       and has_function_privilege(s.role, p.oid, 'execute') $$,
  'no service role can call a SECURITY DEFINER function in public or private (which would bypass RLS)'
);

select is_empty(
  $$ select s.role || ' can read ' || n.nspname || '.' || c.relname
     from svc s cross join pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm')
       and n.nspname in ('public', 'private', 'auth', 'storage', 'realtime', 'dispatch', 'narration', 'catalog', 'agents_api',
                         'game_api', 'content')
       and n.nspname <> s.own_schema
       and has_table_privilege(s.role, c.oid, 'select') $$,
  'no service role can read another service''s tables, the game tables or auth'
);

select is_empty(
  $$ select r.rolname from pg_roles r join svc s on s.role = r.rolname
     where r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb $$,
  'service roles have no special powers (logins are granted per environment; locally by seed.sql)'
);

select is_empty(
  $$ select n.nspname || ' (' || g.grantee || ')'
     from pg_namespace n cross join (values ('anon'), ('authenticated')) g(grantee)
     where n.nspname in ('dispatch', 'narration', 'catalog', 'agents_api', 'game_api', 'content') and has_schema_privilege(g.grantee, n.oid, 'usage') $$,
  'players and visitors cannot use any service schema'
);

-- Postgres 16+ doesn't make a role's creator a member; grant it here (rolled back with the test).
-- The role switches wrap only the statement under test: pgTAP itself lives in a schema these roles can't use.
grant catalog_svc, voice_svc to postgres;

set local role catalog_svc;
create temp table catalog_rows on commit drop as select count(*)::int as n from catalog.games;
reset role;
select is((select n from catalog_rows), 3, 'the catalog service reads the catalogue (Undercover, Quiz Night, Heads Up)');

select throws_ok($$ set local role catalog_svc; insert into catalog.games values ('x', 'X', 3, 3, 1, 'x') $$,
                 '42501', null, 'the catalogue is read-only for the catalog service');
select throws_ok($$ set local role voice_svc; select * from catalog.games $$,
                 '42501', null, 'the voice service cannot read the catalogue');

select * from finish();
rollback;
