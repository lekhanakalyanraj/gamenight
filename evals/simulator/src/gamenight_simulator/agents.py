"""The Agent Server, as the simulator sees it: each game's thread holds the game master's running totals."""

import asyncio
import time
from typing import Any

import httpx

STATS = ("runs", "stale_runs", "model_calls", "refused", "lines_rejected")


class Agents:
    def __init__(self, url: str, service_token: str):
        self.http = httpx.AsyncClient(base_url=url, headers={"x-gamenight-service-token": service_token}, timeout=15)

    async def close(self) -> None:
        await self.http.aclose()

    async def wait_idle(self, game_id: str, timeout: float = 30.0) -> bool:
        """Waits until the game master has no run in progress or queued on the game's thread."""
        await asyncio.sleep(1.0)  # the game's last event may still be on its way from the dispatcher
        started = time.monotonic()
        while time.monotonic() - started < timeout:
            response = await self.http.get(f"/threads/{game_id}")
            if response.status_code == 200 and response.json().get("status") == "idle":
                return True
            await asyncio.sleep(0.5)
        return False

    async def game_stats(self, game_id: str) -> dict[str, Any]:
        """The game master's totals for a game: runs, stale runs, model calls, refused moves, rejected lines."""
        response = await self.http.get(f"/threads/{game_id}/state")
        if response.status_code == 404:
            return {}
        response.raise_for_status()
        values = response.json().get("values") or {}
        return {k: values.get(k, 0) for k in STATS}
