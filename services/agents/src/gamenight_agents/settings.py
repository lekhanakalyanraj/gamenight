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


def service_token() -> str:
    """The internal token every caller of the Agent Server must send (web proxy, dispatcher)."""
    token = os.environ.get("AGENTS_SERVICE_TOKEN")
    if not token:
        raise RuntimeError("Set AGENTS_SERVICE_TOKEN.")
    return token


def supabase_jwks_url() -> str:
    return os.environ.get("SUPABASE_JWKS_URL", "http://127.0.0.1:55421/auth/v1/.well-known/jwks.json")


def supabase_jwt_issuer() -> str:
    return os.environ.get("SUPABASE_JWT_ISSUER", "http://127.0.0.1:55421/auth/v1")


def catalog_url() -> str:
    return os.environ.get("CATALOG_URL", "http://127.0.0.1:8136")


def catalog_token() -> str:
    return os.environ.get("CATALOG_SERVICE_TOKEN", "")
