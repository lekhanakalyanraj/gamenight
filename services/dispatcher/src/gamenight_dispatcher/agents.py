"""Starting agent runs on the Agent Server: one thread per room (lobby and host chat) and one per game (the game
master), runs queued in order on each."""

from typing import Any, Protocol

from langgraph_sdk import get_client
from opentelemetry.trace import SpanKind

from gamenight_dispatcher.outbox import Event, Route, run_input, run_metadata
from gamenight_dispatcher.telemetry import current_traceparent, tracer


class Agents(Protocol):
    async def start_run(self, where: Route, events: list[Event]) -> None: ...


class AgentServer:
    def __init__(self, url: str, headers: dict[str, str] | None = None):
        self._client = get_client(url=url, headers=headers)

    async def start_run(self, where: Route, events: list[Event]) -> None:
        # if_not_exists creates the thread on its first event. "enqueue" queues runs on the same thread, so
        # one room's (or one game's) decisions never race each other.
        # A CLIENT span for the call, whose context the agents' run continues: dispatcher → agents.
        with tracer().start_as_current_span("runs.create", kind=SpanKind.CLIENT):
            run: dict[str, Any] = await self._client.runs.create(
                where.thread_id,
                where.assistant,
                input=run_input(where, events),
                metadata=run_metadata(where, events, current_traceparent()),
                multitask_strategy="enqueue",
                if_not_exists="create",
            )
        if not run.get("run_id"):
            raise RuntimeError(f"Agent Server did not accept the run on thread {where.thread_id}")
