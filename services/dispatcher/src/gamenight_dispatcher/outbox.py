"""The outbox side of the dispatcher: claim due events, group them by room, record the outcome.

Claiming uses FOR UPDATE SKIP LOCKED inside a transaction that stays open until each room's run is
accepted, so several dispatchers can run side by side without ever handing out the same event twice.
"""

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

MAX_ATTEMPTS = 5

CLAIM = """
select id::text, room_id::text, kind, payload, traceparent, attempts
from dispatch.events
where dispatched_at is null and failed_at is null and next_attempt_at <= now()
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


def run_metadata(room_id: str, events: list[Event]) -> dict[str, Any]:
    traceparent = next((e.traceparent for e in events if e.traceparent), None)
    return {"room_id": room_id, "event_ids": [e.id for e in events], "traceparent": traceparent}
