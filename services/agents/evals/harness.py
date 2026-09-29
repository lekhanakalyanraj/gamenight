"""Run the real host agent and lobby welcome (real model) with the database and catalog replaced by fixtures.

Evals measure the model's behaviour, so they need no services: tools see a fixed room and the four games,
and anything the agent would put on the TV is captured instead of written.
"""

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from gamenight_agents import catalog, db, host
from gamenight_agents.lobby import welcome_line
from gamenight_agents.models import host_model

GAMES = [
    {"slug": "heads-up", "name": "Heads Up", "min_players": 3, "max_players": 16, "minutes": 15,
     "summary": "The guesser turns away from the TV; everyone else gives clues for the word on screen."},
    {"slug": "mafia", "name": "Mafia", "min_players": 5, "max_players": 16, "minutes": 40,
     "summary": "A spooky storyteller runs the village. Mafia strike at night; the village votes by day."},
    {"slug": "quiz-night", "name": "Quiz Night", "min_players": 3, "max_players": 16, "minutes": 25,
     "summary": "Mixed rounds on your phones, topics picked by the players, and difficulty that keeps it close."},
    {"slug": "undercover", "name": "Undercover (Mr. White)", "min_players": 3, "max_players": 16, "minutes": 20,
     "summary": "Everyone gets a word, except the undercover players and Mr. White. Clues out loud, then vote."},
]


@dataclass
class Room:
    players: list[str]
    rating: str = "family"
    tv_connected: bool = True

    def snapshot(self) -> dict[str, Any]:
        return {
            "code": "EVAL42", "status": "lobby", "age_rating": self.rating, "max_players": 16,
            "tv_connected": self.tv_connected,
            "players": [{"nickname": n, "role": "host" if i == 0 else "player"} for i, n in enumerate(self.players)],
        }


@dataclass
class Result:
    reply: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    announced: list[str] = field(default_factory=list)


# The case being run. Each asyncio task has its own copy of the context, so cases running concurrently
# never see each other's room (module-level monkeypatching per case would race).
_case: ContextVar[tuple[Room, list[str]]] = ContextVar("eval_case")


async def _room_snapshot(room_id: str) -> dict[str, Any]:
    return _case.get()[0].snapshot()


async def _host_say(room_id: str, text: str, kind: str, event_id: str | None = None) -> dict[str, Any]:
    _case.get()[1].append(text)
    return {"text": text}


async def _start_game(room_id: str, host_id: str, settings: dict[str, Any]) -> dict[str, Any]:
    return {"id": "eval-game", "phase": "setup", "settings": settings}  # the tool call itself is what's scored


async def _list_games(players: int | None = None, minutes: int | None = None) -> list[dict[str, Any]]:
    return [g for g in GAMES if (not players or g["min_players"] <= players <= g["max_players"])
            and (not minutes or g["minutes"] <= minutes)]


@contextmanager
def offline(room: Room, announced: list[str]):
    """Point the agents' database and catalog calls at this case's fixtures (installed once, read per task)."""
    db.room_snapshot, db.host_say, db.start_game = _room_snapshot, _host_say, _start_game
    catalog.list_games = _list_games
    token = _case.set((room, announced))
    try:
        yield
    finally:
        _case.reset(token)


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return "".join(part.get("text", "") for part in content if isinstance(part, dict))


async def host_chat(question: str, room: Room) -> Result:
    announced: list[str] = []
    with offline(room, announced):
        config = {"configurable": {"thread_id": str(uuid.uuid4())}}
        state = await host.host_agent().ainvoke({"messages": [("user", question)]}, config)
    ai = [m for m in state["messages"] if m.type == "ai"]
    calls = [{"name": c["name"], "args": c["args"]} for m in ai for c in (m.tool_calls or [])]
    return Result(reply=_text(ai[-1].content) if ai else "", tool_calls=calls, announced=announced)


async def welcome(names: list[str], rating: str = "family") -> Result:
    return Result(reply=await welcome_line(host_model(), names, rating))
