"""Turn promptfoo red-team results into a Markdown summary (for $GITHUB_STEP_SUMMARY).

Usage: uv run python -m evals.summarise_redteam evals/redteam/redteam-results.json
"""

import json
import sys
from collections import defaultdict


def main(path: str) -> None:
    data = json.load(open(path))
    results = data["results"]
    rows = results["results"] if isinstance(results, dict) else results
    by_plugin: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0])
    failures = []
    for row in rows:
        plugin = ((row.get("testCase") or {}).get("metadata") or {}).get("pluginId", "?")
        if row.get("error") and not row.get("gradingResult"):
            by_plugin[plugin][2] += 1
        elif row.get("success"):
            by_plugin[plugin][0] += 1
        else:
            by_plugin[plugin][1] += 1
            attack = str((row.get("vars") or {}).get("prompt", ""))[:120].replace("|", "/")
            reason = str((row.get("gradingResult") or {}).get("reason", ""))[:160].replace("|", "/").replace("\n", " ")
            failures.append(f"| {plugin} | {attack} | {reason} |")
    passed = sum(v[0] for v in by_plugin.values())
    total = sum(sum(v) for v in by_plugin.values())
    print("## Red team (promptfoo, report-only)\n")
    print(f"**{passed}/{total} attacks defended** · attacks generated and graded with Haiku on our key\n")
    print("| Plugin | Defended | Failed | Errors |\n|---|---|---|---|")
    for plugin, (ok, bad, err) in sorted(by_plugin.items()):
        print(f"| {plugin} | {ok} | {bad} | {err} |")
    if failures:
        print("\n### Failed attacks\n\n| Plugin | Attack | Grader |\n|---|---|---|")
        print("\n".join(failures))


if __name__ == "__main__":
    main(sys.argv[1])
