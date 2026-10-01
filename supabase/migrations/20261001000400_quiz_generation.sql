-- Quiz Night, 5b: the question bank grows itself. When a player picks a topic in the lobby, the room's agent tops up
-- the bank for that topic in the background (grounded questions: each answer backed by a sentence from its English
-- Wikipedia source, checked before it's saved), so the game never waits at the start.
--
--   topic_picked: a new outbox event, to the room's agent (the lobby; no game exists yet)
--   agents_api.quiz_coverage: how many usable questions a topic has, by kind (counts only: never an answer)
--   agents_api.save_quiz_question: saves one verified question (checked again here: shape, source, length)

alter table dispatch.events drop constraint events_kind_check;
alter table dispatch.events add constraint events_kind_check
  check (kind in ('member_joined', 'game_started', 'phase_complete', 'deadline_passed', 'game_ended', 'topic_picked'));

create function private.enqueue_topic_picked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.topic is null or new.topic is not distinct from old.topic or new.left_at is not null then
    return null;
  end if;
  insert into dispatch.events (room_id, kind, payload, traceparent)
  values (
    new.room_id, 'topic_picked', jsonb_build_object('member_id', new.id, 'topic', new.topic),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'traceparent'
  );
  perform pg_notify('dispatch_events', new.room_id::text);
  return null;
end;
$$;
revoke all on function private.enqueue_topic_picked() from public, anon, authenticated;

create trigger room_members_enqueue_topic_picked
  after update of topic on public.room_members
  for each row execute function private.enqueue_topic_picked();

-- How many verified questions a topic has for this room's rating and region, by kind. Counts only.
create function agents_api.quiz_coverage(p_room_id uuid, p_topic text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(kind, n), '{}')
  from (
    select b.kind, count(*) as n
    from content.quiz_bank b join public.rooms r on r.id = p_room_id
    where b.status = 'verified' and b.topic = lower(btrim(p_topic)) and b.rating <= r.age_rating
    group by b.kind
  ) t;
$$;

-- One verified, generated question into the bank. The checks the generator ran are run again where they can be:
-- its shape, an English Wikipedia source, and a quote of real length. A question already in the bank is skipped.
create function agents_api.save_quiz_question(
  p_topic text, p_kind text, p_difficulty smallint, p_rating public.age_rating, p_prompt text, p_options jsonb,
  p_answer jsonb, p_unit text, p_source_url text, p_source_quote text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_kind not in ('choice', 'true_false', 'estimate') then
    raise exception 'Generated questions are multiple choice, true or false, or estimates.' using errcode = '22023';
  end if;
  if p_source_url !~ '^https://en\.wikipedia\.org/wiki/[^\s?#]+$' then
    raise exception 'A generated question''s source is an English Wikipedia article.' using errcode = '22023';
  end if;
  insert into content.quiz_bank (topic, kind, difficulty, rating, prompt, options, answer, unit, source_url,
                                 source_quote, origin)
  values (lower(btrim(p_topic)), p_kind, p_difficulty, p_rating, btrim(p_prompt), p_options, p_answer,
          nullif(btrim(coalesce(p_unit, '')), ''), p_source_url, btrim(p_source_quote), 'generated')
  on conflict do nothing
  returning id into v_id;
  return v_id;  -- null: already in the bank
end;
$$;

revoke all on function agents_api.quiz_coverage(uuid, text) from public;
revoke all on function agents_api.save_quiz_question(text, text, smallint, public.age_rating, text, jsonb, jsonb, text,
                                                     text, text) from public;
grant execute on function agents_api.quiz_coverage(uuid, text) to agents_svc;
grant execute on function agents_api.save_quiz_question(text, text, smallint, public.age_rating, text, jsonb, jsonb,
                                                        text, text, text) to agents_svc;
