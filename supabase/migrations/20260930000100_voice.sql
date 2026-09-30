-- The narrator's voice (slice 4): every line the TV shows is also spoken.
--
-- A host line exists only after the narrator's checks, so voicing host_lines never voices unchecked text.
-- The line and its voicing request commit together (an outbox in the voice service's own schema), and
-- NOTIFY wakes the voice service. It turns the text into a clip in the private `narration` bucket and
-- records it in narration.clips, which is broadcast to the room. Captions never wait for any of this: a
-- line the voice service can't voice in time is simply heard as a caption.

-- ---------------------------------------------------------------------------
-- The voice service's tables (only voice_svc can reach them)
-- ---------------------------------------------------------------------------

create table narration.requests (
  line_id uuid primary key references public.host_lines (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  text text not null,
  persona text not null,  -- whose voice: 'host' in the lobby, else the game's kind (its game master)
  created_at timestamptz not null,  -- when the line was shown: too old, and it's not worth voicing
  attempts smallint not null default 0,
  lease_until timestamptz,  -- a voice worker has it until then
  next_attempt_at timestamptz not null default now(),
  done_at timestamptz,
  outcome text check (outcome in ('voiced', 'cached', 'stale', 'over_budget', 'failed')),
  last_error text
);
create index requests_due_idx on narration.requests (next_attempt_at) where done_at is null;
create index requests_room_id_idx on narration.requests (room_id);

-- One clip per voiced line. Broadcast whole to the room: it holds nothing the room hasn't seen.
create table narration.clips (
  line_id uuid primary key references public.host_lines (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  path text not null,  -- in the narration bucket: clips/<key>.<ext>
  created_at timestamptz not null default now()
);
create index clips_path_idx on narration.clips (path);
create index clips_room_id_idx on narration.clips (room_id);

-- Clips are stored by (voice, model, text), so a line said again costs nothing. Unused for a day: deleted.
create table narration.cache (
  key text primary key,
  path text not null unique,
  characters integer not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

-- Characters sent to each text-to-speech provider per month, against the monthly cap.
create table narration.usage (
  month date not null,
  provider text not null,
  characters integer not null default 0 check (characters >= 0),
  primary key (month, provider)
);

alter table narration.requests enable row level security;
alter table narration.clips enable row level security;
alter table narration.cache enable row level security;
alter table narration.usage enable row level security;
create policy "the voice service works its requests" on narration.requests
  for all to voice_svc using (true) with check (true);
create policy "the voice service records clips" on narration.clips
  for all to voice_svc using (true) with check (true);
create policy "the voice service keeps its cache" on narration.cache
  for all to voice_svc using (true) with check (true);
create policy "the voice service counts characters" on narration.usage
  for all to voice_svc using (true) with check (true);
grant select, update on narration.requests to voice_svc;
grant select, insert, delete on narration.clips to voice_svc;
grant select, insert, update, delete on narration.cache to voice_svc;
grant select, insert, update on narration.usage to voice_svc;
-- Finished requests are kept a week for the record, then the voice service tidies them.
grant delete on narration.requests to voice_svc;

-- ---------------------------------------------------------------------------
-- Every host line is queued for voicing in the same transaction
-- ---------------------------------------------------------------------------

create function private.enqueue_narration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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
revoke all on function private.enqueue_narration() from public, anon, authenticated;

create trigger host_lines_enqueue_narration
  after insert on public.host_lines
  for each row execute function private.enqueue_narration();

-- A clip goes to the room on its topic, like the line it voices.
create function private.broadcast_clip()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'room:' || new.room_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, null
  );
  return null;
end;
$$;
revoke all on function private.broadcast_clip() from public, anon, authenticated;

create trigger clips_broadcast
  after insert on narration.clips
  for each row execute function private.broadcast_clip();

-- ---------------------------------------------------------------------------
-- The audio: a private bucket
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('narration', 'narration', false, 1048576, array['audio/mpeg', 'audio/wav']);

-- Whether the signed-in user may hear a stored clip: it voices a line in a room they can view.
create function private.can_hear_clip(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from narration.clips c where c.path = p_path and private.can_view_room(c.room_id)
  );
$$;
revoke all on function private.can_hear_clip(text) from public, anon;
grant execute on function private.can_hear_clip(text) to authenticated;

create policy "players and TVs hear their room's clips" on storage.objects
  for select to authenticated
  using (bucket_id = 'narration' and private.can_hear_clip(name));

-- The voice service reaches Storage as its own Supabase Auth account, marked service = voice in its app
-- metadata, which only an admin can set. It writes and tidies the bucket; nobody else can.
create policy "the voice service stores clips" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'narration' and (select auth.jwt() -> 'app_metadata' ->> 'service') = 'voice');
create policy "the voice service manages its clips" on storage.objects
  for select to authenticated
  using (bucket_id = 'narration' and (select auth.jwt() -> 'app_metadata' ->> 'service') = 'voice');
create policy "the voice service deletes old clips" on storage.objects
  for delete to authenticated
  using (bucket_id = 'narration' and (select auth.jwt() -> 'app_metadata' ->> 'service') = 'voice');
