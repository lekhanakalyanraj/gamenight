"""The game master graph: one thread per game (thread id = game id), readable by services only.

The dispatcher relays a game's events here. Each run reads the game in code first; if every event is stale
(the game has moved past its step), it stops without a model call. Otherwise the AI game master acts
(gamenight_agents.game_master), or the scripted rules do (GAMENIGHT_MODEL=fake, or once the game has used its
model budget). Host chat never runs here, and nothing here streams to a phone.
"""

from __future__ import annotations

import random
from operator import add
from typing import Annotated, Any, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from gamenight_agents import game_master, game_rules, games
from gamenight_agents.settings import model_provider
from gamenight_agents.telemetry import GenAITracer, run_span
from gamenight_agents.turn import Turn, current

# Model calls a game may use; after that the scripted rules finish it, so a runaway loop can't run up cost.
GAME_MODEL_BUDGET = 100


class GameState(TypedDict, total=False):
    kind: str
    game_id: str
    room_id: str
    events: list[dict[str, Any]] | None
    # Running totals for this game, read by the simulator and the evals.
    runs: Annotated[int, add]
    stale_runs: Annotated[int, add]
    model_calls: Annotated[int, add]
    refused: Annotated[int, add]
    lines_rejected: Annotated[int, add]


def live_events(events: list[dict[str, Any]], step: int) -> list[dict[str, Any]]:
    """Events the game hasn't moved past: a duplicate or late event is dropped here, before any model call."""
    return [e for e in events if (e.get("payload") or {}).get("step", 0) >= step]


async def run_game_master(state: GameState, config: RunnableConfig) -> dict:
    game_id = state["game_id"]
    events = state.get("events") or []
    with run_span("agents.game_master", config, room_id=state.get("room_id"), game_id=game_id, events=len(events)):
        live = live_events(events, (await games.state(game_id))["game"]["step"])
        if not live:
            return {"events": None, "runs": 1, "stale_runs": 1}
        turn = Turn(game_id, live[-1]["id"], live, random.Random(live[-1]["id"]), callbacks=[GenAITracer()])
        token = current.set(turn)
        try:
            if model_provider() == "fake" or state.get("model_calls", 0) >= GAME_MODEL_BUDGET:
                await game_rules.play(turn)
            else:
                await game_master.play(turn, config)
        finally:
            current.reset(token)
    return {"events": None, "runs": 1, "model_calls": turn.model_calls, "refused": turn.refused,
            "lines_rejected": turn.lines_rejected}


builder = StateGraph(GameState)
builder.add_node("game_master", run_game_master)
builder.add_edge(START, "game_master")
builder.add_edge("game_master", END)
graph = builder.compile()
