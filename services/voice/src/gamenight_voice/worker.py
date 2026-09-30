"""The voice worker: claim queued lines, voice them, record the clips.

Each line is claimed with a short lease (FOR UPDATE SKIP LOCKED, then a lease time), so several workers can run
side by side and no transaction stays open during a text-to-speech call. For each line:
1. too old (the room has moved on): skipped, it stays a caption;
2. said before in this voice: the stored clip is reused, at no cost;
3. over the month's character cap: skipped;
4. otherwise voiced, stored in the bucket and recorded as a clip, which the room receives. A failure is retried
   twice with a short backoff; after that the line stays a caption.
"""

import asyncio
import contextlib
import hashlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import psycopg

from gamenight_voice.settings import Settings
from gamenight_voice.speech import Clip, SpeechError
from gamenight_voice.storage import Storage, StorageError
from gamenight_voice.telemetry import instruments, tracer

log = logging.getLogger("gamenight.voice")

FRESH_SECONDS = 10.0  # older than this, a line isn't worth voicing: the room has moved on
MAX_ATTEMPTS = 3  # the first try and two retries
LEASE_SECONDS = 30
SPEECH_TIMEOUT = 8.0
CONCURRENCY = 4  # a turn often says two lines at once
KEEP_UNUSED = "24 hours"

CLAIM = """
with due as (
  select line_id from narration.requests
  where done_at is null and next_attempt_at <= now() and (lease_until is null or lease_until < now())
  order by created_at
  limit %s
  for update skip locked
)
update narration.requests r
set lease_until = now() + make_interval(secs => %s), attempts = r.attempts + 1
from due where r.line_id = due.line_id
returning r.line_id::text, r.room_id::text, r.text, r.persona, r.attempts,
          extract(epoch from clock_timestamp() - r.created_at)::float8
"""

FINISH = """
update narration.requests set done_at = now(), outcome = %s, last_error = left(%s, 500), lease_until = null
where line_id = %s
"""
RETRY = """
update narration.requests
set lease_until = null, last_error = left(%s, 500),
    next_attempt_at = now() + make_interval(secs => power(2, attempts - 1))
where line_id = %s
"""
REUSE = "update narration.cache set last_used_at = now() where key = %s returning path"
RESERVE = """
insert into narration.usage as u (month, provider, characters)
values (date_trunc('month', now())::date, %(provider)s, %(n)s)
on conflict (month, provider) do update set characters = u.characters + excluded.characters
where %(cap)s::int is null or u.characters + excluded.characters <= %(cap)s
returning characters
"""
USED = """
select coalesce(sum(characters), 0) from narration.usage
where month = date_trunc('month', now())::date and provider = %s
"""
REFUND = """
update narration.usage set characters = greatest(characters - %s, 0)
where month = date_trunc('month', now())::date and provider = %s
"""
STORE = """
insert into narration.cache (key, path, characters) values (%s, %s, %s)
on conflict (key) do update set last_used_at = now()
"""
CLIP = "insert into narration.clips (line_id, room_id, path) values (%s, %s, %s) on conflict (line_id) do nothing"
UNUSED = "select key, path from narration.cache where last_used_at < now() - %s::interval order by key limit 500"


@dataclass(frozen=True)
class Line:
    line_id: str
    room_id: str
    text: str
    persona: str
    attempts: int
    age: float  # seconds since it was shown, when claimed
    claimed_at: float = 0.0  # time.monotonic()


Speak = Callable[[str, str], Awaitable[Clip]]  # (voice id, text) -> a clip


def cache_key(voice_id: str, model: str, text: str) -> str:
    return hashlib.sha256(f"{voice_id}\n{model}\n{text}".encode()).hexdigest()


class Worker:
    def __init__(self, settings: Settings, storage: Storage, speak: Speak):
        self.settings, self.storage, self.speak = settings, storage, speak
        self.budget_left: int | None = settings.monthly_characters
        self.outcomes: dict[str, int] = {}

    def health(self) -> dict[str, Any]:
        return {"voice": self.settings.provider, "budget_left": self.budget_left, "lines": dict(self.outcomes)}

    async def voice_due(self) -> int:
        """Voices everything that's due. Returns how many lines it handled."""
        handled = 0
        semaphore = asyncio.Semaphore(CONCURRENCY)

        async def bounded(line: Line) -> None:
            async with semaphore:
                await self.voice(line)

        while True:
            async with await psycopg.AsyncConnection.connect(self.settings.database_url, autocommit=True) as conn:
                rows = await (await conn.execute(CLAIM, (CONCURRENCY * 2, LEASE_SECONDS))).fetchall()
            if not rows:
                return handled
            now = time.monotonic()
            lines = [Line(*row, claimed_at=now) for row in rows]
            await asyncio.gather(*(bounded(line) for line in lines))
            handled += len(lines)

    async def voice(self, line: Line) -> str:
        with tracer().start_as_current_span(
            "voice.line", attributes={"gamenight.room_id": line.room_id, "gamenight.line_id": line.line_id,
                                      "gamenight.persona": line.persona, "gamenight.attempt": line.attempts},
        ) as span:
            try:
                outcome = await self._voice(line)
            except psycopg.Error as error:  # the database hiccuped: the lease runs out and the line is retried
                log.warning("line %s: database error, will retry: %s", line.line_id, error)
                span.record_exception(error)
                outcome = "retry"
            span.set_attribute("gamenight.voice.outcome", outcome)
            self.outcomes[outcome] = self.outcomes.get(outcome, 0) + 1
            instruments()["lines"].add(1, {"gamenight.voice.outcome": outcome})
            return outcome

    async def _voice(self, line: Line) -> str:
        async with await psycopg.AsyncConnection.connect(self.settings.database_url, autocommit=True) as conn:
            if line.age > FRESH_SECONDS:
                return await self._finish(conn, line, "stale")
            voice_id = self.settings.voice_for(line.persona)
            key = cache_key(voice_id, self.settings.model, line.text)
            if reused := await (await conn.execute(REUSE, (key,))).fetchone():
                await conn.execute(CLIP, (line.line_id, line.room_id, reused[0]))
                self._record_latency(line, cached=True)
                return await self._finish(conn, line, "cached")

            n, cap, provider = len(line.text), self.settings.monthly_characters, self.settings.provider
            reserved = None if cap is not None and n > cap else await (await conn.execute(
                RESERVE, {"provider": provider, "n": n, "cap": cap})).fetchone()
            if reserved is None:  # it doesn't fit in what's left this month
                used = (await (await conn.execute(USED, (provider,))).fetchone())[0]
                self.budget_left = max(cap - used, 0)
                return await self._finish(conn, line, "over_budget")
            self.budget_left = None if cap is None else cap - reserved[0]

            try:
                clip = await asyncio.wait_for(self.speak(voice_id, line.text), SPEECH_TIMEOUT)
                path = f"clips/{key}.{clip.extension}"
                await self.storage.upload(path, clip.audio, clip.content_type, {
                    "ai_generated": "true", "persona": line.persona,
                    "generator": "fake" if provider == "fake" else f"{provider}/{self.settings.model}"})
            except (SpeechError, StorageError, TimeoutError) as error:
                await conn.execute(REFUND, (n, provider))
                if self.budget_left is not None:
                    self.budget_left += n
                reason = str(error) or type(error).__name__
                if line.attempts >= MAX_ATTEMPTS:
                    log.warning("line %s: giving up after %d attempts: %s", line.line_id, line.attempts, reason)
                    return await self._finish(conn, line, "failed", reason)
                await conn.execute(RETRY, (reason, line.line_id))
                return "retry"

            instruments()["characters"].add(n, {"gamenight.voice.provider": provider})
            async with conn.transaction():
                await conn.execute(STORE, (key, path, n))
                await conn.execute(CLIP, (line.line_id, line.room_id, path))
                await conn.execute(FINISH, ("voiced", None, line.line_id))
            self._record_latency(line, cached=False)
            return "voiced"

    @staticmethod
    async def _finish(conn: psycopg.AsyncConnection, line: Line, outcome: str, error: str | None = None) -> str:
        await conn.execute(FINISH, (outcome, error, line.line_id))
        return outcome

    @staticmethod
    def _record_latency(line: Line, cached: bool) -> None:
        waited = line.age + time.monotonic() - line.claimed_at
        instruments()["latency"].record(waited * 1000, {"gamenight.voice.cached": cached})

    async def sweep(self) -> int:
        """Deletes clips nobody has used for a day, and finished requests older than a week."""
        async with await psycopg.AsyncConnection.connect(self.settings.database_url, autocommit=True) as conn:
            unused = await (await conn.execute(UNUSED, (KEEP_UNUSED,))).fetchall()
            await self.storage.delete([path for _, path in unused])  # the files first: never a row without its file
            if unused:
                await conn.execute("delete from narration.cache where key = any(%s)", ([key for key, _ in unused],))
            await conn.execute("delete from narration.requests where done_at < now() - interval '7 days'")
        return len(unused)

    async def run(self, stop: asyncio.Event, poll_seconds: float = 5.0, sweep_every: float = 600.0) -> None:
        swept = 0.0
        while not stop.is_set():
            try:
                connect = psycopg.AsyncConnection.connect(self.settings.database_url, autocommit=True)
                async with await connect as listener:
                    await listener.execute("listen narration_requests")
                    log.info("listening for lines to voice (%s)", self.settings.provider)
                    while not stop.is_set():
                        if count := await self.voice_due():
                            log.info("handled %d lines", count)
                        if time.monotonic() - swept > sweep_every:
                            swept = time.monotonic()
                            with contextlib.suppress(StorageError):
                                await self.sweep()
                        async for _ in listener.notifies(timeout=poll_seconds, stop_after=1):
                            pass
            except psycopg.Error as error:
                log.error("the voice worker lost the database, will retry: %s", error)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), poll_seconds)
