"""Starting agent runs on the Agent Server: one thread per room, runs queued in order."""

from typing import Any, Protocol

from langgraph_sdk import get_client
from opentelemetry.trace import SpanKind

from gamenight_dispatcher.outbox import Event, run_input, run_metadata
from gamenight_dispatcher.telemetry import current_traceparent, tracer


class Agents(Protocol):
    async def start_run(self, room_id: str, events: list[Event]) -> None: ...


class AgentServer:
    def __init__(self, url: str, assistant_id: str = "supervisor", headers: dict[str, str] | None = None):
        self._client = get_client(url=url, headers=headers)
        self._assistant_id = assistant_id

    async def start_run(self, room_id: str, events: list[Event]) -> None:
        # thread_id = room id; if_not_exists creates the room's thread on its first event. "enqueue"
        # queues runs on the same thread, so one room's decisions never race each other.
        # A CLIENT span for the call, whose context the agents' run continues: dispatcher → agents.
        with tracer().start_as_current_span("runs.create", kind=SpanKind.CLIENT):
            run: dict[str, Any] = await self._client.runs.create(
                room_id,
                self._assistant_id,
                input=run_input(room_id, events),
                metadata=run_metadata(room_id, events, current_traceparent()),
                multitask_strategy="enqueue",
                if_not_exists="create",
            )
        if not run.get("run_id"):
            raise RuntimeError(f"Agent Server did not accept the run for room {room_id}")
