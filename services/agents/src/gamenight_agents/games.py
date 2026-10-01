"""The game master's only way into a game: game_api, called as game_master_svc with bound parameters.

A move the rules don't allow comes back as Refused, with the database's SQLSTATE and reason (55000: not
now; 22023: bad arguments), so the agent can read why and try something legal.
"""

from typing import Any

import psycopg

from gamenight_agents.settings import game_master_database_url


class Refused(Exception):
    def __init__(self, code: str, reason: str):
        super().__init__(f"{code}: {reason}")
        self.code, self.reason = code, reason


async def _call(sql: str, params: dict[str, Any]) -> Any:
    try:
        async with await psycopg.AsyncConnection.connect(game_master_database_url(), autocommit=True) as conn:
            row = await (await conn.execute(sql, params)).fetchone()
    except psycopg.Error as error:
        if error.sqlstate is None:  # couldn't reach the database: not the agent's mistake
            raise
        raise Refused(error.sqlstate, error.diag.message_primary or str(error)) from error
    return row[0] if row else None


async def state(game: str) -> dict[str, Any]:
    return await _call("select game_api.get_game_state(%(game)s::uuid)", {"game": game})


async def setup(game: str, pair: str, undercovers: int, mr_whites: int, turn_seconds: int, event: str) -> dict:
    return await _call(
        "select game_api.gm_setup(%(game)s::uuid, %(pair)s::uuid, %(u)s, %(w)s, %(t)s, %(event)s::uuid)",
        {"game": game, "pair": pair, "u": undercovers, "w": mr_whites, "t": turn_seconds, "event": event},
    )


async def deal(game: str, event: str) -> dict:
    return await _call("select game_api.gm_deal(%(game)s::uuid, %(event)s::uuid)", {"game": game, "event": event})


async def open_phase(game: str, phase: str, seconds: int | None, event: str, turn_order: list[str] | None = None,
                     candidates: list[str] | None = None) -> dict:
    return await _call(
        "select game_api.gm_open_phase(%(game)s::uuid, %(phase)s::public.game_phase, %(seconds)s, %(event)s::uuid, "
        "%(order)s::uuid[], %(candidates)s::uuid[])",
        {"game": game, "phase": phase, "seconds": seconds, "event": event, "order": turn_order,
         "candidates": candidates},
    )


async def resolve_vote(game: str, event: str) -> dict:
    return await _call("select game_api.gm_resolve_vote(%(game)s::uuid, %(event)s::uuid)",
                       {"game": game, "event": event})


async def judge(game: str, verdict: bool, reasoning: str, event: str) -> dict:
    return await _call(
        "select game_api.gm_judge(%(game)s::uuid, %(verdict)s, %(reasoning)s, %(event)s::uuid)",
        {"game": game, "verdict": verdict, "reasoning": reasoning, "event": event},
    )


async def word_pairs(game: str, theme: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    return await _call("select game_api.word_pairs(%(game)s::uuid, %(theme)s, %(limit)s)",
                       {"game": game, "theme": theme, "limit": limit})


async def played_tonight(game: str) -> list[list[str]]:
    return await _call("select game_api.played_tonight(%(game)s::uuid)", {"game": game})


async def save_word_pair(theme: str, rating: str, region: str | None, word_a: str, word_b: str) -> str:
    pair = await _call(
        "select game_api.save_word_pair(%(theme)s, %(rating)s::public.age_rating, %(region)s, %(a)s, %(b)s)",
        {"theme": theme, "rating": rating, "region": region, "a": word_a, "b": word_b},
    )
    return str(pair)


async def say(game: str, text: str, event: str) -> dict[str, Any]:
    return await _call("select row_to_json(l) from game_api.say(%(game)s::uuid, %(text)s, %(event)s::uuid) as l",
                       {"game": game, "text": text, "event": event})


# ---- Quiz Night ---------------------------------------------------------------------------------------------------

async def quiz_state(game: str) -> dict[str, Any]:
    return await _call("select game_api.get_quiz_state(%(game)s::uuid)", {"game": game})


async def quiz_bank(game: str, topic: str | None = None, kind: str | None = None, difficulty: int | None = None,
                    limit: int = 20) -> list[dict[str, Any]]:
    return await _call(
        "select game_api.quiz_bank(%(game)s::uuid, %(topic)s, %(kind)s, %(difficulty)s::smallint, %(limit)s)",
        {"game": game, "topic": topic, "kind": kind, "difficulty": difficulty, "limit": limit},
    )


async def ask(game: str, question: str, for_member: str | None, event: str) -> dict[str, Any]:
    return await _call(
        "select game_api.gm_ask(%(game)s::uuid, %(question)s::uuid, %(member)s::uuid, %(event)s::uuid)",
        {"game": game, "question": question, "member": for_member, "event": event},
    )


async def reveal(game: str, event: str) -> dict[str, Any]:
    return await _call("select game_api.gm_reveal(%(game)s::uuid, %(event)s::uuid)", {"game": game, "event": event})
