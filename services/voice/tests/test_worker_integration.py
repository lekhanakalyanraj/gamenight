"""The voice worker against the local Supabase database (skipped when it isn't running): make db-start first.

Text to speech and Storage are faked here; the database, its trigger, the outbox and the broadcasts are real.
Stop `make voice-dev` first: a running worker would claim these tests' lines.
"""

import asyncio
import os
import uuid

import psycopg
import pytest

from gamenight_voice import speech
from gamenight_voice.settings import Settings
from gamenight_voice.speech import SpeechError
from gamenight_voice.worker import Worker

ADMIN_URL = os.environ.get("ADMIN_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55422/postgres")
VOICE_URL = os.environ.get("DATABASE_URL", "postgresql://voice_svc:local-dev-voice@127.0.0.1:55422/postgres")


def reachable() -> bool:
    try:
        psycopg.connect(VOICE_URL, connect_timeout=2).close()
        return True
    except psycopg.Error:
        return False


pytestmark = pytest.mark.skipif(not reachable(), reason="local Supabase database not running")


class FakeStorage:
    def __init__(self):
        self.files: dict[str, tuple[bytes, str, dict]] = {}
        self.deleted: list[str] = []

    async def upload(self, path, audio, content_type, metadata):
        self.files[path] = (audio, content_type, metadata)

    async def delete(self, paths):
        self.deleted += paths


class FakeVoice:
    def __init__(self, fail: int = 0):
        self.said: list[tuple[str, str]] = []
        self.fail = fail

    async def __call__(self, voice_id, text):
        await asyncio.sleep(0.05)  # long enough for a second worker to try the same line
        if self.fail:
            self.fail -= 1
            raise SpeechError("ElevenLabs 503: busy")
        self.said.append((voice_id, text))
        return speech.fake(text)


@pytest.fixture
def room():
    host, room_id = str(uuid.uuid4()), str(uuid.uuid4())
    code = uuid.uuid4().hex[:6].upper().translate(str.maketrans("01IO", "2345"))
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        # Park leftovers from earlier local runs, so a worker here only sees this test's lines.
        conn.execute("update narration.requests set done_at = now(), outcome = 'stale' where done_at is null")
        conn.execute("insert into auth.users (id, email) values (%s, %s)", (host, f"{host}@example.com"))
        conn.execute("insert into public.rooms (id, code, host_id) values (%s, %s, %s)", (room_id, code, host))
    yield room_id
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("delete from public.rooms where id = %s", (room_id,))
        conn.execute("delete from auth.users where id = %s", (host,))


@pytest.fixture
def provider():
    """A provider label of its own, so this test's character count starts at zero."""
    name = f"test-{uuid.uuid4().hex[:8]}"
    yield name
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("delete from narration.usage where provider = %s", (name,))


def worker(provider: str, voice: FakeVoice, cap: int | None = None) -> tuple[Worker, FakeStorage]:
    storage = FakeStorage()
    settings = Settings(VOICE_URL, "http://sb", "k", "v@x", "p", provider=provider, monthly_characters=cap)
    return Worker(settings, storage, voice), storage


def say(room_id: str, text: str, kind: str = "narration") -> str:
    """A host line, as the narrator writes it (its voicing request is queued by the trigger)."""
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        return str(conn.execute("insert into public.host_lines (room_id, kind, text) values (%s, %s, %s) returning id",
                                (room_id, kind, text)).fetchone()[0])


def request(line_id: str) -> tuple:
    with psycopg.connect(ADMIN_URL) as conn:
        return conn.execute("select outcome, attempts, persona, last_error from narration.requests where line_id = %s",
                            (line_id,)).fetchone()


def clip(line_id: str) -> str | None:
    with psycopg.connect(ADMIN_URL) as conn:
        row = conn.execute("select path from narration.clips where line_id = %s", (line_id,)).fetchone()
        return row[0] if row else None


def unique(text: str) -> str:
    return f"{text} ({uuid.uuid4().hex[:6]})"  # never in the cache from an earlier run


def test_a_line_is_voiced_stored_tagged_and_sent_to_the_room(room, provider):
    voice = FakeVoice()
    w, storage = worker(provider, voice)
    line = say(room, unique("Welcome, detectives."), kind="welcome")
    assert asyncio.run(w.voice_due()) == 1
    assert request(line)[:3] == ("voiced", 1, "host")
    path = clip(line)
    assert path.startswith("clips/") and path.endswith(".wav")
    audio, content_type, metadata = storage.files[path]
    assert content_type == "audio/wav" and metadata["ai_generated"] == "true" and b"AI-generated" in audio
    with psycopg.connect(ADMIN_URL) as conn:
        sent = conn.execute("select count(*) from realtime.messages where topic = %s and payload->>'table' = 'clips' "
                            "and payload->'record'->>'line_id' = %s", (f"room:{room}", line)).fetchone()[0]
        used = conn.execute("select characters from narration.usage where provider = %s", (provider,)).fetchone()[0]
    assert sent == 1 and used == len(voice.said[0][1])
    assert asyncio.run(w.voice_due()) == 0  # nothing is voiced twice


def test_a_line_said_before_reuses_its_clip_for_free(room, provider):
    voice = FakeVoice()
    w, _ = worker(provider, voice)
    text = unique("The votes are in.")
    first = say(room, text)
    asyncio.run(w.voice_due())
    again = say(room, text)
    asyncio.run(w.voice_due())
    assert (request(first)[0], request(again)[0]) == ("voiced", "cached")
    assert len(voice.said) == 1 and clip(first) == clip(again)


def test_narration_uses_the_games_voice(room, provider):
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("insert into public.games (room_id, kind) values (%s, 'undercover')", (room,))
    voice = FakeVoice()
    w, _ = worker(provider, voice)
    line = say(room, unique("Interesting clue..."))
    asyncio.run(w.voice_due())
    assert request(line)[2] == "undercover" and voice.said[0][0] == w.settings.voice_for("undercover")


def test_a_line_the_room_has_moved_past_stays_a_caption(room, provider):
    voice = FakeVoice()
    w, _ = worker(provider, voice)
    line = say(room, unique("Too late for this one."))
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("update narration.requests set created_at = now() - interval '20 seconds' where line_id = %s",
                     (line,))
    asyncio.run(w.voice_due())
    assert request(line)[0] == "stale" and voice.said == [] and clip(line) is None


def test_the_monthly_cap_is_never_passed(room, provider):
    voice = FakeVoice()
    w, _ = worker(provider, voice, cap=30)
    short = unique("Short one.")
    fits, too_long = say(room, short), say(room, unique("This line would go past the monthly cap."))
    asyncio.run(w.voice_due())
    assert request(fits)[0] == "voiced" and request(too_long)[0] == "over_budget"
    assert w.health()["budget_left"] == 30 - len(short) and len(voice.said) == 1


def test_a_failing_provider_is_retried_twice_then_the_line_stays_a_caption(room, provider):
    voice = FakeVoice(fail=3)
    w, _ = worker(provider, voice, cap=1000)
    line = say(room, unique("Nobody leaves this room."))
    for attempt in (1, 2, 3):
        asyncio.run(w.voice_due())
        with psycopg.connect(ADMIN_URL, autocommit=True) as conn:  # skip the backoff wait
            conn.execute("update narration.requests set next_attempt_at = now() where line_id = %s", (line,))
        assert request(line)[1] == attempt
    outcome, attempts, _, error = request(line)
    assert (outcome, attempts) == ("failed", 3) and "503" in error and clip(line) is None
    with psycopg.connect(ADMIN_URL) as conn:  # the characters of failed attempts are given back
        used = conn.execute("select characters from narration.usage where provider = %s", (provider,)).fetchone()[0]
    assert used == 0


def test_two_workers_never_voice_the_same_line(room, provider):
    voice = FakeVoice()
    first, _ = worker(provider, voice)
    second, _ = worker(provider, voice)
    lines = [say(room, unique(f"Line {i}.")) for i in range(3)]

    async def both():
        return await asyncio.gather(first.voice_due(), second.voice_due())

    assert sum(asyncio.run(both())) == 3
    assert len(voice.said) == 3 and all(request(line)[0] == "voiced" for line in lines)


def test_clips_unused_for_a_day_are_deleted_file_first(room, provider):
    voice = FakeVoice()
    w, storage = worker(provider, voice)
    line = say(room, unique("An old line."))
    asyncio.run(w.voice_due())
    path = clip(line)
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("update narration.cache set last_used_at = now() - interval '2 days' where path = %s", (path,))
    assert asyncio.run(w.sweep()) >= 1 and path in storage.deleted
    with psycopg.connect(ADMIN_URL) as conn:
        assert conn.execute("select count(*) from narration.cache where path = %s", (path,)).fetchone()[0] == 0


def test_a_line_that_hangs_is_given_up_on_and_the_rest_are_still_voiced(room, provider, monkeypatch):
    # Regression: when the database dropped its connections, the worker waited on a dead socket forever.
    from gamenight_voice import worker as worker_module

    monkeypatch.setattr(worker_module, "LINE_TIMEOUT", 0.5)

    class HangsOnce(FakeVoice):
        async def __call__(self, voice_id, text):
            if "hangs" in text:
                await asyncio.sleep(60)
            return await super().__call__(voice_id, text)

    voice = HangsOnce()
    w, _ = worker(provider, voice)
    stuck, fine = say(room, unique("This one hangs.")), say(room, unique("This one is fine."))
    asyncio.run(w.voice_due())
    assert request(fine)[0] == "voiced" and request(stuck)[0] is None  # its lease runs out: retried or stale
    assert w.health()["lines"]["timed_out"] == 1
