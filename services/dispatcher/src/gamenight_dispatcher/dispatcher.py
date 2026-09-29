"""The dispatch loop (wake on NOTIFY or every few seconds, wait briefly so joins batch up, dispatch) and the
game timers."""

import asyncio
import contextlib
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
    group_by_thread,
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
                for where, events in group_by_thread([Event(*row) for row in rows]).items():
                    ids = [e.id for e in events]
                    # Continue the trace of the request that caused the event (e.g. the player's join).
                    with tracer().start_as_current_span(
                        "dispatch.room",
                        context=parent_context(origin_traceparent(events)),
                        kind=SpanKind.SERVER,  # serves the request that wrote the event: web → dispatcher
                        attributes={"gamenight.room_id": where.room_id, "gamenight.agent": where.assistant,
                                    "gamenight.events": len(events)},
                    ) as span:
                        try:
                            await agents.start_run(where, events)
                        except Exception as error:  # the Agent Server is down, slow or refusing: retry later
                            log.warning("%s %s: %d events not dispatched: %s", where.assistant, where.thread_id,
                                        len(ids), error)
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
            woken_by = [n.payload async for n in listener.notifies(timeout=poll_seconds, stop_after=1)]
            # Players often join together, so a moment's wait makes five joins one welcome. A game event can't
            # wait: the room is looking at the TV for what happens next.
            if not stop.is_set() and not any(p.startswith("game:") for p in woken_by):
                await asyncio.sleep(batch_window)


async def fire_deadlines(database_url: str, stop: asyncio.Event, every: float = 1.0) -> None:
    """About once a second, fire expired game deadlines. The database does the work: a clue turn that ran
    out moves to the next speaker, and a phase that ran out becomes a deadline_passed event."""
    while not stop.is_set():
        try:
            async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as conn:
                while not stop.is_set():
                    fired = (await (await conn.execute("select dispatch.fire_due_deadlines()")).fetchone())[0]
                    if fired:
                        log.info("fired %d deadlines", fired)
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(stop.wait(), every)
        except psycopg.Error as error:
            log.error("firing deadlines failed, will retry: %s", error)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), every)
