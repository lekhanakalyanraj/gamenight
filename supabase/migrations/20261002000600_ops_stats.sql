-- Operations numbers for the dashboards: how many rooms are open, players in them, and games running by kind.
-- Counts only (never a room, a name or a card), for the dispatcher, which publishes them as metrics every 15 s.

create function dispatch.ops_stats()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'rooms_open', (select count(*) from public.rooms where status <> 'closed'),
    'players_in_rooms', (select count(*) from public.room_members m join public.rooms r on r.id = m.room_id
                         where r.status <> 'closed' and m.left_at is null),
    'games_running', (select coalesce(jsonb_object_agg(kind, n), '{}')
                      from (select kind::text, count(*) as n from public.games where phase <> 'ended' group by kind) g)
  );
$$;

revoke all on function dispatch.ops_stats() from public, anon, authenticated;
grant execute on function dispatch.ops_stats() to dispatcher_svc;
