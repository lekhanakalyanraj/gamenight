"""The room supervisor graph: one thread per room, and a code router in front of the agents.

- input kind "event": database events relayed by the dispatcher (for now, players joining),
  handled by the lobby handler, which posts a welcome line to the TV;
- anything else: host chat, which becomes the host agent in PR 2b.

The agents write to the game only through agents_api (see gamenight_agents.db).
"""

from __future__ import annotations

from typing import Any, Literal

from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph

from gamenight_agents import db
from gamenight_agents.lobby import joined_names, welcome_line
from gamenight_agents.models import host_model


class RoomState(MessagesState):
    """messages holds host chat only; events never mix into it, so chat stays separate from game context."""

    kind: str | None
    room_id: str | None
    events: list[dict[str, Any]] | None


def route(state: RoomState) -> Literal["lobby", "host_chat"]:
    return "lobby" if state.get("kind") == "event" else "host_chat"


async def lobby(state: RoomState) -> dict:
    room_id = state.get("room_id")
    events = state.get("events") or []
    names = joined_names(events)
    if room_id and names:
        snapshot = await db.room_snapshot(room_id) or {}
        if snapshot.get("status") == "lobby":
            line = await welcome_line(host_model(), names, snapshot.get("age_rating", "family"))
            # The batch's first event id makes the line idempotent: a retried run can't post it twice.
            await db.host_say(room_id, line, "welcome", event_id=events[0]["id"])
    return {"events": None, "kind": None}


def host_chat(state: RoomState) -> dict:
    return {"messages": [AIMessage("Host chat arrives with the host agent (slice 2, PR 2b).")]}


builder = StateGraph(RoomState)
builder.add_node("lobby", lobby)
builder.add_node("host_chat", host_chat)
builder.add_conditional_edges(START, route)
builder.add_edge("lobby", END)
builder.add_edge("host_chat", END)
graph = builder.compile()
