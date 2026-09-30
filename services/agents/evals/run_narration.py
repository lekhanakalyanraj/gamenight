"""Narration eval: the real game master narrating 14 moments of a game, measured before it's tuned.

For each moment: hard checks (no leak, at most 200 characters a line, a line when one is expected, the game left
moving, no end announced early), how many of its lines the narrator rejected and why, and a Haiku judge's 1-5
score for the persona rubric. The judge score is model-graded, so it reports; the hard checks gate with --gate.

Usage: uv run python -m evals.run_narration [--only ID ...] [--gate] [--out narration-results.json]
"""

import argparse
import asyncio
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from evals import game_harness as h
from evals.run_leak_attacks import grade
from gamenight_agents.models import GAME_MASTER_MODEL

MOMENTS: dict[str, tuple[Any, bool]] = {  # id: (the moment, whether a line is expected)
    "opening": (h.game_started, True),
    "civilian-out": (lambda: h.vote_out("Ben"), True),
    "undercover-out": (lambda: h.vote_out("Asha"), True),
    "mr-white-caught": (lambda: h.vote_out("Chen"), True),
    "tie": (h.vote_tied, True),
    "clues-in": (h.clues_done, False),
    "discussion-over": (h.discussion_over, False),
    "guess-judged": (lambda: h.guess_in("maple syrup"), False),
    "wrong-guess-stands": (h.guess_settled_wrong, True),
    "finale-civilians": (lambda: h.game_over("civilians"), True),
    "finale-infiltrators": (lambda: h.game_over("infiltrators"), True),
    "finale-mr-white": (lambda: h.game_over("mr_white"), True),
    "finale-host-ended": (lambda: h.game_over(None), True),
    "late-round": (lambda: h.vote_out("Dara"), True),
}

RUBRIC = """Grade what the AI game master said on the TV at this moment of a party game of Undercover. The persona
is a sly detective: teasing, suspicious, playful, with short punchy lines that build suspense.
While the game is on it must give nothing away: no secret word, no hint at it, and no role of a player still in.
Public, and fine to say: who was just voted out and their role (the TV shows it), the theme, and how many of each
role there are. Once the game is over ("finale-" moments) it should reveal: naming the words, the roles and the
winners is expected there, not a leak.
Score 1 (flat, off-persona, or gives a secret away) to 5 (in character, fun, and gives nothing away), with a
one-sentence reason. If nothing was said, grade whether silence suited the moment.
Answer with JSON only: {"score": <1-5>, "reason": "..."}"""


async def judge(moment_id: str, lines: list[str]) -> tuple[int, str]:
    from langchain_anthropic import ChatAnthropic

    model = ChatAnthropic(model=GAME_MASTER_MODEL, max_tokens=200, temperature=0)
    said = "\n".join(lines) or "(nothing)"
    prompt = f"Moment: {moment_id}\n\nSaid on the TV:\n{said}"
    answer = await model.ainvoke([SystemMessage(RUBRIC), HumanMessage(prompt)])
    text = str(answer.content).strip().removeprefix("```json").removesuffix("```").strip()
    try:
        verdict = json.loads(text)
        return int(verdict["score"]), str(verdict["reason"])
    except (ValueError, KeyError):
        return 0, f"judge gave no verdict: {text[:120]}"


async def run(moment_id: str) -> dict[str, Any]:
    build, expect_line = MOMENTS[moment_id]
    state, events, vote = build()
    outcome = await h.play(state, events, vote)
    failed = grade({}, outcome)
    failed += [f"line of {len(line)} characters" for line in outcome.shown if len(line) > 200]
    if expect_line and not outcome.shown:
        failed.append("said nothing")
    rejected = [a for a in outcome.attempts if not a.get("shown") or a.get("note")]
    score, reason = await judge(moment_id, outcome.shown)
    return {"id": moment_id, "failed": failed, "shown": outcome.shown, "attempted": len(outcome.attempts),
            "rejected": [{"line": a["line"], "why": a.get("rejected") or a.get("note")} for a in rejected],
            "refused": outcome.refused, "stalls_caught": outcome.stalls_caught, "score": score, "reason": reason,
            "model_calls": outcome.model_calls}


def summary(results: list[dict[str, Any]], gated: bool) -> str:
    attempted = sum(r["attempted"] for r in results)
    rejected = sum(len(r["rejected"]) for r in results)
    scores = [r["score"] for r in results if r["score"]]
    why = Counter(("reviewer" if "reviewer" in str(x["why"]) else "leak check" if "secret word" in str(x["why"])
                   or "role" in str(x["why"]) else "other") for r in results for x in r["rejected"])
    lines = [
        f"## Narration ({'hard checks gate' if gated else 'report-only'}; judge score reports)",
        "",
        f"**{sum(not r['failed'] for r in results)}/{len(results)} passed** · mean judge **"
        f"{sum(scores) / max(len(scores), 1):.2f}/5** · **{rejected}/{attempted} lines rejected** "
        f"({', '.join(f'{k}: {v}' for k, v in why.items()) or 'none'}) · "
        f"**{sum(r['stalls_caught'] for r in results)} stalls caught** by the follow-up · model `{GAME_MASTER_MODEL}`",
        "",
        "| Moment | Checks | Judge | Said on the TV |",
        "|---|---|---|---|",
    ]
    for r in results:
        checks = "pass" if not r["failed"] else "FAIL: " + "; ".join(r["failed"])
        said = " / ".join(r["shown"]).replace("|", "\\|")[:160] or "-"
        lines.append(f"| {r['id']} | {checks} | {r['score']}/5 | {said} |")
    return "\n".join(lines) + "\n"


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", help="run only these moments")
    parser.add_argument("--gate", action="store_true", help="exit 1 when any hard check fails")
    parser.add_argument("--out", default="narration-results.json")
    args = parser.parse_args()
    ids = args.only or list(MOMENTS)
    semaphore = asyncio.Semaphore(4)

    async def bounded(moment_id):
        async with semaphore:
            return await run(moment_id)

    results = await asyncio.gather(*(bounded(m) for m in ids))
    Path(args.out).write_text(json.dumps(results, indent=2))
    report = summary(results, args.gate)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write(report)
    return 1 if args.gate and any(r["failed"] for r in results) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
