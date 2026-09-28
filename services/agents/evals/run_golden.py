"""Tier 1 golden evals: the real host agent and lobby welcome against 28 cases, with a Haiku judge.

Each case gets deterministic checks (tools called or not, text it must or mustn't contain, length) and a
1-5 judge score against its rubric. Report-only until slice 3: exits 0 unless the run itself breaks, or
with --gate when a hard check fails. Writes a Markdown summary ($GITHUB_STEP_SUMMARY in CI) and JSON.

Usage: uv run python -m evals.run_golden [--only ID ...] [--gate] [--out results.json]
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from evals.harness import Room, host_chat, welcome
from gamenight_agents.models import HOST_MODEL

CASES = Path(__file__).with_name("golden.jsonl")

JUDGE_SYSTEM = """You grade replies from the AI host of a party-game app. Score how well the reply meets the
rubric, from 1 (fails it) to 5 (fully meets it), and give a one-sentence reason.
Answer with JSON only: {"score": <1-5>, "reason": "..."}"""


def checks(case: dict[str, Any], reply: str, calls: list[str], announced: list[str]) -> list[str]:
    """The hard checks: returns what failed (empty means passed)."""
    failed = []
    for name in case.get("must_call", []):
        if name not in calls:
            failed.append(f"didn't call {name}")
    for name in case.get("must_not_call", []):
        if name in calls:
            failed.append(f"called {name}")
    if case.get("must_include_any") and not any(s.lower() in reply.lower() for s in case["must_include_any"]):
        failed.append(f"mentions none of {case['must_include_any']}")
    for s in case.get("must_not_include", []):
        if s.lower() in reply.lower():
            failed.append(f"contains {s!r}")
    if case.get("max_chars") and len(reply) > case["max_chars"]:
        failed.append(f"{len(reply)} characters (max {case['max_chars']})")
    if case.get("must_announce") and not announced:
        failed.append("put nothing on the TV")
    return failed


async def judge(case: dict[str, Any], reply: str) -> tuple[int, str]:
    from langchain_anthropic import ChatAnthropic

    model = ChatAnthropic(model=HOST_MODEL, max_tokens=200, temperature=0)
    subject = case.get("question") or f"(lobby welcome for players named {case.get('names')})"
    answer = await model.ainvoke([
        SystemMessage(JUDGE_SYSTEM),
        HumanMessage(f"Rubric: {case['rubric']}\n\nHost was asked: {subject}\n\nReply:\n{reply}"),
    ])
    text = str(answer.content).strip().removeprefix("```json").removesuffix("```").strip()
    try:
        verdict = json.loads(text)
        return int(verdict["score"]), str(verdict["reason"])
    except (ValueError, KeyError):
        return 0, f"judge gave no verdict: {text[:120]}"


async def run_case(case: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        if case["suite"] == "host_chat":
            room = case["room"]
            result = await host_chat(case["question"], Room(room["players"], room.get("rating", "family"),
                                                            room.get("tv_connected", True)))
        else:
            result = await welcome(case["names"], case.get("rating", "family"))
    except Exception as error:  # a crash is a result too, and must show in the report
        return {"id": case["id"], "suite": case["suite"], "error": repr(error), "failed": ["crashed"], "score": 0}
    calls = [c["name"] for c in result.tool_calls]
    failed = checks(case, result.reply, calls, result.announced)
    score, reason = await judge(case, result.reply)
    return {
        "id": case["id"], "suite": case["suite"], "reply": result.reply, "tools": calls,
        "announced": result.announced, "failed": failed, "score": score, "reason": reason,
        "seconds": round(time.monotonic() - started, 1),
    }


def summary(results: list[dict[str, Any]]) -> str:
    passed = sum(not r["failed"] for r in results)
    scores = [r["score"] for r in results if r["score"]]
    lines = [
        "## Tier 1 golden evals (report-only)",
        "",
        f"**{passed}/{len(results)} passed the hard checks** · mean judge score "
        f"**{sum(scores) / max(len(scores), 1):.2f}/5** · model `{HOST_MODEL}`",
        "",
        "| Case | Suite | Hard checks | Judge | Tools |",
        "|---|---|---|---|---|",
    ]
    for r in results:
        status = "pass" if not r["failed"] else "FAIL: " + "; ".join(r["failed"])
        tools = ", ".join(r.get("tools", [])) or "-"
        lines.append(f"| {r['id']} | {r['suite']} | {status} | {r['score']}/5 | {tools} |")
    return "\n".join(lines) + "\n"


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", help="run only these case ids")
    parser.add_argument("--gate", action="store_true", help="exit 1 when any hard check fails")
    parser.add_argument("--out", default="golden-results.json")
    args = parser.parse_args()

    cases = [json.loads(line) for line in CASES.read_text().splitlines() if line.strip()]
    if args.only:
        cases = [c for c in cases if c["id"] in args.only]
    # A few at a time: fast enough, and gentle on rate limits.
    semaphore = asyncio.Semaphore(4)

    async def bounded(case):
        async with semaphore:
            return await run_case(case)

    results = await asyncio.gather(*(bounded(c) for c in cases))
    Path(args.out).write_text(json.dumps(results, indent=2))
    report = summary(results)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as handle:
            handle.write(report)
    return 1 if args.gate and any(r["failed"] for r in results) else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
