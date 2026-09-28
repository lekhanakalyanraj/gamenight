-- Lock down helper functions flagged by Supabase's security advisor (splinter).
--
-- Supabase grants EXECUTE on new functions in `public` to anon and authenticated, and the Data API
-- exposes every function in `public` at /rest/v1/rpc. So:
--   * helpers that RLS policies call move to `private`, which the Data API doesn't expose;
--     authenticated keeps EXECUTE because policies run with the caller's privileges
--   * trigger functions lose EXECUTE entirely: Postgres checks it when the trigger is created,
--     not when it fires

create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Policies reference functions by OID, so they keep working after the move.
alter function public.is_room_member(uuid) set schema private;
alter function public.can_access_room_topic(text) set schema private;

-- can_access_room_topic calls is_room_member by name, so its body needs the new schema.
create or replace function private.can_access_room_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_topic !~ '^room:[0-9a-f-]{36}$' then
    return false;
  end if;
  return private.is_room_member(substr(p_topic, 6)::uuid);
end;
$$;

revoke all on function private.is_room_member(uuid) from public, anon;
revoke all on function private.can_access_room_topic(text) from public, anon;
grant execute on function private.is_room_member(uuid) to authenticated;
grant execute on function private.can_access_room_topic(text) to authenticated;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.broadcast_room_member_change() from public, anon, authenticated;
