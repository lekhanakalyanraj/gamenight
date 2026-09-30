-- The host's voice switch (slice 4.2): the host can turn the narrator's voice off for their room, and back on.
-- While it's off, lines are shown as captions only and none is queued for voicing, so nothing is spent on text
-- to speech. The switch is part of the room row, which is broadcast to the room like any other room change.

alter table public.rooms add column voice boolean not null default true;

create function public.set_voice(p_room_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_on is null then
    raise exception 'Say whether the voice is on or off.' using errcode = '22023';
  end if;
  update public.rooms set voice = p_on
  where id = p_room_id and host_id = (select auth.uid()) and status <> 'closed';
  if not found then
    raise exception 'Only the host can turn the voice on or off.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.set_voice(uuid, boolean) from public, anon;
grant execute on function public.set_voice(uuid, boolean) to authenticated;

-- Lines shown while the voice is off aren't queued for voicing.
create or replace function private.enqueue_narration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select r.voice from public.rooms r where r.id = new.room_id) then
    return null;
  end if;
  insert into narration.requests (line_id, room_id, text, persona, created_at)
  values (
    new.id, new.room_id, new.text,
    case when new.kind = 'narration'
         then coalesce((select g.kind::text from public.games g where g.room_id = new.room_id
                        order by g.created_at desc limit 1), 'host')
         else 'host' end,
    new.created_at
  );
  perform pg_notify('narration_requests', new.id::text);
  return null;
end;
$$;
