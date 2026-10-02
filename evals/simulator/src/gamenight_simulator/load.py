"""The load test: many rooms playing at once, each with its own host, TV and bots, against the full pipeline.

    uv run python -m gamenight_simulator --load 25 --games 50 --game mixed --game-master agents --voice

Each room is a worker with its own logins, client and database connection (rooms never share a session), taking
games from one queue until it's empty, so --load rooms play at once until --games have finished. The report checks
design.md's targets:
- tap -> own screen under 300 ms (p95): a player move's round trip (the phone redraws from the reply);
- phase complete -> next phase on every screen under 5 s (p95): the simulator's game-master wait, seen on the TV;
- narrate -> clip ready under 4 s (p95), with the voice service;
- 0 leaks, and at least 98% of games completed.
Leaks and completion always gate; the latency targets gate with --strict (they depend on the machine).
"""

import argparse
import asyncio
import random
import secrets
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import psycopg

from gamenight_simulator.game import GameReport, Player, play_game
from gamenight_simulator.referee import Referee
from gamenight_simulator.supabase import Supabase

KINDS = ["undercover", "quiz", "headsup"]
TARGETS = {"tap_to_own_screen_p95_ms": 300.0, "next_phase_p95_s": 5.0, "narrate_to_clip_p95_s": 4.0,
           "completion": 0.98}


@dataclass
class Load:
    reports: list[GameReport] = field(default_factory=list)
    move_ms: list[float] = field(default_factory=list)
    rooms_ready: int = 0


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * q))]


async def room(index: int, queue: "asyncio.Queue[int]", load: Load, args: argparse.Namespace, url: str, key: str,
               gm_url: str, names: list[str], agents: Any, say) -> None:
    """One room: its own host, TV, bots, client and connection; plays games from the queue until it's empty."""
    sb = Supabase(url, key)
    rng = random.Random(None if args.seed is None else args.seed + index)
    try:
        host = Player("Host", await sb.sign_up(f"load-{uuid.uuid4().hex[:12]}@gamenight.test",
                                               secrets.token_urlsafe(24), f"Load host {index}"), None)
        bots = [Player(name, await sb.sign_in_anonymously(), None) for name in names[: args.max_players - 1]]
        tv = Player("TV", await sb.sign_in_anonymously(), None)
        load.rooms_ready += 1
        async with await psycopg.AsyncConnection.connect(gm_url, autocommit=True, connect_timeout=10,
                                                         options="-c statement_timeout=10000") as conn:
            referee = Referee(conn, rng)
            while True:
                try:
                    number = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                for player in [host, *bots, tv]:
                    if player.session.expires_at - time.time() < 600:
                        player.session = await sb.refresh(player.session)
                kind = rng.choice(KINDS) if args.game == "mixed" else args.game
                report = await play_game(sb, referee, host, bots, tv, rng, number, args.min_players,
                                         args.max_players, args.stall_rate, agents, args.voice, kind)
                load.reports.append(report)
                say(index, report)
    finally:
        load.move_ms.extend(sb.move_ms)
        await sb.close()


async def run_load(args: argparse.Namespace, url: str, key: str, gm_url: str, names: list[str], agents: Any,
                   say) -> tuple[dict[str, Any], Load]:
    queue: asyncio.Queue[int] = asyncio.Queue()
    for number in range(1, args.games + 1):
        queue.put_nowait(number)
    load = Load()
    started = time.monotonic()
    # Rooms start a moment apart, as a real evening does (and the local stack's sign-up limits prefer it).
    async def staggered(i: int) -> None:
        await asyncio.sleep(i * 0.5)
        await room(i, queue, load, args, url, key, gm_url, names, agents, say)

    results = await asyncio.gather(*(staggered(i) for i in range(args.load)), return_exceptions=True)
    failures = [r for r in results if isinstance(r, BaseException)]
    return summarise(load, args, time.monotonic() - started, failures), load


def summarise(load: Load, args: argparse.Namespace, seconds: float, failures: list[BaseException]) -> dict[str, Any]:
    conclusive = [r for r in load.reports if not r.inconclusive]
    completion = sum(r.completed for r in conclusive) / max(len(conclusive), 1)
    waits = [s for r in conclusive for s in r.gm_seconds]
    clips = [s for r in conclusive for s in r.clip_seconds]
    measured = {
        "tap_to_own_screen_p95_ms": percentile(load.move_ms, 0.95),
        "next_phase_p95_s": percentile(waits, 0.95),
        "narrate_to_clip_p95_s": percentile(clips, 0.95),
        "completion": completion,
    }
    def met(name: str, v: float | None) -> bool | None:
        if v is None:
            return None
        return v >= TARGETS[name] if name == "completion" else v <= TARGETS[name]

    targets = {name: {"value": None if v is None else round(v, 3), "target": TARGETS[name], "met": met(name, v)}
               for name, v in measured.items()}
    by_kind = Counter(r.policy if r.policy in ("quiz", "headsup") else "undercover" for r in conclusive)
    return {
        "rooms_at_once": args.load,
        "rooms_started": load.rooms_ready,
        "room_failures": [repr(f)[:200] for f in failures],
        "games": len(load.reports),
        "conclusive": len(conclusive),
        "by_game": dict(by_kind),
        "players": sum(r.players for r in conclusive),
        "seconds": round(seconds, 1),
        "games_per_minute": round(len(conclusive) / max(seconds / 60, 1e-9), 2),
        "leaks": sum(len(r.leaks) for r in load.reports),
        "moves_timed": len(load.move_ms),
        "tap_to_own_screen_p50_ms": percentile(load.move_ms, 0.5),
        "next_phase_p50_s": percentile(waits, 0.5),
        "narrate_to_clip_p50_s": percentile(clips, 0.5),
        "targets": targets,
    }


def passed(summary: dict[str, Any], strict: bool) -> bool:
    """Leaks, completion and every room starting always gate; the latency targets only with --strict."""
    ok = summary["leaks"] == 0 and not summary["room_failures"] and bool(summary["targets"]["completion"]["met"])
    if strict:
        ok = ok and all(t["met"] is not False for t in summary["targets"].values())
    return ok


def markdown(summary: dict[str, Any], strict: bool) -> str:
    def show(value: Any, unit: str) -> str:
        if value is None:
            return "-"
        return {"%": f"{value:.0%}", "ms": f"{value:.0f} ms", "s": f"{value:.1f} s"}[unit]

    rows = [("Tap → own screen (p95)", "tap_to_own_screen_p95_ms", "ms"),
            ("Phase complete → next phase on the TV (p95)", "next_phase_p95_s", "s"),
            ("Narrate → clip ready (p95)", "narrate_to_clip_p95_s", "s"),
            ("Games completed", "completion", "%")]
    games = ", ".join(f"{n} {k}" for k, n in sorted(summary["by_game"].items()))
    mode = "strict" if strict else "targets report"
    lines = [f"## Load test: {summary['rooms_at_once']} rooms at once ({mode})", "",
             f"**{summary['conclusive']} games** ({games}), {summary['players']} players, in {summary['seconds']} s "
             f"({summary['games_per_minute']} games a minute) · **{summary['leaks']} leaks** · "
             f"{summary['moves_timed']} player moves timed", "",
             "| Target | Measured | Target | Met |", "|---|---|---|---|"]
    for title, key, unit in rows:
        t = summary["targets"][key]
        target = f"≥ {t['target']:.0%}" if unit == "%" else f"< {t['target']:g} {unit}"
        met = "-" if t["met"] is None else ("yes" if t["met"] else "**no**")
        lines.append(f"| {title} | {show(t['value'], unit)} | {target} | {met} |")
    if summary["room_failures"]:
        lines += ["", "Rooms that failed to start or crashed:", *[f"- {f}" for f in summary["room_failures"]]]
    return "\n".join(lines) + "\n"

