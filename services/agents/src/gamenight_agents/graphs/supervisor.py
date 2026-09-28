"""The room supervisor graph: one thread per room, and a code router in front of the agents.

- input kind "event": database events relayed by the dispatcher (for now, players joining),
  handled by the lobby handler, which posts a welcome line to the TV;
- anything else: host chat with the host agent (gamenight_agents.host), streamed to the host's phone.

The agents write to the game only through agents_api (see gamenight_agents.db).
"""

from __future__ import annotations

from typing import Any, Literal

from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import merge_configs
from langgraph.graph import END, START, MessagesState, StateGraph

from gamenight_agents import db
from gamenight_agents.host import host_agent
from gamenight_agents.lobby import joined_names, welcome_line
from gamenight_agents.models import host_model
from gamenight_agents.telemetry import GenAITracer, run_span


class RoomState(MessagesState):
    """messages holds host chat only; events never mix into it, so chat stays separate from game context."""

    kind: str | None
    room_id: str | None
    events: list[dict[str, Any]] | None


def route(state: RoomState) -> Literal["lobby", "host_chat"]:
    return "lobby" if state.get("kind") == "event" else "host_chat"


async def lobby(state: RoomState, config: RunnableConfig) -> dict:
    room_id = state.get("room_id")
    events = state.get("events") or []
    names = joined_names(events)
    with run_span("agents.lobby", config, room_id=room_id, events=len(events)):
        if room_id and names:
            snapshot = await db.room_snapshot(room_id) or {}
            if snapshot.get("status") == "lobby":
                rating = snapshot.get("age_rating", "family")
                line = await welcome_line(host_model(), names, rating, callbacks=[GenAITracer()])
                # The batch's first event id makes the line idempotent: a retried run can't post it twice.
                await db.host_say(room_id, line, "welcome", event_id=events[0]["id"])
    return {"events": None, "kind": None}


async def host_chat(state: RoomState, config: RunnableConfig) -> dict:
    """Runs the host agent on the chat so far; only its new messages are added to the room's chat."""
    history = state.get("messages") or []
    room_id = (config.get("configurable") or {}).get("thread_id")
    with run_span("agents.host_chat", config, room_id=room_id):
        traced = merge_configs(config, {"callbacks": [GenAITracer()]})
        result = await host_agent().ainvoke({"messages": history}, traced)
    return {"messages": result["messages"][len(history):]}


builder = StateGraph(RoomState)
builder.add_node("lobby", lobby)
builder.add_node("host_chat", host_chat)
builder.add_conditional_edges(START, route)
builder.add_edge("lobby", END)
builder.add_edge("host_chat", END)
graph = builder.compile()
