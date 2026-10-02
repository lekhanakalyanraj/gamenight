"""Every metric a Grafana dashboard queries must be one the services emit, under the name Prometheus gives it.

Reads the metric definitions in services/*/src/**/telemetry.py (create_counter, create_histogram,
create_observable_gauge), turns each into its Prometheus names the way the collector does (dots to underscores; a
unit of ms or s becomes a suffix, a {annotation} unit none; counters end in _total; histograms have _bucket, _sum and
_count), and checks every gamenight_* name in infra/observability/grafana/dashboards/*.json against them.
Exits 1 with the unknown names. Run from the repo root: python3 scripts/check-dashboards.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFINE = re.compile(r'create_(counter|histogram|observable_gauge|up_down_counter)\(\s*"([a-z0-9_.]+)"(.*?)unit="([^"]*)"',
                    re.DOTALL)
UNITS = {"ms": "_milliseconds", "s": "_seconds"}


def prometheus_names() -> set[str]:
    names: set[str] = set()
    for path in ROOT.glob("services/*/src/**/telemetry.py"):
        for kind, name, _, unit in DEFINE.findall(path.read_text()):
            base = name.replace(".", "_") + ("" if unit.startswith("{") else UNITS.get(unit, ""))
            if kind == "counter":
                names.add(base + "_total")
            elif kind == "histogram":
                names |= {base + "_bucket", base + "_sum", base + "_count"}
            else:
                names.add(base)
    return names


def main() -> int:
    known = prometheus_names()
    unknown = []
    for path in sorted(ROOT.glob("infra/observability/grafana/dashboards/*.json")):
        for panel in json.loads(path.read_text()).get("panels", []):
            for target in panel.get("targets", []):
                expr = target.get("expr") or ""
                # A metric name, not a label: labels appear in by (...) groupings and {{...}} legends.
                labels = set(re.findall(r"by \(([^)]*)\)", expr)) | set(re.findall(r"\{\{(\w+)\}\}", expr))
                label_names = {n.strip() for group in labels for n in group.split(",")}
                for name in re.findall(r"\bgamenight_[a-z0-9_]+", expr):
                    if name not in known and name not in label_names:
                        unknown.append(f"{path.name}: panel '{panel.get('title')}' queries {name}")
    for line in unknown:
        print(line, file=sys.stderr)
    print(f"{len(known)} metric names known; {len(unknown)} unknown in the dashboards")
    return 1 if unknown else 0


if __name__ == "__main__":
    sys.exit(main())
