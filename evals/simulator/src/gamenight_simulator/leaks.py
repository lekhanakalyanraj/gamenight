"""What counts as a leak. Until a game ends, nothing a screen receives may contain either secret word or
the role of a player who's still in; and a player's private topic may carry only their own rows."""

import json
import re
from collections.abc import Iterable
from datetime import datetime
from typing import Any

ROLE_WORDS = {"civilian": ("civilian",), "undercover": ("undercover",), "mr_white": ("mr white", "mister white")}


def mentions(text: str, word: str) -> bool:
    """Whether the text contains the word as a whole word, in any case, or its plural."""
    return re.search(rf"\b{re.escape(word)}(e?s)?\b", text, re.IGNORECASE) is not None


def record(broadcast: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    """The table and row inside a realtime.broadcast_changes message."""
    inner = broadcast.get("payload") or {}
    return inner.get("table"), inner.get("record") or {}


def public_leaks(rows: Iterable[tuple[str | None, dict[str, Any]]], words: list[str]) -> list[str]:
    """Leaks in public rows (table, row), in the order a screen saw them. Stops at the game's end, when
    everything is revealed on purpose."""
    found = []
    for table, row in rows:
        if table == "games" and row.get("phase") == "ended":
            break
        text = json.dumps(row)
        found += [f"{table} row mentions a secret word" for word in words if mentions(text, word)]
        if table == "game_players" and row.get("alive") and row.get("revealed_role"):
            found.append(f"game_players shows the role of {row.get('member_id')}, who is still in")
    return found


def broadcast_leaks(broadcasts: list[dict[str, Any]], words: list[str]) -> list[str]:
    return public_leaks((record(b) for b in broadcasts), words)


def private_topic_leaks(broadcasts: list[dict[str, Any]], member_id: str) -> list[str]:
    """A player's own topic must carry only their own card and moves."""
    return [
        f"member:{member_id} was sent a {table} row belonging to {row.get('member_id')}"
        for table, row in map(record, broadcasts)
        if row.get("member_id") not in (None, member_id)
    ]


def narration_leaks(lines: list[dict[str, Any]], words: list[str], roles: dict[str, str],
                    revealed_at: dict[str, str], ended_at: str | None) -> list[str]:
    """What the AI host said before the end: never a word, and never a player named with their true role
    before it was revealed. lines: host_lines rows; roles: {name: role}; revealed_at: {name: when}."""
    end = datetime.fromisoformat(ended_at) if ended_at else None
    found = []
    for line in lines:
        said_at = datetime.fromisoformat(line["created_at"])
        if end and said_at >= end:
            continue
        text = " ".join(re.sub(r"[^a-z0-9]+", " ", line["text"].lower()).split())
        found += [f"the host said a secret word: {line['text']!r}" for word in words if mentions(text, word)]
        for name, role in roles.items():
            revealed = name in revealed_at and datetime.fromisoformat(revealed_at[name]) <= said_at
            if (not revealed and mentions(text, name.lower())
                    and any(mentions(text, r) for r in ROLE_WORDS.get(role, ()))):
                found.append(f"the host paired {name} with their hidden role: {line['text']!r}")
    return found
