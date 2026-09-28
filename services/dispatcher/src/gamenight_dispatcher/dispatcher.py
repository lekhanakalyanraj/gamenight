"""The dispatch loop: wake on NOTIFY (or every few seconds), wait briefly so joins batch up, dispatch."""

import asyncio
import logging

import psycopg
from opentelemetry.trace import SpanKind

from gamenight_dispatcher.agents import Agents
from gamenight_dispatcher.outbox import (
    CLAIM,
    MARK_DISPATCHED,
    MARK_FAILED,
    MAX_ATTEMPTS,
    Event,
    group_by_room,
    origin_traceparent,
)
from gamenight_dispatcher.telemetry import instruments, parent_context, tracer

log = logging.getLogger("gamenight.dispatcher")


async def dispatch_due(database_url: str, agents: Agents, batch_size: int = 50) -> int:
    """Dispatch everything that's due. Returns how many events were handed to the agents."""
    handed_over = 0
    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        while True:
            async with conn.transaction():
                rows = await (await conn.execute(CLAIM, (batch_size,))).fetchall()
                if not rows:
                    return handed_over
                for room_id, events in group_by_room([Event(*row) for row in rows]).items():
                    ids = [e.id for e in events]
                    # Continue the trace of the request that caused the event (e.g. the player's join).
                    with tracer().start_as_current_span(
                        "dispatch.room",
                        context=parent_context(origin_traceparent(events)),
                        kind=SpanKind.SERVER,  # serves the request that wrote the event: web → dispatcher
                        attributes={"gamenight.room_id": room_id, "gamenight.events": len(events)},
                    ) as span:
                        try:
                            await agents.start_run(room_id, events)
                        except Exception as error:  # the Agent Server is down, slow or refusing: retry later
                            log.warning("room %s: %d events not dispatched: %s", room_id, len(ids), error)
                            span.record_exception(error)
                            await conn.execute(MARK_FAILED, (str(error), MAX_ATTEMPTS, ids))
                            instruments()["failed"].add(len(ids))
                        else:
                            await conn.execute(MARK_DISPATCHED, (ids,))
                            handed_over += len(ids)
                            instruments()["dispatched"].add(len(ids))
                            for event in events:
                                instruments()["lag"].record(event.waited_ms, {"gamenight.event.kind": event.kind})
            if len(rows) < batch_size:
                return handed_over


async def run(database_url: str, agents: Agents, stop: asyncio.Event, poll_seconds: float = 5.0,
              batch_window: float = 2.0) -> None:
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as listener:
        await listener.execute("listen dispatch_events")
        log.info("listening for events")
        while not stop.is_set():
            try:
                count = await dispatch_due(database_url, agents)
                if count:
                    log.info("dispatched %d events", count)
            except psycopg.Error as error:
                log.error("dispatch failed, will retry: %s", error)
            async for _ in listener.notifies(timeout=poll_seconds, stop_after=1):
                pass
            if not stop.is_set():
                await asyncio.sleep(batch_window)  # players often join together: one welcome, not five
