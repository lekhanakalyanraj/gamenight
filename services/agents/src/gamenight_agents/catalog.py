"""The agents' client for the catalog service (service to service, with the catalog's token)."""

from typing import Any

import httpx

from gamenight_agents.settings import catalog_token, catalog_url


async def list_games(players: int | None = None, minutes: int | None = None) -> list[dict[str, Any]]:
    params = {k: v for k, v in {"players": players, "minutes": minutes}.items() if v}
    async with httpx.AsyncClient(base_url=catalog_url(), timeout=5.0) as client:
        response = await client.get("/v1/games", params=params, headers={"Authorization": f"Bearer {catalog_token()}"})
        response.raise_for_status()
        return response.json()["games"]
