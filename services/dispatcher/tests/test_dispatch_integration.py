"""Against the local Supabase database (skipped when it isn't running): make db-start first."""

import asyncio
import os
import uuid

import psycopg
import pytest

from gamenight_dispatcher.dispatcher import dispatch_due, fire_deadlines

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


def test_a_join_trace_continues_through_the_dispatcher_to_the_agents(room):
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from gamenight_dispatcher.outbox import run_metadata
    from gamenight_dispatcher.telemetry import current_traceparent

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("update dispatch.events set traceparent = %s where room_id = %s",
                     (f"00-{trace_id}-00f067aa0ba902b7-01", room))

    handed: list[dict] = []

    class RecordingAgents:
        async def start_run(self, room_id, events):
            handed.append(run_metadata(room_id, events, current_traceparent()))

    asyncio.run(dispatch_due(DISPATCHER_URL, RecordingAgents()))

    span = next(s for s in exporter.get_finished_spans() if s.name == "dispatch.room")
    assert format(span.context.trace_id, "032x") == trace_id  # continues the join's trace
    assert span.attributes["gamenight.events"] == 2
    # The agents get the dispatch span as their parent, in the same trace.
    assert handed[0]["traceparent"].split("-")[1:3] == [trace_id, format(span.context.span_id, "016x")]


def test_game_events_wait_for_the_game_master(room):
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("insert into dispatch.events (room_id, kind) values (%s, 'game_started')", (room,))
    agents = FakeAgents()
    assert asyncio.run(dispatch_due(DISPATCHER_URL, agents)) == 2  # the two joins only
    with psycopg.connect(ADMIN_URL) as conn:
        kind, dispatched = conn.execute(
            "select kind, dispatched_at is not null from dispatch.events "
            "where room_id = %s and kind <> 'member_joined'",
            (room,),
        ).fetchone()
    assert (kind, dispatched) == ("game_started", False)


def test_a_clue_turn_that_runs_out_moves_to_the_next_speaker(room):
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        host = conn.execute("select host_id from public.rooms where id = %s", (room,)).fetchone()[0]
        member = conn.execute(
            "insert into public.room_members (room_id, user_id, nickname) values (%s, %s, 'Host') returning id",
            (room, host),
        ).fetchone()[0]
        conn.execute("update public.rooms set status = 'playing' where id = %s", (room,))
        # Two turns, and the first has just run out.
        game = conn.execute(
            "insert into public.games (room_id, kind, phase, config, turn_order, turn_index, turn_deadline) "
            "values (%s, 'undercover', 'clues', '{\"turn_seconds\": 20}', %s, 0, now() - interval '1 second') "
            "returning id",
            (room, [member, member]),
        ).fetchone()[0]

    async def tick_once():
        stop = asyncio.Event()
        ticking = asyncio.create_task(fire_deadlines(DISPATCHER_URL, stop, every=0.1))
        await asyncio.sleep(0.5)
        stop.set()
        await ticking

    asyncio.run(tick_once())
    with psycopg.connect(ADMIN_URL) as conn:
        turn_index, deadline_ahead = conn.execute(
            "select turn_index, turn_deadline > now() + interval '15 seconds' from public.games where id = %s", (game,)
        ).fetchone()
    assert (turn_index, deadline_ahead) == (1, True)
