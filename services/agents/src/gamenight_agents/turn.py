"""One game-master run ("turn"): the game, the event it answers, and what it did, shared by its tools.

Every database move is keyed to the event and to how many times this run has made that kind of move, so
a redelivered event replays to the same results, and two moves of one kind in a run (open discussion, then
the vote) stay distinct. The game id comes from the thread, never from the model.
"""

import random
import uuid
from collections import Counter
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Turn:
    game_id: str
    event_id: str
    events: list[dict[str, Any]]
    rng: random.Random
    picked: tuple[str, ...] = ()  # the pair's words once chosen, checked by the narrator before the deal
    lines_shown: int = 0
    lines_rejected: int = 0
    refused: int = 0  # game-master moves the database refused (the illegal-move rate)
    moved: bool = False  # the game moved on this turn (a phase opened, a vote counted), so the room expects a line
    stalls_caught: int = 0  # the turn ended with the game still waiting on the game master, so it was asked again
    model_calls: int = 0
    callbacks: list = field(default_factory=list)
    _moves: Counter = field(default_factory=Counter)

    def key(self, move: str) -> str:
        n = self._moves[move]
        self._moves[move] += 1
        return str(uuid.uuid5(uuid.UUID(self.event_id), f"{move}:{n}"))


current: ContextVar[Turn] = ContextVar("turn")
