"""Play simulated games against the local stack and report completion, rule checks and leaks.

    uv run python -m gamenight_simulator --games 20

Needs the local Supabase stack (make db-start). Settings come from the environment, with local defaults:
SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (required), GAME_MASTER_DATABASE_URL, DISPATCHER_DATABASE_URL.
Exits non-zero if any game leaked, didn't finish, or broke a rule check.
"""

import argparse
import asyncio
import contextlib
import dataclasses
import json
import os
import random
import secrets
import sys
import time
import uuid
from collections import Counter

import psycopg

from gamenight_simulator.game import Player, play_game
from gamenight_simulator.referee import Referee
from gamenight_simulator.supabase import Supabase

LOCAL_DB = "127.0.0.1:55422/postgres"
NAMES = ["Asha", "Ben", "Chen", "Dev", "Ema", "Farah", "Gio", "Hana", "Ivan", "Jay", "Kiko", "Leo", "Mira", "Nia",
         "Omar"]


async def tick_deadlines(database_url: str) -> None:
    """Fires game timers as the dispatcher does, so the simulator needs only the database."""
    async with await psycopg.AsyncConnection.connect(database_url, autocommit=True) as conn:
        while True:
            await conn.execute("select dispatch.fire_due_deadlines()")
            await asyncio.sleep(0.5)


async def run(args: argparse.Namespace) -> int:
    url = os.environ.get("SUPABASE_URL", "http://127.0.0.1:55421")
    key = os.environ["SUPABASE_PUBLISHABLE_KEY"]
    gm_url = os.environ.get("GAME_MASTER_DATABASE_URL", f"postgresql://game_master_svc:local-dev-game-master@{LOCAL_DB}")
    dispatcher_url = os.environ.get("DISPATCHER_DATABASE_URL",
                                    f"postgresql://dispatcher_svc:local-dev-dispatcher@{LOCAL_DB}")
    rng = random.Random(args.seed)
    sb = Supabase(url, key)

    # One host account (fresh each run, with a throwaway password) and one pool of guests and a TV, reused
    # across games to stay well inside the local stack's sign-up rate limits.
    email = f"sim-{uuid.uuid4().hex[:12]}@gamenight.test"
    host_session = await sb.sign_up(email, secrets.token_urlsafe(24), "Simulator")
    sessions = [await sb.sign_in_anonymously() for _ in range(len(NAMES) + 1)]

    async with contextlib.AsyncExitStack() as stack:
        host = Player("Host", host_session, None)
        bots = [Player(name, session, None) for name, session in zip(NAMES, sessions, strict=False)]
        tv = Player("TV", sessions[-1], None)
        conn = await stack.enter_async_context(await psycopg.AsyncConnection.connect(
            gm_url, autocommit=True, connect_timeout=10, options="-c statement_timeout=10000"))
        referee = Referee(conn, rng)
        ticker = asyncio.create_task(tick_deadlines(dispatcher_url))

        reports = []
        attempts = args.games + max(3, args.games // 5)  # room to replay the games Realtime interrupted
        for number in range(1, attempts + 1):
            if sum(not r.inconclusive for r in reports) == args.games:
                break
            for player in [host, *bots, tv]:  # keep every login fresh for at least one more game
                if player.session.expires_at - time.time() < 600:
                    player.session = await sb.refresh(player.session)
            report = await play_game(sb, referee, host, bots, tv, rng, number, args.min_players, args.max_players,
                                     args.stall_rate)
            reports.append(report)
            status = "skip" if report.inconclusive and not report.leaks and not report.errors else (
                "ok  " if report.completed and not report.leaks else "FAIL")
            print(f"{status} game {number:>3}: {report.players:>2} players, {report.policy:<6} "
                  f"{'staller ' if report.staller else ''}-> {report.winner or '-'} in {report.rounds} rounds, "
                  f"{report.seconds} s", flush=True)
            for problem in report.leaks + report.errors + [report.inconclusive or ""]:
                if not problem:
                    continue
                print(f"       {problem}", flush=True)
        ticker.cancel()
    await sb.close()

    leaks = sum(len(r.leaks) for r in reports)  # a leak counts even in an inconclusive game
    conclusive = [r for r in reports if not r.inconclusive]
    completed = sum(r.completed for r in conclusive)
    summary = {
        "games": len(conclusive),
        "completed": completed,
        "inconclusive_replayed": len(reports) - len(conclusive),
        "leaks": leaks,
        "illegal_moves_refused": sum(r.illegal_refused for r in reports),
        "referee_moves": referee.moves,
        "referee_replays_checked": referee.replays,
        "referee_illegal_refused": referee.illegal_refused,
        "late_moves": sum(r.late_moves for r in reports),
        "winners": dict(Counter(r.winner or "none" for r in reports)),
        "average_seconds": round(sum(r.seconds for r in conclusive) / max(len(conclusive), 1), 1),
    }
    print(json.dumps(summary, indent=2))
    if args.report:
        with open(args.report, "w") as out:
            json.dump({"summary": summary, "games": [dataclasses.asdict(r) for r in reports]}, out, indent=2)
    return 0 if leaks == 0 and len(conclusive) == args.games and completed == args.games else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--games", type=int, default=20)
    parser.add_argument("--seed", type=int, default=None, help="repeat a run's choices")
    parser.add_argument("--min-players", type=int, default=3)
    parser.add_argument("--max-players", type=int, default=10)
    parser.add_argument("--stall-rate", type=float, default=0.1, help="share of games with a player who stalls")
    parser.add_argument("--report", help="write a JSON report here")
    args = parser.parse_args()
    if not 3 <= args.min_players <= args.max_players <= len(NAMES) + 1:
        parser.error(f"players must be between 3 and {len(NAMES) + 1}")
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
