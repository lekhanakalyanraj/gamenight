"""Configuration from the environment, read when first needed (so importing the graph needs none)."""

import os
from functools import cache


@cache
def database_url() -> str:
    """Postgres as agents_svc: the agents can only call agents_api (see the migrations)."""
    url = os.environ.get("AGENTS_DATABASE_URL")
    if not url:
        raise RuntimeError("Set AGENTS_DATABASE_URL (Postgres as agents_svc).")
    return url


def model_provider() -> str:
    """'anthropic' (default) or 'fake': a scripted model for CI and offline runs, at no cost."""
    return os.environ.get("GAMENIGHT_MODEL", "anthropic")
