"""The voice service: a health endpoint, and the worker that voices every line the TV shows.

The worker starts with the app when DATABASE_URL is set (without it, as in the unit tests, only health runs).
"""

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import FastAPI, Response

from gamenight_voice import speech
from gamenight_voice.settings import Settings, from_env
from gamenight_voice.storage import Storage
from gamenight_voice.worker import Speak, Worker

worker: Worker | None = None


def speaker(settings: Settings, http: httpx.AsyncClient) -> Speak:
    if settings.provider == "fake":
        async def fake(voice_id: str, text: str) -> speech.Clip:
            await asyncio.sleep(0.2)  # about a real provider's time to first byte, so timings stay honest
            return speech.fake(text)
        return fake

    async def elevenlabs(voice_id: str, text: str) -> speech.Clip:
        return await speech.elevenlabs(http, settings.elevenlabs_key, settings.model, voice_id, text)
    return elevenlabs


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global worker
    if not os.environ.get("DATABASE_URL"):
        yield
        return
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # a line per request would drown the worker's own logs
    settings = from_env()
    stop = asyncio.Event()
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=3.0)) as http:
        storage = Storage(http, settings.supabase_url, settings.supabase_key, settings.storage_email,
                          settings.storage_password)
        worker = Worker(settings, storage, speaker(settings, http))
        task = asyncio.create_task(worker.run(stop))
        try:
            yield
        finally:
            stop.set()
            await task
            worker = None


app = FastAPI(title="gamenight voice", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.get("/healthz")
def healthz(response: Response) -> dict[str, Any]:
    # Out of characters or not, the service is healthy: the room still has captions. A worker loop that has
    # stopped coming round isn't, so the probe fails and the service is restarted.
    if worker and worker.stuck():
        response.status_code = 503
        return {"status": "stuck", "service": "voice", **worker.health()}
    return {"status": "ok", "service": "voice", **(worker.health() if worker else {})}
