-- Local development seed. Runs on `supabase db reset`; never used outside the local stack.
--
-- Demo host account for trying the app locally:
--   email:    host@gamenight.test
--   password: gamenight-local-demo

do $$
declare
  v_id uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    'host@gamenight.test', extensions.crypt('gamenight-local-demo', extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}', '{"display_name": "Demo Host"}', now(), now(),
    '', '', '', ''
  );

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), v_id, v_id::text,
    jsonb_build_object('sub', v_id::text, 'email', 'host@gamenight.test', 'email_verified', true),
    'email', now(), now(), now()
  );
end;
$$;

-- Local-only logins for the services, so docker compose can connect each as its own role.
-- Every other environment grants these out of band; the migrations create the roles without login.
alter role dispatcher_svc login password 'local-dev-dispatcher';
alter role agents_svc login password 'local-dev-agents';
alter role catalog_svc login password 'local-dev-catalog';
