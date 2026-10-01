"""The agents' only way into the game database: agents_api, called as agents_svc with bound parameters."""

import json
from typing import Any

import psycopg

from gamenight_agents.settings import database_url


async def room_snapshot(room_id: str) -> dict[str, Any] | None:
    async with await psycopg.AsyncConnection.connect(database_url(), autocommit=True) as conn:
        cur = await conn.execute("select agents_api.room_snapshot(%s)", (room_id,))
        row = await cur.fetchone()
    return row[0] if row else None


async def host_say(room_id: str, text: str, kind: str, event_id: str | None = None) -> dict[str, Any]:
    """Idempotent by event_id: a retried run returns the line already said instead of saying it twice."""
    async with await psycopg.AsyncConnection.connect(database_url(), autocommit=True) as conn:
        cur = await conn.execute(
            "select row_to_json(l) from agents_api.host_say(%s, %s, %s, %s) as l", (room_id, text, kind, event_id)
        )
        row = await cur.fetchone()
    return row[0] if isinstance(row[0], dict) else json.loads(row[0])


async def start_game(room_id: str, host_id: str, settings: dict[str, Any]) -> dict[str, Any]:
    """For the host the Agent Server verified; the database checks they host the room, as the Start button does."""
    async with await psycopg.AsyncConnection.connect(database_url(), autocommit=True) as conn:
        cur = await conn.execute("select row_to_json(g) from agents_api.start_game(%s, %s, %s) as g",
                                 (room_id, host_id, json.dumps(settings)))
        row = await cur.fetchone()
    return row[0]


async def is_room_host(room_id: str, user_id: str) -> bool:
    async with await psycopg.AsyncConnection.connect(database_url(), autocommit=True) as conn:
        cur = await conn.execute("select agents_api.is_room_host(%s, %s)", (room_id, user_id))
        row = await cur.fetchone()
    return bool(row and row[0])


async def quiz_coverage(room_id: str, topic: str) -> dict[str, int]:
    """How many usable quiz questions a topic has for this room, by kind (counts only)."""
    async with await psycopg.AsyncConnection.connect(database_url(), autocommit=True) as conn:
        row = await (await conn.execute("select agents_api.quiz_coverage(%s, %s)", (room_id, topic))).fetchone()
    return row[0] or {}


async def save_quiz_question(q: dict[str, Any]) -> str | None:
    """Saves one verified question to the bank; None when it's already there."""
    async with await psycopg.AsyncConnection.connect(database_url(), autocommit=True) as conn:
        row = await (await conn.execute(
            "select agents_api.save_quiz_question(%s, %s, %s::smallint, %s::public.age_rating, %s, %s::jsonb, "
            "%s::jsonb, %s, %s, %s)",
            (q["topic"], q["kind"], q["difficulty"], q["rating"], q["prompt"],
             json.dumps(q["options"]) if q.get("options") is not None else None, json.dumps(q["answer"]),
             q.get("unit"), q["source_url"], q["source_quote"]),
        )).fetchone()
    return str(row[0]) if row and row[0] else None
