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
