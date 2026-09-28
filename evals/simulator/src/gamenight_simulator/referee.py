"""A scripted game master. It plays the game master's part with fixed rules instead of a model, through the
same game_api calls the AI game master uses, so the simulator can test the engine, the rules and every
leak surface without a model.

Along the way it checks two promises the database makes to the game master:
- a repeated event id applies once: now and then it sends a call twice and compares the results;
- illegal moves are refused: now and then it tries one and expects an error.
"""

import asyncio
import random
import uuid
from typing import Any

import psycopg

SETUP = """select game_api.gm_setup(%(game)s::uuid, %(pair)s::uuid, %(undercovers)s, %(mr_whites)s, %(turn_seconds)s,
                                    %(event_id)s::uuid)"""
DEAL = "select game_api.gm_deal(%(game)s::uuid, %(event_id)s::uuid)"
OPEN = """select game_api.gm_open_phase(%(game)s::uuid, %(phase)s::public.game_phase, %(seconds)s, %(event_id)s::uuid,
                                         %(order)s::uuid[], %(candidates)s::uuid[])"""
RESOLVE = "select game_api.gm_resolve_vote(%(game)s::uuid, %(event_id)s::uuid)"
JUDGE = "select game_api.gm_judge(%(game)s::uuid, %(verdict)s, %(reasoning)s, %(event_id)s::uuid)"

PACE = 0.1  # see game.PACE
REPLAY_RATE = 0.1
PROBE_RATE = 0.05


def legal_mix(players: int, rng: random.Random) -> tuple[int, int]:
    """A random role mix the database accepts: (undercovers, Mr. Whites)."""
    max_whites = 2 if players >= 10 else 1 if players >= 5 else 0
    while True:
        whites = rng.randint(0, max_whites)
        undercovers = rng.randint(1, max(1, players // 3))
        if players - undercovers - whites > undercovers + whites:
            return undercovers, whites


def same_word(guess: str | None, word: str) -> bool:
    """The scripted judge: right if it's the word, ignoring case, spacing and a plural."""

    def norm(text: str) -> str:
        return " ".join(text.lower().split()).removesuffix("s")

    return guess is not None and norm(guess) == norm(word)


class RefereeError(Exception):
    """The database refused a move the referee believed was legal, or broke a promise (see the module)."""


class Referee:
    def __init__(self, conn: psycopg.AsyncConnection, rng: random.Random, turn_seconds: int = 20):
        self.conn, self.rng, self.turn_seconds = conn, rng, turn_seconds
        self.moves = 0
        self.replays = 0
        self.illegal_refused = 0

    async def _fetch(self, sql: str, args: dict[str, Any]) -> Any:
        return (await (await self.conn.execute(sql, args)).fetchone())[0]

    async def state(self, game_id: str) -> dict[str, Any]:
        return await self._fetch("select game_api.get_game_state(%(game)s::uuid)", {"game": game_id})

    async def _gm(self, sql: str, **args: Any) -> Any:
        """A mutating call with a fresh event id; sometimes sent twice, to check it applies only once."""
        args["event_id"] = str(uuid.uuid4())
        try:
            result = await self._fetch(sql, args)
        except psycopg.Error as error:
            raise RefereeError(f"the database refused a legal move: {error}") from error
        await asyncio.sleep(PACE)
        if self.rng.random() < REPLAY_RATE:
            if await self._fetch(sql, args) != result:
                raise RefereeError(f"replaying event {args['event_id']} gave a different result")
            self.replays += 1
        self.moves += 1
        return result

    async def _probe(self, sql: str, **args: Any) -> None:
        """An illegal move, which the database must refuse."""
        args["event_id"] = str(uuid.uuid4())
        try:
            await self._fetch(sql, args)
        except psycopg.Error:
            self.illegal_refused += 1
            return
        raise RefereeError(f"the database accepted an illegal move: {args}")

    async def act(self, game_id: str) -> bool:
        """Makes the game master's next move, if it has one. Returns whether it did something."""
        s = await self.state(game_id)
        g = s["game"]
        if g["phase"] == "ended" or g["paused"]:
            return False
        alive = [p["member_id"] for p in s["players"] if p["alive"]]
        rng = self.rng

        match g["phase"]:
            case "setup":
                if s["words"] is None:
                    pairs = await self._fetch(
                        "select game_api.word_pairs(%(game)s::uuid, %(theme)s, 20)",
                        {"game": game_id, "theme": g["settings"].get("theme")},
                    ) or await self._fetch("select game_api.word_pairs(%(game)s::uuid, null, 20)", {"game": game_id})
                    undercovers, whites = legal_mix(len(s["players"]), rng)
                    await self._gm(SETUP, game=game_id, pair=rng.choice(pairs)["id"], undercovers=undercovers,
                                   mr_whites=whites, turn_seconds=self.turn_seconds)
                    await self._gm(DEAL, game=game_id)
                else:
                    order = rng.sample(alive, len(alive))
                    await self._gm(OPEN, game=game_id, phase="clues", seconds=None, order=order, candidates=None)
                return True

            case "clues":
                if g["turn_index"] is not None:
                    if rng.random() < PROBE_RATE:
                        await self._probe(OPEN, game=game_id, phase="vote", seconds=30, order=None, candidates=None)
                    return False  # the speakers' turn
                await self._gm(OPEN, game=game_id, phase="discussion", seconds=30, order=None, candidates=None)
                return True

            case "discussion":  # the game master may close discussion early; the bots don't need it
                await self._gm(OPEN, game=game_id, phase="vote", seconds=rng.randint(20, 40), order=None,
                               candidates=None)
                return True

            case "vote" if not g["resolved"]:
                # No deadline left means everyone voted, the timer ran out or the host skipped: count.
                if g["phase_deadline"] is not None:
                    return False
                await self._gm(RESOLVE, game=game_id)
                return True

            case "vote":
                last = s["results"][-1]
                tied = last.get("tied") or []
                if last["tie"] and not g["revoted"] and len(tied) >= 2 and rng.random() < 0.6:
                    await self._gm(OPEN, game=game_id, phase="vote", seconds=30, order=None, candidates=tied)
                else:
                    order = rng.choice([None, rng.sample(alive, len(alive))])
                    await self._gm(OPEN, game=game_id, phase="clues", seconds=None, order=order, candidates=None)
                return True

            case "guess" if g["judgement"] is None:
                if g["phase_deadline"] is not None:
                    return False  # Mr. White is still thinking
                verdict = same_word(s["guess"], s["words"]["civilian"])
                reasoning = "That's the civilians' word." if verdict else "Not the civilians' word."
                await self._gm(JUDGE, game=game_id, verdict=verdict, reasoning=reasoning)
                return True

            case "guess" if g["resolved"]:  # a wrong guess, and nobody has won: the next round
                await self._gm(OPEN, game=game_id, phase="clues", seconds=None, order=None, candidates=None)
                return True

        return False  # the verdict is waiting for the host or its 10 seconds
