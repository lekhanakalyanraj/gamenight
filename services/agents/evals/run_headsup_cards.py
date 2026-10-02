"""Heads Up card review: the reviewer against hand-checked cards, and fresh decks from the writer.

The golden set (headsup_cards.jsonl) groups cards by interest and room rating: good cards, and bad ones a deck must
never deal: a private person, something that doesn't suit a family room, a sentence or a list instead of one thing,
something far too obscure, and cards that try to instruct the reviewer. Each group goes through the review in one
batch, as a real deck does.

Gate (--gate): no bad card is kept, at least 80% of the good ones are, and with --generate at least one fresh card is
kept (the writer and the reviewer working together).

Usage: uv run python -m evals.run_headsup_cards [--gate] [--generate INTEREST ...] [--out headsup-cards-results.json]
"""

import argparse
import asyncio
import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from gamenight_agents import headsup_content
from gamenight_agents.models import GAME_MASTER_MODEL

CASES = Path(__file__).with_name("headsup_cards.jsonl")
KEEP_RATE = 0.8


async def review_group(key: tuple[str, str, str | None], cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    interest, rating, region = key
    try:
        verdicts = await headsup_content.review(interest, [c["card"] for c in cases], rating, region)
    except Exception as error:  # an error is a result: it fails the gate, and the other groups still run
        return [c | {"kept": None, "reason": f"errored: {error!r}"} for c in cases]
    out = []
    for c in cases:
        v = verdicts.get(c["card"].lower())
        out.append(c | {"kept": bool(v and v.keep), "reason": v.reason if v else "not reviewed"})
    return out


async def fresh(interest: str) -> dict[str, Any]:
    try:
        cards = await headsup_content.write(interest, "family", None, headsup_content.WRITE)
        verdicts = await headsup_content.review(interest, cards, "family", None)
    except Exception as error:
        return {"interest": interest, "cards": 0, "kept": [], "dropped": [], "error": repr(error)}
    kept = [c for c in cards if (v := verdicts.get(c.lower())) and v.keep]
    dropped = [f"{c}: {verdicts[c.lower()].reason if c.lower() in verdicts else 'not reviewed'}"
               for c in cards if c not in kept]
    return {"interest": interest, "cards": len(cards), "kept": kept, "dropped": dropped}


def gate_failures(results: list[dict[str, Any]], generated: list[dict[str, Any]]) -> list[str]:
    failures = [f"KEPT a bad card: {r['card']} ({r['why']})" for r in results if r["expect"] == "drop" and r["kept"]]
    failures += [f"{r['card']}: {r['reason']}" for r in results if r["kept"] is None]
    good = [r for r in results if r["expect"] == "keep"]
    if good and sum(bool(r["kept"]) for r in good) / len(good) < KEEP_RATE:
        failures.append(f"kept fewer than {KEEP_RATE:.0%} of the good cards")
    if generated and not any(g["kept"] for g in generated):
        failures.append("fresh decks: no card kept for any interest")
    return failures


def summary(results: list[dict[str, Any]], generated: list[dict[str, Any]], gated: bool) -> str:
    good = [r for r in results if r["expect"] == "keep"]
    bad = [r for r in results if r["expect"] == "drop"]
    lines = [f"## Heads Up card review ({'gate' if gated else 'report-only'})", "",
             f"**{sum(bool(r['kept']) for r in bad)} bad cards kept** (of {len(bad)}) · "
             f"{sum(bool(r['kept']) for r in good)}/{len(good)} good ones kept · reviewer `{GAME_MASTER_MODEL}`", "",
             "| Interest | Card | Expected | Result | Reason |", "|---|---|---|---|---|"]
    for r in results:
        wrong = (r["expect"] == "drop" and r["kept"]) or (r["expect"] == "keep" and not r["kept"])
        result = ("kept" if r["kept"] else "dropped") + (" (WRONG)" if wrong else "")
        lines.append(f"| {r['interest']} ({r['rating']}) | {r['card']} | {r['expect']} | {result} | "
                     f"{(r['reason'] or '').replace('|', '/')[:80]} |")
    for g in generated:
        lines += ["", f"### Fresh deck: {g['interest']}", ""]
        if g.get("error"):
            lines.append(f"Couldn't build it: {g['error'][:300]}")
            continue
        lines.append(f"{len(g['kept'])}/{g['cards']} kept: {', '.join(g['kept'])}")
        lines += [f"- dropped: {d[:120]}" for d in g["dropped"]]
    return "\n".join(lines) + "\n"


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gate", action="store_true", help="exit 1 if a bad card is kept")
    parser.add_argument("--generate", nargs="*", default=[], help="also build fresh decks for these interests")
    parser.add_argument("--out", default="headsup-cards-results.json")
    args = parser.parse_args()

    cases = [json.loads(line) for line in CASES.read_text().splitlines() if line.strip()]
    groups: dict[tuple[str, str, str | None], list[dict[str, Any]]] = defaultdict(list)
    for c in cases:
        groups[(c["interest"], c["rating"], c.get("region"))].append(c)
    results = [r for batch in await asyncio.gather(*(review_group(k, v) for k, v in groups.items())) for r in batch]
    generated = [await fresh(i) for i in args.generate]

    Path(args.out).write_text(json.dumps({"cases": results, "generated": generated}, indent=2))
    report = summary(results, generated, args.gate)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write(report)
    failures = gate_failures(results, generated)
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    return 1 if args.gate and failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
