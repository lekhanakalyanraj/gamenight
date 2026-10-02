"""One report for an evals run: every suite's gate, how many cases passed, and its key number.

Reads the result files the eval runners write (services/agents/*-results.json, as the evals job saves them) from a
directory, and prints a Markdown table. The evals job appends it to its run summary; the README's "Eval results" is
the latest one from main.

    python3 scripts/eval-report.py services/agents             # in CI, after the evals
    gh run download <run> -n evals -D /tmp/evals && python3 scripts/eval-report.py /tmp/evals
"""

import json
import sys
from pathlib import Path
from typing import Any


def find(root: Path, name: str) -> Any:
    hits = sorted(root.rglob(name))
    return json.loads(hits[0].read_text()) if hits else None


def rows(root: Path) -> list[tuple[str, str, str, str]]:
    """(suite, gate, passed, key number) for each result file present."""
    out = []
    golden = find(root, "golden-results.json")
    if golden is not None:
        cases = golden if isinstance(golden, list) else golden.get("results", golden.get("cases", []))
        hard = sum(not c.get("failed") for c in cases)
        scores = [c["score"] for c in cases if isinstance(c.get("score"), int | float)]
        mean = f"judge mean {sum(scores) / len(scores):.1f}/5" if scores else ""
        out.append(("Golden (host chat, lobby)", "hard checks", f"{hard}/{len(cases)}", mean))
    for file, suite in (("leak-results.json", "Leak attacks: Undercover game master"),
                        ("quiz-leak-results.json", "Leak attacks: quiz master"),
                        ("headsup-attack-results.json", "Attacks: Heads Up commentator"),
                        ("narration-results.json", "Narration (14 moments)")):
        results = find(root, file)
        if results is None:
            continue
        held = sum(not r.get("failed") for r in results)
        calls = sum(r.get("model_calls") or 0 for r in results)
        out.append((suite, "every case", f"{held}/{len(results)}", f"{calls} model calls" if calls else ""))
    quiz = find(root, "quiz-accuracy-results.json")
    if quiz is not None:
        cases = quiz["cases"]
        bad = [c for c in cases if c["expect"] == "drop"]
        good = [c for c in cases if c["expect"] == "keep"]
        fresh = ", ".join(f"{g['topic']} {len(g['kept'])} kept" for g in quiz.get("generated", []))
        out.append(("Quiz accuracy", "no broken question kept",
                    f"{len(bad) - sum(bool(c['kept']) for c in bad)}/{len(bad)} broken dropped",
                    f"{sum(bool(c['kept']) for c in good)}/{len(good)} good kept" + (f"; fresh: {fresh}" if fresh else "")))
    cards = find(root, "headsup-cards-results.json")
    if cards is not None:
        cases = cards["cases"]
        bad = [c for c in cases if c["expect"] == "drop"]
        good = [c for c in cases if c["expect"] == "keep"]
        fresh = ", ".join(f"{g['interest']} {len(g['kept'])}/{g['cards']}" for g in cards.get("generated", []))
        out.append(("Heads Up card review", "no bad card kept",
                    f"{len(bad) - sum(bool(c['kept']) for c in bad)}/{len(bad)} bad dropped",
                    f"{sum(bool(c['kept']) for c in good)}/{len(good)} good kept" + (f"; fresh: {fresh}" if fresh else "")))
    return out


def markdown(root: Path) -> str:
    table = rows(root)
    if not table:
        return "## Eval results\n\nNo result files found.\n"
    lines = ["## Eval results", "", "| Suite | Gate | Passed | Notes |", "|---|---|---|---|"]
    lines += [f"| {suite} | {gate} | {passed} | {note} |" for suite, gate, passed, note in table]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    print(markdown(Path(sys.argv[1] if len(sys.argv) > 1 else ".")))
