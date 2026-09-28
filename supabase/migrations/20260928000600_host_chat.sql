-- Host chat: the Agent Server's auth handler asks the database whether a user hosts a room, so only
-- a room's host can read or run that room's agent thread (thread id = room id).

create function agents_api.is_room_host(p_room_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.host_id = p_user_id and r.status <> 'closed'
  );
$$;

revoke all on function agents_api.is_room_host(uuid, uuid) from public;
grant execute on function agents_api.is_room_host(uuid, uuid) to agents_svc;
