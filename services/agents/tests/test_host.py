import asyncio
from types import SimpleNamespace

import pytest

from gamenight_agents import catalog, db, host


def runtime(thread_id="room-1", tool_call_id="call-1"):
    return SimpleNamespace(config={"configurable": {"thread_id": thread_id}}, tool_call_id=tool_call_id)


@pytest.fixture
def said(monkeypatch):
    lines = []

    async def host_say(room_id, text, kind, event_id=None):
        lines.append((room_id, text, kind, event_id))
        return {"text": text}

    monkeypatch.setattr(db, "host_say", host_say)
    return lines


def test_tools_take_the_room_from_the_thread_not_the_chat(monkeypatch):
    seen = []

    async def room_snapshot(room_id):
        seen.append(room_id)
        return {"status": "lobby"}

    monkeypatch.setattr(db, "room_snapshot", room_snapshot)
    assert asyncio.run(host.get_room.coroutine(runtime=runtime("room-42"))) == {"status": "lobby"}
    assert seen == ["room-42"]


def test_announce_is_idempotent_per_tool_call(said):
    first = asyncio.run(host.announce.coroutine("Undercover next!", runtime=runtime(tool_call_id="call-7")))
    again = asyncio.run(host.announce.coroutine("Undercover next!", runtime=runtime(tool_call_id="call-7")))
    other = asyncio.run(host.announce.coroutine("Undercover next!", runtime=runtime(tool_call_id="call-8")))
    assert first == again == other == "Shown on the TV: Undercover next!"
    assert said[0][3] == said[1][3] != said[2][3]  # same call, same event id: the database says it once
    assert said[0][:3] == ("room-1", "Undercover next!", "announce")


def test_suggest_games_asks_the_catalog(monkeypatch):
    calls = []

    async def list_games(players=None, minutes=None):
        calls.append((players, minutes))
        return [{"slug": "undercover"}]

    monkeypatch.setattr(catalog, "list_games", list_games)
    assert asyncio.run(host.suggest_games.coroutine(5, runtime=runtime(), minutes=30)) == [{"slug": "undercover"}]
    assert calls == [(5, 30)]


def test_the_host_agent_gets_exactly_these_tools_and_none_that_read_hidden_information(monkeypatch):
    monkeypatch.setenv("GAMENIGHT_MODEL", "fake")
    host.host_agent.cache_clear()
    tools = host.host_agent().nodes["tools"].bound._tools_by_name
    assert set(tools) == {"get_room", "suggest_games", "announce", "start_game"}


def test_starting_a_game_is_for_the_verified_host_of_the_threads_room(monkeypatch):
    started = []

    async def start_game(room_id, host_id, settings):
        started.append((room_id, host_id, settings))
        return {"id": "game-1"}

    monkeypatch.setattr(db, "start_game", start_game)
    verified = SimpleNamespace(config={"configurable": {"thread_id": "room-1", "langgraph_auth_user_id": "host-9"}},
                               tool_call_id="call-1")
    reply = asyncio.run(host.start_game.coroutine(runtime=verified, theme="  food  "))
    assert started == [("room-1", "host-9", {"theme": "food"})]  # the room and host come from the server, not chat
    assert "started" in reply
