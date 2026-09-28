"""The agents' client for the catalog service (service to service, with the catalog's token)."""

from typing import Any

import httpx
from opentelemetry.trace import SpanKind

from gamenight_agents.settings import catalog_token, catalog_url
from gamenight_agents.telemetry import current_traceparent, tracer


async def list_games(players: int | None = None, minutes: int | None = None) -> list[dict[str, Any]]:
    params = {k: v for k, v in {"players": players, "minutes": minutes}.items() if v}
    with tracer().start_as_current_span(
        "GET /v1/games", kind=SpanKind.CLIENT, attributes={"server.address": catalog_url()}
    ):
        async with httpx.AsyncClient(base_url=catalog_url(), timeout=5.0) as client:
            headers = {"Authorization": f"Bearer {catalog_token()}"}
            if traceparent := current_traceparent():
                headers["traceparent"] = traceparent  # the catalog's span joins this trace
            response = await client.get("/v1/games", params=params, headers=headers)
            response.raise_for_status()
            return response.json()["games"]
