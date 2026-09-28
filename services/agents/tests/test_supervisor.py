import asyncio

import pytest

from gamenight_agents import db
from gamenight_agents.graphs import supervisor
from gamenight_agents.graphs.supervisor import graph, route
from gamenight_agents.models import FAKE_WELCOME


@pytest.fixture(autouse=True)
def fake_model(monkeypatch):
    monkeypatch.setenv("GAMENIGHT_MODEL", "fake")


@pytest.fixture
def fake_db(monkeypatch):
    said: list[tuple] = []

    async def room_snapshot(room_id):
        return {"status": "lobby", "age_rating": "family", "players": []}

    async def host_say(room_id, text, kind, event_id=None):
        said.append((room_id, text, kind, event_id))
        return {"text": text}

    monkeypatch.setattr(db, "room_snapshot", room_snapshot)
    monkeypatch.setattr(db, "host_say", host_say)
    return said


def join(event_id, nickname):
    return {"id": event_id, "kind": "member_joined", "payload": {"nickname": nickname}}


def test_events_go_to_the_lobby_and_everything_else_to_host_chat():
    assert route({"kind": "event"}) == "lobby"
    assert route({"messages": []}) == "host_chat"


def test_a_batch_of_joins_becomes_one_welcome_line_keyed_by_its_first_event(fake_db):
    events = [join("e1", "Asha"), join("e2", "Ben")]
    result = asyncio.run(graph.ainvoke({"kind": "event", "room_id": "r1", "events": events, "messages": []}))
    assert fake_db == [("r1", FAKE_WELCOME, "welcome", "e1")]
    assert result["events"] is None
    assert result["messages"] == []  # events never leak into host chat


def test_no_welcome_once_the_room_is_playing(fake_db, monkeypatch):
    async def playing(room_id):
        return {"status": "playing", "age_rating": "family"}

    monkeypatch.setattr(db, "room_snapshot", playing)
    asyncio.run(graph.ainvoke({"kind": "event", "room_id": "r1", "events": [join("e1", "Asha")], "messages": []}))
    assert fake_db == []


def test_host_chat_is_a_placeholder_until_the_host_agent_lands():
    result = asyncio.run(supervisor.graph.ainvoke({"messages": [("user", "hi")]}))
    assert "PR 2b" in result["messages"][-1].content
