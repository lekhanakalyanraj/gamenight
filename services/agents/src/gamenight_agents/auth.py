"""Who may use the Agent Server, and what they may touch (loaded via langgraph.json "auth").

Every request needs the internal service token. With a Supabase login on top it's a host acting through
the web app's proxy; with the token alone it's the dispatcher. Hosts may only use the thread of a room
they host (thread id = room id). A game's thread (thread id = game id) holds every card in the game master's
memory, so it's for the service token only: no room has a game's id, and game threads are refused outright
as well. Anything not explicitly allowed is denied.
"""

import asyncio
import hmac
from functools import cache

import jwt
from langgraph_sdk import Auth

from gamenight_agents import db
from gamenight_agents.settings import service_token, supabase_jwks_url, supabase_jwt_issuer

auth = Auth()

SERVICE = "service"
HOST = "host"


def _header(headers: dict, name: str) -> str | None:
    value = headers.get(name.encode()) or headers.get(name)
    return value.decode() if isinstance(value, bytes) else value


@cache
def _jwks() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(supabase_jwks_url(), cache_keys=True, lifespan=600)


def verify_supabase_jwt(token: str) -> dict:
    """Signature (Supabase's published keys), audience, issuer and expiry, all checked."""
    key = _jwks().get_signing_key_from_jwt(token).key
    return jwt.decode(token, key, algorithms=["ES256", "RS256"], audience="authenticated", issuer=supabase_jwt_issuer())


def _forbidden(detail: str = "forbidden") -> Auth.exceptions.HTTPException:
    return Auth.exceptions.HTTPException(status_code=403, detail=detail)


@auth.authenticate
async def authenticate(headers: dict, authorization: str | None) -> Auth.types.MinimalUserDict:
    given = _header(headers, "x-gamenight-service-token") or ""
    if not hmac.compare_digest(given.encode(), service_token().encode()):
        raise Auth.exceptions.HTTPException(status_code=401, detail="unauthorized")
    if not authorization:
        return {"identity": "service:internal", "permissions": [SERVICE]}
    try:
        # PyJWKClient fetches keys over the network: keep that off the event loop.
        claims = await asyncio.to_thread(verify_supabase_jwt, authorization.removeprefix("Bearer ").strip())
    except jwt.PyJWTError as error:
        raise Auth.exceptions.HTTPException(status_code=401, detail="invalid login") from error
    if claims.get("is_anonymous"):
        raise _forbidden("guests can't chat with the host agent")
    return {"identity": claims["sub"], "permissions": [HOST]}


@auth.on
async def deny_by_default(ctx: Auth.types.AuthContext, value: dict) -> bool:
    if SERVICE in ctx.permissions:
        return True
    raise _forbidden()


async def _room_host_only(ctx: Auth.types.AuthContext, value: dict) -> bool:
    if SERVICE in ctx.permissions:
        return True
    if (value.get("metadata") or {}).get("kind") == "game":
        raise _forbidden("a game's thread is for the game master only")
    thread_id = value.get("thread_id")
    if HOST in ctx.permissions and thread_id and await db.is_room_host(str(thread_id), ctx.user.identity):
        return True
    raise _forbidden()


auth.on.threads.create(_room_host_only)
auth.on.threads.read(_room_host_only)
auth.on.threads.create_run(_room_host_only)
