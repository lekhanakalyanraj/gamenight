from gamenight_dispatcher.outbox import Event, group_by_room, run_input, run_metadata


def event(id, room, name, traceparent=None):
    return Event(id, room, "member_joined", {"nickname": name}, traceparent, 0)


def test_events_are_grouped_per_room_in_arrival_order():
    rooms = group_by_room([event("1", "a", "Asha"), event("2", "b", "Ben"), event("3", "a", "Chen")])
    assert list(rooms) == ["a", "b"]
    assert [e.id for e in rooms["a"]] == ["1", "3"]


def test_run_input_carries_events_and_metadata_carries_the_trace():
    events = [event("1", "a", "Asha"), event("2", "a", "Ben", "00-abc-def-01")]
    assert run_input("a", events) == {
        "kind": "event",
        "room_id": "a",
        "events": [
            {"id": "1", "kind": "member_joined", "payload": {"nickname": "Asha"}},
            {"id": "2", "kind": "member_joined", "payload": {"nickname": "Ben"}},
        ],
    }
    assert run_metadata("a", events) == {"room_id": "a", "event_ids": ["1", "2"], "traceparent": "00-abc-def-01"}
