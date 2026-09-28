"""The room supervisor graph.

Slice 0 stub: a router plus a placeholder host node, with no model calls. It exists to
prove the self-hosted Agent Server builds, persists threads and runs graphs. Slice 2
replaces the placeholder with the host agent and adds game-master handoffs.
"""

from __future__ import annotations

from typing import Literal

from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph


class RoomState(MessagesState):
    room_id: str | None
    event: dict | None


def route(state: RoomState) -> Literal["host", "game_event"]:
    return "game_event" if state.get("event") else "host"


def host(state: RoomState) -> dict:
    return {"messages": [AIMessage("The host agent arrives in slice 2. The Agent Server is working.")]}


def game_event(state: RoomState) -> dict:
    event = state.get("event") or {}
    return {"messages": [AIMessage(f"Received game event: {event.get('type', 'unknown')}")], "event": None}


builder = StateGraph(RoomState)
builder.add_node("host", host)
builder.add_node("game_event", game_event)
builder.add_conditional_edges(START, route)
builder.add_edge("host", END)
builder.add_edge("game_event", END)
graph = builder.compile()
