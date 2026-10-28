"""Quiz fun: does the judge tell a party question from a textbook one, and does the blind solve catch broken teasers?

The golden set (quiz_fun.jsonl):
- 12 dull questions, correct but no fun (textbook recall, raw statistics, the obvious): the judge's fun score must
  fall under the bar (quiz_content.FUN_BAR), so the generator's dull questions are dropped;
- 12 good ones (which is NOT, believable fakes, surprising links, reason-it-out estimates): they must clear it;
- 7 brain teasers, 4 sound and 3 broken (keyed wrong, two right answers, arguable): the two blind solves must keep
  the sound ones and drop every broken one.
Each fact is judged on its own passage (given here, not fetched), so this costs only the judge's calls.

Gate (--gate): at most 1 dull question clears the bar, at least 10 of the 12 good ones do, no broken teaser is kept,
and at least 3 of the 4 sound ones are (model judgement varies a little run to run; a broken teaser kept is the
failure that matters).

Usage: uv run python -m evals.run_quiz_fun [--gate] [--only ID ...] [--out quiz-fun-results.json]
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from gamenight_agents import quiz_content
from gamenight_agents.models import GAME_MASTER_MODEL
from gamenight_agents.quiz_content import Candidate

CASES = Path(__file__).with_name("quiz_fun.jsonl")
RATING = "family"
GATES = {"dull_cleared_at_most": 1, "fun_cleared_at_least": 10, "broken_teasers_kept": 0, "sound_teasers_at_least": 3}


async def check(case: dict[str, Any]) -> dict[str, Any]:
    c = Candidate.model_validate({k: v for k, v in case.items() if k not in ("id", "expect", "why")})
    try:
        if c.kind == "teaser":
            question, why = await quiz_content.verify_teaser(c, RATING)
            return {"id": case["id"], "expect": case["expect"], "kept": question is not None, "why": why,
                    "fun": question["fun"] if question else None}
        verdict = await quiz_content.judge(c, case["source_sentence"], RATING)
    except Exception as error:  # an error is a result: it fails the gate, and the other cases still run
        return {"id": case["id"], "expect": case["expect"], "kept": None, "why": f"errored: {error!r}", "fun": None}
    return {"id": case["id"], "expect": case["expect"], "kept": verdict.fun >= quiz_content.FUN_BAR,
            "fun": verdict.fun, "why": verdict.reason}


def tally(results: list[dict[str, Any]]) -> dict[str, int]:
    def count(expect, kept=True):
        return sum(r["expect"] == expect and r["kept"] is kept for r in results)
    return {"dull_cleared": count("dull"), "dull": sum(r["expect"] == "dull" for r in results),
            "fun_cleared": count("fun"), "fun": sum(r["expect"] == "fun" for r in results),
            "broken_teasers_kept": count("drop"), "broken_teasers": sum(r["expect"] == "drop" for r in results),
            "sound_teasers_kept": count("keep"), "sound_teasers": sum(r["expect"] == "keep" for r in results),
            "errored": sum(r["kept"] is None for r in results)}


def gate_failures(t: dict[str, int]) -> list[str]:
    failures = []
    if t["dull_cleared"] > GATES["dull_cleared_at_most"]:
        failures.append(f"{t['dull_cleared']} dull questions cleared the fun bar")
    if t["fun"] and t["fun_cleared"] < min(GATES["fun_cleared_at_least"], t["fun"]):
        failures.append(f"only {t['fun_cleared']} of {t['fun']} good questions cleared the fun bar")
    if t["broken_teasers_kept"] > GATES["broken_teasers_kept"]:
        failures.append(f"{t['broken_teasers_kept']} broken brain teasers kept")
    if t["sound_teasers"] and t["sound_teasers_kept"] < min(GATES["sound_teasers_at_least"], t["sound_teasers"]):
        failures.append(f"only {t['sound_teasers_kept']} of {t['sound_teasers']} sound brain teasers kept")
    if t["errored"]:
        failures.append(f"{t['errored']} cases errored")
    return failures


def summary(results: list[dict[str, Any]], t: dict[str, int], gated: bool) -> str:
    lines = [f"## Quiz fun ({'gate' if gated else 'report-only'})", "",
             f"Dull questions clearing the bar: **{t['dull_cleared']}/{t['dull']}** · good ones: "
             f"**{t['fun_cleared']}/{t['fun']}** · broken teasers kept: **{t['broken_teasers_kept']}/"
             f"{t['broken_teasers']}** · sound teasers kept: {t['sound_teasers_kept']}/{t['sound_teasers']} · "
             f"judge `{GAME_MASTER_MODEL}`, bar {quiz_content.FUN_BAR}/5", "",
             "| Case | Expected | Fun | Kept | Why |", "|---|---|---|---|---|"]
    for r in results:
        lines.append(f"| {r['id']} | {r['expect']} | {r['fun'] if r['fun'] is not None else '-'} | {r['kept']} | "
                     f"{(r['why'] or '').replace('|', '/')[:140]} |")
    return "\n".join(lines) + "\n"


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", help="run only these case ids")
    parser.add_argument("--gate", action="store_true", help="exit 1 if a gate fails")
    parser.add_argument("--out", default="quiz-fun-results.json")
    args = parser.parse_args()

    cases = [json.loads(line) for line in CASES.read_text().splitlines() if line.strip()]
    if args.only:
        cases = [c for c in cases if c["id"] in args.only]
    semaphore = asyncio.Semaphore(4)

    async def bounded(case):
        async with semaphore:
            return await check(case)

    results = await asyncio.gather(*(bounded(c) for c in cases))
    t = tally(results)
    Path(args.out).write_text(json.dumps({"cases": results, "tally": t}, indent=2))
    report = summary(results, t, args.gate)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write(report)
    failures = gate_failures(t)
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    return 1 if args.gate and failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
