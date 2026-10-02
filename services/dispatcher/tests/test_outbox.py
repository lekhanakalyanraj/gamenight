from gamenight_dispatcher.outbox import Event, Route, group_by_thread, run_input, run_metadata

LOBBY_A = Route("supervisor", "a", "a")


def event(id, room, name, traceparent=None):
    return Event(id, room, "member_joined", {"nickname": name}, traceparent, 0, 0.0)


def game_event(id, room, game, kind="phase_complete"):
    return Event(id, room, kind, {"game_id": game, "step": 3}, None, 0, 0.0)


def test_events_are_grouped_per_thread_in_arrival_order():
    threads = group_by_thread([event("1", "a", "Asha"), event("2", "b", "Ben"), event("3", "a", "Chen")])
    assert list(threads) == [LOBBY_A, Route("supervisor", "b", "b")]
    assert [e.id for e in threads[LOBBY_A]] == ["1", "3"]


def test_game_events_go_to_the_game_master_on_the_games_own_thread():
    threads = group_by_thread([event("1", "a", "Asha"), game_event("2", "a", "g1"), game_event("3", "a", "g1")])
    assert list(threads) == [LOBBY_A, Route("game_master", "g1", "a")]
    assert run_input(Route("game_master", "g1", "a"), threads[Route("game_master", "g1", "a")]) == {
        "kind": "game_event",
        "game_id": "g1",
        "room_id": "a",
        "events": [
            {"id": "2", "kind": "phase_complete", "payload": {"game_id": "g1", "step": 3}, "at": None},
            {"id": "3", "kind": "phase_complete", "payload": {"game_id": "g1", "step": 3}, "at": None},
        ],
    }
    # Marked as a game thread, which custom auth refuses to anyone but a service.
    assert run_metadata(Route("game_master", "g1", "a"), threads[Route("game_master", "g1", "a")])["kind"] == "game"


def test_run_input_carries_events_and_metadata_carries_the_trace():
    events = [event("1", "a", "Asha"), event("2", "a", "Ben", "00-abc-def-01")]
    assert run_input(LOBBY_A, events) == {
        "kind": "event",
        "room_id": "a",
        "events": [
            {"id": "1", "kind": "member_joined", "payload": {"nickname": "Asha"}, "at": None},
            {"id": "2", "kind": "member_joined", "payload": {"nickname": "Ben"}, "at": None},
        ],
    }
    assert run_metadata(LOBBY_A, events) == {"room_id": "a", "event_ids": ["1", "2"], "traceparent": "00-abc-def-01"}


def test_the_dispatch_span_becomes_the_agents_parent_when_there_is_one():
    events = [event("1", "a", "Asha", "00-abc-def-01")]
    assert run_metadata(LOBBY_A, events, "00-abc-123-01")["traceparent"] == "00-abc-123-01"


def test_each_event_carries_when_the_database_wrote_it():
    # The agents measure the time from an event to their move (the dashboards' "event to next phase").
    at = "2026-10-02T10:00:00.123456Z"
    written = Event("7", "a", "phase_complete", {"game_id": "g1", "step": 3}, None, 0, 0.0, at)
    assert run_input(Route("game_master", "g1", "a"), [written])["events"][0]["at"] == at


def test_the_ops_gauges_read_the_latest_counts():
    from gamenight_dispatcher import telemetry

    telemetry.OPS.update({"rooms_open": 4, "players_in_rooms": 17, "games_running": {"quiz": 2, "heads_up": 1}})
    assert [o.value for o in telemetry._observe("rooms_open")(None)] == [4]
    games = {o.attributes["gamenight.game.kind"]: o.value for o in telemetry._observe("games_running")(None)}
    assert games == {"quiz": 2, "heads_up": 1}
    assert telemetry._observe("nothing_yet")(None) == []
