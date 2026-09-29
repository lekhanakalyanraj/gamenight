"""The outbox side of the dispatcher: claim due events, group them by room, record the outcome.

Claiming uses FOR UPDATE SKIP LOCKED inside a transaction that stays open until each room's run is
accepted, so several dispatchers can run side by side without ever handing out the same event twice.
"""

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, NamedTuple

MAX_ATTEMPTS = 5

CLAIM = """
select id::text, room_id::text, kind, payload, traceparent, attempts,
       extract(epoch from now() - created_at) * 1000 as waited_ms
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
    waited_ms: float = 0.0


class Route(NamedTuple):
    """Which agent handles an event, on which thread."""

    assistant: str
    thread_id: str
    room_id: str


def route(event: Event) -> Route:
    """Game events go to the game master on the game's own thread (services only: it holds every card);
    lobby events go to the room's supervisor, whose thread the host may read."""
    if game_id := event.payload.get("game_id"):
        return Route("game_master", game_id, event.room_id)
    return Route("supervisor", event.room_id, event.room_id)


def group_by_thread(events: list[Event]) -> "OrderedDict[Route, list[Event]]":
    """One run per thread per batch, in arrival order: several players joining become one welcome."""
    threads: OrderedDict[Route, list[Event]] = OrderedDict()
    for event in events:
        threads.setdefault(route(event), []).append(event)
    return threads


def run_input(where: Route, events: list[Event]) -> dict[str, Any]:
    relayed = [{"id": e.id, "kind": e.kind, "payload": e.payload} for e in events]
    if where.assistant == "game_master":
        return {"kind": "game_event", "game_id": where.thread_id, "room_id": where.room_id, "events": relayed}
    return {"kind": "event", "room_id": where.room_id, "events": relayed}


def origin_traceparent(events: list[Event]) -> str | None:
    """The trace of the first request in the batch that carried one (the join that caused it)."""
    return next((e.traceparent for e in events if e.traceparent), None)


def run_metadata(where: Route, events: list[Event], traceparent: str | None = None) -> dict[str, Any]:
    """traceparent: the dispatch span's own context, so the agents' spans nest under it."""
    metadata = {
        "room_id": where.room_id,
        "event_ids": [e.id for e in events],
        "traceparent": traceparent or origin_traceparent(events),
    }
    if where.assistant == "game_master":
        metadata |= {"kind": "game", "game_id": where.thread_id}
    return metadata
