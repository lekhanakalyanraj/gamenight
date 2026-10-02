"""The room supervisor graph: one thread per room, and a code router in front of the agents.

- input kind "event": database events relayed by the dispatcher (for now, players joining),
  handled by the lobby handler, which posts a welcome line to the TV;
- anything else: host chat with the host agent (gamenight_agents.host), streamed to the host's phone.

The agents write to the game only through agents_api (see gamenight_agents.db).
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import merge_configs
from langgraph.graph import END, START, MessagesState, StateGraph

from gamenight_agents import db, headsup_content, quiz_content
from gamenight_agents.host import host_agent
from gamenight_agents.lobby import joined_names, welcome_line
from gamenight_agents.models import host_model
from gamenight_agents.settings import model_provider
from gamenight_agents.telemetry import GenAITracer, run_span

log = logging.getLogger("gamenight.agents.lobby")


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
        # Players picking quiz topics: top up the question bank for them now, so the quiz never waits at the start.
        topics = picked_topics(events)
        if room_id and topics and model_provider() != "fake":
            snapshot = await db.room_snapshot(room_id) or {}
            if snapshot.get("status") == "lobby":
                for topic in topics:
                    result = await quiz_content.top_up(room_id, topic, snapshot.get("age_rating", "family"),
                                                       callbacks=[GenAITracer()])
                    log.info("quiz bank for %r: %s", topic, result)
        # Players picking Heads Up interests: build cards for them now, so the deck leans their way at the start.
        interests = picked_interests(events)
        if room_id and interests and model_provider() != "fake":
            snapshot = await db.room_snapshot(room_id) or {}
            if snapshot.get("status") == "lobby":
                for interest in interests:
                    result = await headsup_content.top_up(room_id, interest, snapshot.get("age_rating", "family"),
                                                          callbacks=[GenAITracer()])
                    log.info("Heads Up cards for %r: %s", interest, result)
    return {"events": None, "kind": None}


def picked_topics(events: list[dict[str, Any]], at_most: int = 3) -> list[str]:
    """The distinct topics picked in this batch (as the bank files them), a few at a time."""
    seen: list[str] = []
    for event in events:
        topic = quiz_content.topic_key((event.get("payload") or {}).get("topic")) \
            if event.get("kind") == "topic_picked" else None
        if topic and topic not in seen:
            seen.append(topic)
    return seen[:at_most]


def picked_interests(events: list[dict[str, Any]], at_most: int = 3) -> list[str]:
    """The distinct Heads Up interests picked in this batch (by the bank's key), a few at a time, latest first."""
    seen: dict[str, str] = {}
    for event in reversed(events):
        if event.get("kind") != "interests_picked":
            continue
        for interest in (event.get("payload") or {}).get("interests") or []:
            key = quiz_content.topic_key(interest)
            if key and key not in seen:
                seen[key] = interest
    return list(seen.values())[:at_most]


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
