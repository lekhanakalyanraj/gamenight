"""The narration bucket, reached as the voice service's own Supabase Auth account (never the admin key that
skips row-level security).

Storage's row-level security lets only that account write or delete in the bucket, and lets a player or TV
read a clip only if it voices a line in a room they can view.
"""

import base64
import json
import time

import httpx

BUCKET = "narration"


class StorageError(Exception):
    pass


class Storage:
    def __init__(self, http: httpx.AsyncClient, url: str, key: str, email: str, password: str):
        self.http, self.url, self.key = http, url, key
        self.email, self.password = email, password
        self._token: str | None = None
        self._expires = 0.0

    async def _auth(self) -> dict[str, str]:
        if self._token is None or time.monotonic() > self._expires - 60:
            response = await self.http.post(
                f"{self.url}/auth/v1/token", params={"grant_type": "password"}, headers={"apikey": self.key},
                json={"email": self.email, "password": self.password},
            )
            if response.status_code != 200:
                raise StorageError(f"the voice service couldn't sign in ({response.status_code})")
            session = response.json()
            self._token, self._expires = session["access_token"], time.monotonic() + session["expires_in"]
        return {"apikey": self.key, "authorization": f"Bearer {self._token}"}

    async def sign_in(self) -> None:
        """Signs in ahead of the first clip, so the first line of the night isn't the slow one."""
        await self._auth()

    async def upload(self, path: str, audio: bytes, content_type: str, metadata: dict[str, str]) -> None:
        """Stores a clip. Clips are named by their content, so one that's already there is the same clip."""
        response = await self.http.post(
            f"{self.url}/storage/v1/object/{BUCKET}/{path}", content=audio,
            headers={**await self._auth(), "content-type": content_type, "cache-control": "max-age=86400",
                     "x-metadata": base64.b64encode(json.dumps(metadata).encode()).decode()},
        )
        if response.status_code == 200:
            return
        if response.status_code in (400, 409) and "KeyAlreadyExists" in response.text:
            return
        raise StorageError(f"upload of {path} failed ({response.status_code}): {response.text[:200]}")

    async def delete(self, paths: list[str]) -> None:
        if not paths:
            return
        response = await self.http.request(
            "DELETE", f"{self.url}/storage/v1/object/{BUCKET}", headers=await self._auth(), json={"prefixes": paths},
        )
        if response.status_code != 200:
            raise StorageError(f"deleting {len(paths)} clips failed ({response.status_code})")
