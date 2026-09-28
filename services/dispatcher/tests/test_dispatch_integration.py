"""Against the local Supabase database (skipped when it isn't running): make db-start first."""

import asyncio
import os
import uuid

import psycopg
import pytest

from gamenight_dispatcher.dispatcher import dispatch_due

ADMIN_URL = os.environ.get("ADMIN_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55422/postgres")
DISPATCHER_URL = os.environ.get(
    "DATABASE_URL", "postgresql://dispatcher_svc:local-dev-dispatcher@127.0.0.1:55422/postgres"
)


def reachable() -> bool:
    try:
        psycopg.connect(DISPATCHER_URL, connect_timeout=2).close()
        return True
    except psycopg.Error:
        return False


pytestmark = pytest.mark.skipif(not reachable(), reason="local Supabase database not running")


class FakeAgents:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.runs: list[tuple[str, list[str]]] = []

    async def start_run(self, room_id, events):
        await asyncio.sleep(0.05)  # long enough for a concurrent dispatcher to try the same rows
        if self.fail:
            raise RuntimeError("agent server unavailable")
        self.runs.append((room_id, [e.id for e in events]))


@pytest.fixture
def room():
    """A committed room with two pending join events, removed afterwards (events cascade)."""
    host, room_id = str(uuid.uuid4()), str(uuid.uuid4())
    code = uuid.uuid4().hex[:6].upper().translate(str.maketrans("01IO", "2345"))
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        # Park leftovers from earlier local runs, so counts below only see this test's events.
        conn.execute("update dispatch.events set failed_at = now() where dispatched_at is null and failed_at is null")
        conn.execute("insert into auth.users (id, email) values (%s, %s)", (host, f"{host}@example.com"))
        conn.execute("insert into public.rooms (id, code, host_id) values (%s, %s, %s)", (room_id, code, host))
        for name in ("Asha", "Ben"):
            conn.execute(
                "insert into dispatch.events (room_id, kind, payload) values (%s, 'member_joined', %s)",
                (room_id, psycopg.types.json.Jsonb({"nickname": name})),
            )
    yield room_id
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("delete from public.rooms where id = %s", (room_id,))
        conn.execute("delete from auth.users where id = %s", (host,))


def pending(room_id):
    with psycopg.connect(ADMIN_URL) as conn:
        return conn.execute(
            "select attempts, dispatched_at is not null, failed_at is not null, last_error from dispatch.events "
            "where room_id = %s order by created_at",
            (room_id,),
        ).fetchall()


def test_events_are_dispatched_once_as_one_run_per_room(room):
    agents = FakeAgents()
    assert asyncio.run(dispatch_due(DISPATCHER_URL, agents)) == 2
    assert [r for r, _ in agents.runs] == [room] and len(agents.runs[0][1]) == 2
    assert all(dispatched for _, dispatched, _, _ in pending(room))
    assert asyncio.run(dispatch_due(DISPATCHER_URL, agents)) == 0  # nothing is handed over twice


def test_failures_back_off_and_are_dead_lettered_after_five_attempts(room):
    agents = FakeAgents(fail=True)
    asyncio.run(dispatch_due(DISPATCHER_URL, agents))
    assert [(a, d, f) for a, d, f, _ in pending(room)] == [(1, False, False)] * 2
    assert pending(room)[0][3] == "agent server unavailable"
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("update dispatch.events set attempts = 4, next_attempt_at = now() where room_id = %s", (room,))
    asyncio.run(dispatch_due(DISPATCHER_URL, agents))
    assert [(a, d, f) for a, d, f, _ in pending(room)] == [(5, False, True)] * 2


def test_two_dispatchers_never_hand_out_the_same_event(room):
    first, second = FakeAgents(), FakeAgents()

    async def both():
        return await asyncio.gather(dispatch_due(DISPATCHER_URL, first), dispatch_due(DISPATCHER_URL, second))

    assert sum(asyncio.run(both())) == 2
    handed = [e for _, ids in first.runs + second.runs for e in ids]
    assert len(handed) == len(set(handed)) == 2
