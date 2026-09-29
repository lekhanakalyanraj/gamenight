"""Just enough of Supabase's HTTP API for a bot: sign in, call RPCs and read tables, as that user."""

from dataclasses import dataclass
from typing import Any

import httpx


class RpcError(Exception):
    """The database refused a call. `code` is its SQLSTATE, e.g. 55000 for a move that isn't legal now."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class Session:
    user_id: str
    token: str
    refresh_token: str
    expires_at: float


class Supabase:
    def __init__(self, url: str, key: str):
        self.url, self.key = url, key
        self.traceparent: str | None = None  # sent with every call, so one game is one trace (see game.py)
        self.http = httpx.AsyncClient(base_url=url, headers={"apikey": key}, timeout=15.0)

    async def close(self) -> None:
        await self.http.aclose()

    async def _session(self, path: str, body: dict[str, Any]) -> Session:
        response = await self.http.post(path, json=body)
        response.raise_for_status()
        data = response.json()
        return Session(data["user"]["id"], data["access_token"], data["refresh_token"], data["expires_at"])

    async def _sign_up(self, body: dict[str, Any]) -> Session:
        return await self._session("/auth/v1/signup", body)

    async def refresh(self, session: Session) -> Session:
        """A new login for the same user (logins last an hour; long runs outlive them)."""
        return await self._session("/auth/v1/token?grant_type=refresh_token", {"refresh_token": session.refresh_token})

    async def sign_in_anonymously(self) -> Session:
        return await self._sign_up({"data": {}})

    async def sign_up(self, email: str, password: str, display_name: str) -> Session:
        return await self._sign_up({"email": email, "password": password, "data": {"display_name": display_name}})

    def _auth(self, session: Session) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {session.token}"}
        if self.traceparent:  # the Data API hands it to Postgres, and the outbox records it with each event
            headers["traceparent"] = self.traceparent
        return headers

    async def rpc(self, session: Session, fn: str, **args: Any) -> Any:
        response = await self.http.post(f"/rest/v1/rpc/{fn}", json=args, headers=self._auth(session))
        if response.status_code >= 400:
            body = response.json()
            raise RpcError(body.get("code") or str(response.status_code), body.get("message") or response.text)
        return response.json() if response.content else None

    async def select(self, session: Session, table: str, **filters: str) -> list[dict[str, Any]]:
        params = {"select": "*", **{column: f"eq.{value}" for column, value in filters.items()}}
        response = await self.http.get(f"/rest/v1/{table}", params=params, headers=self._auth(session))
        response.raise_for_status()
        return response.json()
