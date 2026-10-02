-- Heads Up, slice 6b: decks built by the AI from the players' interests, and moments for the commentator.
--
--   interests_picked: a new outbox event, to the room's agent (the lobby): it tops up the card bank for those
--                     interests in the background, so the deck is ready when the game starts
--   streak:           a new outbox event, to the game master: the guesser got 3, 5 or 8 in a row
--   agents_api.headsup_coverage: how many usable cards an interest has (a count only, never a card)
--   agents_api.save_headsup_card: saves one reviewed card (checked again here: topic, length, characters)

alter table dispatch.events drop constraint events_kind_check;
alter table dispatch.events add constraint events_kind_check
  check (kind in ('member_joined', 'game_started', 'phase_complete', 'deadline_passed', 'game_ended', 'topic_picked',
                  'interests_picked', 'streak'));

create function private.enqueue_interests_picked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only a real change: the same interests in another case are the same interests.
  if new.interests is null or new.left_at is not null
     or (select array_agg(lower(i) order by lower(i)) from unnest(new.interests) i)
        is not distinct from (select array_agg(lower(i) order by lower(i)) from unnest(old.interests) i) then
    return null;
  end if;
  insert into dispatch.events (room_id, kind, payload, traceparent)
  values (
    new.room_id, 'interests_picked', jsonb_build_object('member_id', new.id, 'interests', to_jsonb(new.interests)),
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'traceparent'
  );
  perform pg_notify('dispatch_events', new.room_id::text);
  return null;
end;
$$;
revoke all on function private.enqueue_interests_picked() from public, anon, authenticated;

create trigger room_members_enqueue_interests_picked
  after update of interests on public.room_members
  for each row execute function private.enqueue_interests_picked();

-- How many verified cards an interest has for this room's rating and region. A count only.
create function agents_api.headsup_coverage(p_room_id uuid, p_topic text)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
  from content.headsup_cards c join public.rooms r on r.id = p_room_id
  where c.status = 'verified' and c.topic = lower(btrim(p_topic)) and c.rating <= r.age_rating;
$$;

-- One reviewed, generated card into the bank. A card already in the bank (any case) is skipped.
create function agents_api.save_headsup_card(p_topic text, p_card text, p_rating public.age_rating)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_card text := btrim(regexp_replace(coalesce(p_card, ''), '\s+', ' ', 'g'));
begin
  if v_card !~ '^[[:alpha:][:digit:]][[:alpha:][:digit:] &''.,!?:-]{1,39}$' then
    raise exception 'A card is 2 to 40 letters, numbers, spaces or simple punctuation.' using errcode = '22023';
  end if;
  insert into content.headsup_cards (topic, card, rating, origin)
  values (lower(btrim(p_topic)), v_card, p_rating, 'generated')
  on conflict do nothing
  returning id into v_id;
  return v_id;  -- null: already in the bank
end;
$$;

revoke all on function agents_api.headsup_coverage(uuid, text) from public;
revoke all on function agents_api.save_headsup_card(text, text, public.age_rating) from public;
grant execute on function agents_api.headsup_coverage(uuid, text) to agents_svc;
grant execute on function agents_api.save_headsup_card(text, text, public.age_rating) to agents_svc;

-- Got it now tells the game master about a streak (otherwise as in 6a).
create or replace function public.headsup_move(p_game_id uuid, p_result text, p_card_no int, p_action_id uuid)
returns public.headsup_turns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_game public.games;
  v_turn public.headsup_turns;
  v_position int;
  v_is_host boolean;
  v_streak int;
begin
  if p_action_id is null or p_result not in ('got', 'pass') then
    raise exception 'A move is Got it or Pass, with its id.' using errcode = '22023';
  end if;
  if exists (select 1 from private.headsup_moves where action_id = p_action_id) then
    select * into v_turn from public.headsup_turns t
    where t.game_id = p_game_id and t.number = (select turn from private.headsup_moves where action_id = p_action_id);
    return v_turn;  -- a retry: counted already
  end if;

  select * into v_game from public.games where id = p_game_id for update;
  if not found or v_game.kind <> 'heads_up' then
    raise exception 'That''s not a game of Heads Up.' using errcode = '22023';
  end if;
  v_turn := private.headsup_turn(p_game_id);
  v_is_host := exists (select 1 from public.rooms where id = v_game.room_id and host_id = (select auth.uid()));
  if not v_is_host and not exists (select 1 from public.room_members m
                                   where m.id = v_turn.member_id and m.user_id = (select auth.uid()) and m.left_at is null) then
    raise exception 'Only this turn''s guesser (or the host) can say Got it or Pass.' using errcode = '42501';
  end if;
  if v_game.phase <> 'guessing' or v_game.paused_at is not null then
    raise exception 'There''s no card to answer right now.' using errcode = '55000';
  end if;
  if p_card_no is distinct from v_turn.shown then
    raise exception 'That card has already moved on.' using errcode = '55000';
  end if;

  select position into v_position from private.headsup_live where game_id = p_game_id;
  update private.headsup_deck set result = p_result where game_id = p_game_id and position = v_position;
  insert into private.headsup_moves (action_id, game_id, turn, card_no, result, by_user)
  values (p_action_id, p_game_id, v_turn.number, p_card_no, p_result, (select auth.uid()));
  update public.headsup_turns
  set got = got + (p_result = 'got')::int, passed = passed + (p_result = 'pass')::int
  where game_id = p_game_id and number = v_turn.number;
  -- A run of Got it: tell the game master at 3, 5 and 8 in a row (the commentator's moment). The step is unchanged
  -- during a turn, so these are live events for it.
  if p_result = 'got' then
    select count(*) into v_streak from (
      select sum(case when d.result = 'got' then 0 else 1 end) over (order by d.position desc) as breaks
      from private.headsup_deck d where d.game_id = p_game_id and d.turn = v_turn.number and d.result is not null
    ) t where t.breaks = 0;
    if v_streak in (3, 5, 8) then
      perform private.emit_game_event(v_game, 'streak', jsonb_build_object(
        'turn', v_turn.number, 'guesser', v_turn.member_id, 'streak', v_streak, 'got', v_turn.got + 1));
    end if;
  end if;
  perform private.headsup_next_card(p_game_id);
  return private.headsup_turn(p_game_id);
end;
$$;

