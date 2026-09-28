"""The outbox side of the dispatcher: claim due events, group them by room, record the outcome.

Claiming uses FOR UPDATE SKIP LOCKED inside a transaction that stays open until each room's run is
accepted, so several dispatchers can run side by side without ever handing out the same event twice.
"""

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

MAX_ATTEMPTS = 5

CLAIM = """
select id::text, room_id::text, kind, payload, traceparent, attempts,
       extract(epoch from now() - created_at) * 1000 as waited_ms
from dispatch.events
where dispatched_at is null and failed_at is null and next_attempt_at <= now()
  and kind = 'member_joined'  -- game events stay queued until the game master can take them
order by created_at
limit %s
for update skip locked
"""

MARK_DISPATCHED = """
update dispatch.events set dispatched_at = now(), attempts = attempts + 1, last_error = null
where id = any(%s::uuid[])
"""

# Exponential backoff (2, 4, 8, 16 s ...), then dead-lettered: failed_at is set and it stops retrying.
MARK_FAILED = """
update dispatch.events
set attempts = attempts + 1,
    last_error = left(%s, 500),
    next_attempt_at = now() + make_interval(secs => least(power(2, attempts + 1), 60)),
    failed_at = case when attempts + 1 >= %s then now() end
where id = any(%s::uuid[])
"""


@dataclass(frozen=True)
class Event:
    id: str
    room_id: str
    kind: str
    payload: dict[str, Any]
    traceparent: str | None
    attempts: int
    waited_ms: float = 0.0


def group_by_room(events: list[Event]) -> "OrderedDict[str, list[Event]]":
    """One run per room per batch, in arrival order: several players joining become one welcome."""
    rooms: OrderedDict[str, list[Event]] = OrderedDict()
    for event in events:
        rooms.setdefault(event.room_id, []).append(event)
    return rooms


def run_input(room_id: str, events: list[Event]) -> dict[str, Any]:
    return {
        "kind": "event",
        "room_id": room_id,
        "events": [{"id": e.id, "kind": e.kind, "payload": e.payload} for e in events],
    }


def origin_traceparent(events: list[Event]) -> str | None:
    """The trace of the first request in the batch that carried one (the join that caused it)."""
    return next((e.traceparent for e in events if e.traceparent), None)


def run_metadata(room_id: str, events: list[Event], traceparent: str | None = None) -> dict[str, Any]:
    """traceparent: the dispatch span's own context, so the agents' spans nest under it."""
    return {
        "room_id": room_id,
        "event_ids": [e.id for e in events],
        "traceparent": traceparent or origin_traceparent(events),
    }
