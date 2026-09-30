"""The narrator's voice, as the TV hears it: the lines it was shown, and how long each took to get its clip."""

from collections.abc import Iterable
from datetime import datetime
from typing import Any

from gamenight_simulator.leaks import record


def clip_gaps(broadcasts: Iterable[dict[str, Any]]) -> tuple[int, list[float]]:
    """How many host lines the room was shown, and for each voiced one the seconds from the line to its clip
    (both stamped by the database, so the gap is the voice pipeline's own time)."""
    shown: dict[str, str] = {}
    clips: dict[str, str] = {}
    for table, row in map(record, broadcasts):
        if table == "host_lines":
            shown[row["id"]] = row["created_at"]
        elif table == "clips":
            clips[row["line_id"]] = row["created_at"]
    gaps = [(datetime.fromisoformat(clips[line]) - datetime.fromisoformat(at)).total_seconds()
            for line, at in shown.items() if line in clips]
    return len(shown), gaps
