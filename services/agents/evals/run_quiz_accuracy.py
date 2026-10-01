"""Quiz accuracy: the question verifier against 41 hand-checked candidates, and fresh questions from the generator.

The golden set (quiz_accuracy.jsonl) is real questions with their real Wikipedia sentences, keyed right, and broken
copies of them: a wrong option keyed, true and false flipped, an invented or misattributed quote, two right options,
an ambiguous or dated question, a sentence that doesn't say the answer, a question telling the judge to pass it.
Each broken one is tagged with the layer that must drop it: the code (source, quote and shape checks) or the judge.

Gate (--gate): no broken question is kept (a wrongly keyed question reaching a game is the failure that matters),
and at least 80% of the good ones are kept (so a verifier that drops everything fails too).

--code-only runs the code layer alone, with a judge that passes everything: free, no model key, and the judge's
cases are skipped. It still fetches the articles from Wikipedia.
--generate TOPIC ... also generates fresh questions for those topics and reports what was kept and why the rest
were dropped (report-only: what the generator writes changes run to run).

Usage: uv run python -m evals.run_quiz_accuracy [--code-only] [--only ID ...] [--gate] [--generate TOPIC ...]
       [--out quiz-accuracy-results.json]
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from gamenight_agents import quiz_content
from gamenight_agents.leakcheck import says_number
from gamenight_agents.models import GAME_MASTER_MODEL
from gamenight_agents.quiz_content import Candidate, Verdict

CASES = Path(__file__).with_name("quiz_accuracy.jsonl")
KEEP_RATE = 0.8
RATING = "family"


async def pass_everything(*_args) -> Verdict:
    return Verdict(supported=True, single_answer=True, unambiguous=True, lasting=True, fits_rating=True,
                   reason="code-only run: no judge")


def candidate(case: dict[str, Any]) -> Candidate:
    return Candidate.model_validate({k: v for k, v in case.items() if k not in ("id", "expect", "by", "why")})


async def check(http: httpx.AsyncClient, case: dict[str, Any], judge_fn) -> dict[str, Any]:
    started = time.monotonic()
    try:
        question, why = await quiz_content.verify(http, candidate(case), RATING, judge_fn=judge_fn)
    except Exception as error:  # an error is a result: it fails the gate, and the other cases still run
        return {"id": case["id"], "expect": case["expect"], "by": case.get("by"), "kept": None,
                "why": f"couldn't check it: {error!r}", "failed": [f"errored: {error!r}"]}
    kept = question is not None
    failed = []
    if case["expect"] == "drop" and kept:
        failed.append(f"KEPT a broken question ({case['why']})")
    if case["expect"] == "drop" and not kept and case["by"] == "code" and why.startswith("the judge"):
        failed.append("only the judge caught what the code should have")
    return {"id": case["id"], "expect": case["expect"], "by": case.get("by"), "kept": kept, "why": why,
            "failed": failed, "seconds": round(time.monotonic() - started, 1)}


def answer_in_sentence(q: dict[str, Any]) -> bool:
    """A cheap second look at a kept question: does its source sentence literally contain the keyed answer?"""
    sentence = q["source_quote"].lower()
    if q["kind"] == "choice":
        return q["options"][q["answer"]["option"]].lower() in sentence
    if q["kind"] == "estimate":
        return says_number(q["source_quote"], q["answer"]["value"])
    return True  # true or false: the sentence may state the opposite, which is the point


async def fresh(http: httpx.AsyncClient, topic: str) -> dict[str, Any]:
    need = {k: 2 for k in quiz_content.KINDS}
    try:
        candidates = await quiz_content.generate(topic, RATING, need)
    except Exception as error:  # report-only: say what went wrong, don't stop the run
        return {"topic": topic, "candidates": 0, "kept": [], "dropped": [], "error": repr(error)}
    kept, dropped = [], []
    for c in candidates:
        try:
            question, why = await quiz_content.verify(http, c, RATING)
        except (httpx.HTTPError, ValueError) as error:
            question, why = None, f"couldn't check it: {error!r}"
        if question:
            kept.append(question | {"answer_in_sentence": answer_in_sentence(question)})
        else:
            dropped.append({"prompt": c.prompt, "why": why})
    return {"topic": topic, "candidates": len(candidates), "kept": kept, "dropped": dropped}


def summary(results: list[dict[str, Any]], generated: list[dict[str, Any]], gated: bool, code_only: bool) -> str:
    good = [r for r in results if r["expect"] == "keep"]
    broken = [r for r in results if r["expect"] == "drop"]
    kept_good = sum(bool(r["kept"]) for r in good)
    wrongly_kept = sum(bool(r["kept"]) for r in broken)
    judge = "no judge (code only)" if code_only else f"judge `{GAME_MASTER_MODEL}`"
    lines = [
        f"## Quiz accuracy ({'gate' if gated else 'report-only'})",
        "",
        f"**{wrongly_kept} broken questions kept** (of {len(broken)}) · {kept_good}/{len(good)} good ones kept · "
        f"{judge}",
        "",
        "| Case | Expected | Result | Why |",
        "|---|---|---|---|",
    ]
    for r in results:
        expected = "keep" if r["expect"] == "keep" else f"drop ({r['by']})"
        result = "FAIL: " + "; ".join(r["failed"]) if r["failed"] else ("kept" if r["kept"] else "dropped")
        lines.append(f"| {r['id']} | {expected} | {result} | {r['why'].replace('|', '/')[:140]} |")
    for g in generated:
        unsure = sum(not q["answer_in_sentence"] for q in g["kept"])
        if g.get("error"):
            lines += ["", f"### Fresh questions: {g['topic']}", "", f"Couldn't generate: {g['error'][:300]}"]
            continue
        lines += ["", f"### Fresh questions: {g['topic']}", "",
                  f"{len(g['kept'])}/{g['candidates']} kept · {unsure} kept with the answer not literally in the "
                  "sentence (check by hand)", ""]
        lines += [f"- kept: {q['prompt']} → {json.dumps(q['answer'])} ({q['source_url']})" for q in g["kept"]]
        lines += [f"- dropped: {d['prompt']} ({d['why'][:140]})" for d in g["dropped"]]
    return "\n".join(lines) + "\n"


def gate_failures(results: list[dict[str, Any]]) -> list[str]:
    good = [r for r in results if r["expect"] == "keep"]
    failures = [f"{r['id']}: {'; '.join(r['failed'])}" for r in results if r["failed"]]
    if good and sum(bool(r["kept"]) for r in good) / len(good) < KEEP_RATE:
        failures.append(f"kept fewer than {KEEP_RATE:.0%} of the good questions")
    return failures


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", help="run only these case ids")
    parser.add_argument("--code-only", action="store_true", help="the code checks alone: no model, no key")
    parser.add_argument("--generate", nargs="*", default=[], help="also generate fresh questions for these topics")
    parser.add_argument("--gate", action="store_true", help="exit 1 if a broken question is kept")
    parser.add_argument("--out", default="quiz-accuracy-results.json")
    args = parser.parse_args()

    cases = [json.loads(line) for line in CASES.read_text().splitlines() if line.strip()]
    if args.only:
        cases = [c for c in cases if c["id"] in args.only]
    if args.code_only:
        cases = [c for c in cases if c.get("by") != "judge"]
    judge_fn = pass_everything if args.code_only else None
    semaphore = asyncio.Semaphore(2)  # polite to Wikipedia

    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": quiz_content.USER_AGENT}) as http:
        async def bounded(case):
            async with semaphore:
                return await check(http, case, judge_fn)

        results = await asyncio.gather(*(bounded(c) for c in cases))
        generated = [] if args.code_only else [await fresh(http, topic) for topic in args.generate]

    Path(args.out).write_text(json.dumps({"cases": results, "generated": generated}, indent=2))
    report = summary(results, generated, args.gate, args.code_only)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write(report)
    failures = gate_failures(results)
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    return 1 if args.gate and failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
