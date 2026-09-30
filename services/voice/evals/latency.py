"""How long a line waits for its voice, with the real provider: the voice service's share of "narrate to audio".

Shows about 20 lines like a game's narration in a scratch room, one every 2.5 seconds (the pace of a game), and
times each from the line being shown to its clip being ready (both stamped by the database). Needs the local
stack and `make voice-dev GAMENIGHT_VOICE=elevenlabs` running; spends about 2,000 characters. Reports only.

Usage: uv run python -m evals.latency [--lines 20] [--pace 2.5]
"""

import argparse
import asyncio
import os
import random
import sys
import time
import uuid

import psycopg

ADMIN_URL = os.environ.get("ADMIN_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55422/postgres")

NAMES = ["Asha", "Ben", "Chen", "Dara", "Ema", "Farah", "Gio", "Hana", "Ivan", "Kiko", "Leo", "Mira", "Nia", "Omar"]
LINES = [
    "Round {n}. Clues, please, and choose your words carefully.",
    "Interesting clue, {a}... very interesting.",
    "{a} is out, and they were a civilian. The infiltrators are still among you.",
    "A tie between {a} and {b}! One more vote, just between them.",
    "Talk it out, detectives. Someone here isn't who they seem.",
    "Phones out, everyone. Who's been playing you?",
    "{a}, your clue raised an eyebrow. {b}, yours raised two.",
    "Mr. White has been caught! One guess at the word, {a}. Make it count.",
    "The votes are in, and the room has spoken.",
    "Five of you left, and the table's getting thin. Who's lying?",
    "{a} hesitated. The detective noticed.",
    "Nobody leaves this room until we find the infiltrators.",
]


def line(rng: random.Random) -> str:
    a, b = rng.sample(NAMES, 2)
    return rng.choice(LINES).format(a=a, b=b, n=rng.randint(2, 9))


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lines", type=int, default=20)
    parser.add_argument("--pace", type=float, default=2.5, help="seconds between lines")
    args = parser.parse_args()
    rng = random.Random()
    host, room = str(uuid.uuid4()), str(uuid.uuid4())
    code = uuid.uuid4().hex[:6].upper().translate(str.maketrans("01IO", "2345"))

    async with await psycopg.AsyncConnection.connect(ADMIN_URL, autocommit=True) as conn:
        await conn.execute("insert into auth.users (id, email) values (%s, %s)",
                           (host, f"latency-{host[:8]}@example.com"))
        await conn.execute("insert into public.rooms (id, code, host_id) values (%s, %s, %s)", (room, code, host))
        used_before = await usage(conn)
        try:
            shown = []
            for i in range(args.lines):
                text = line(rng)
                row = await (await conn.execute(
                    "insert into public.host_lines (room_id, kind, text) values (%s, 'narration', %s) returning id",
                    (room, text))).fetchone()
                shown.append(str(row[0]))
                print(f"  line {i + 1:>2}: {text}", flush=True)
                await asyncio.sleep(args.pace)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                done = (await (await conn.execute(
                    "select count(*) from narration.requests where line_id = any(%s::uuid[]) and done_at is not null",
                    (shown,))).fetchone())[0]
                if done == len(shown):
                    break
                await asyncio.sleep(0.5)
            rows = await (await conn.execute("""
                select q.outcome, extract(epoch from c.created_at - l.created_at)::float8, q.last_error
                from narration.requests q join public.host_lines l on l.id = q.line_id
                left join narration.clips c on c.line_id = q.line_id
                where q.line_id = any(%s::uuid[])""", (shown,))).fetchall()
            used = await usage(conn) - used_before
        finally:
            await conn.execute("delete from public.rooms where id = %s", (room,))
            await conn.execute("delete from auth.users where id = %s", (host,))

    outcomes: dict[str, int] = {}
    for outcome, _, _ in rows:
        outcomes[outcome or "pending"] = outcomes.get(outcome or "pending", 0) + 1
    waits = sorted(w for outcome, w, _ in rows if outcome == "voiced" and w is not None)
    print(f"\nlines: {len(shown)}, outcomes: {outcomes}, characters used: {used}")
    if waits:
        print(f"line to clip (voiced, s): p50 {waits[len(waits) // 2]:.2f}, p95 {waits[int(len(waits) * 0.95)]:.2f}, "
              f"max {waits[-1]:.2f}")
    for outcome, _, error in rows:
        if error:
            print(f"  {outcome}: {error}")
    return 0 if waits else 1


async def usage(conn: psycopg.AsyncConnection) -> int:
    row = await (await conn.execute(
        "select coalesce(sum(characters), 0) from narration.usage "
        "where month = date_trunc('month', now())::date and provider = 'elevenlabs'")).fetchone()
    return int(row[0])


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
