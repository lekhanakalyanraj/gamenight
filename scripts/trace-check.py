#!/usr/bin/env python3
"""Check that one player join produced one trace across web, dispatcher and agents.

Takes the latest dispatched join from the outbox (its traceparent came from the web request), fetches
that trace from Tempo, and lists its spans by service. Needs the collector stack (make services-up) and
services exporting to it (the compose services do; dev servers with OTEL=1).

Usage: scripts/trace-check.py [--tempo http://127.0.0.1:3201] [--db-url ...]
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.request

REQUIRED = {"web", "dispatcher", "agents"}


def latest_trace_id(db_url: str) -> str | None:
    sql = ("select split_part(traceparent, '-', 2) from dispatch.events "
           "where traceparent is not null and dispatched_at is not null order by created_at desc limit 1")
    out = subprocess.run(["psql", db_url, "-tA", "-c", sql], capture_output=True, text=True, check=True).stdout.strip()
    return out or None


def spans_by_service(tempo: str, trace_id: str) -> dict[str, list[str]]:
    with urllib.request.urlopen(f"{tempo}/api/traces/{trace_id}", timeout=10) as response:
        data = json.load(response)
    services: dict[str, list[str]] = {}
    for batch in data.get("batches", data.get("resourceSpans", [])):
        attrs = {a["key"]: a["value"].get("stringValue") for a in batch.get("resource", {}).get("attributes", [])}
        name = attrs.get("service.name", "?")
        for scope in batch.get("scopeSpans", batch.get("instrumentationLibrarySpans", [])):
            services.setdefault(name, []).extend(s["name"] for s in scope.get("spans", []))
    return services


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tempo", default="http://127.0.0.1:3201")
    parser.add_argument("--db-url", default="postgresql://postgres:postgres@127.0.0.1:55422/postgres")
    parser.add_argument("--wait", type=int, default=30, help="seconds to wait for spans to be flushed")
    args = parser.parse_args()

    trace_id = latest_trace_id(args.db_url)
    if not trace_id:
        print("No dispatched join with a traceparent yet: join a room with tracing on, then run this again.")
        return 1
    print(f"trace {trace_id}")
    deadline = time.monotonic() + args.wait
    services: dict[str, list[str]] = {}
    while time.monotonic() < deadline:
        try:
            services = spans_by_service(args.tempo, trace_id)
        except OSError:
            services = {}
        if REQUIRED <= set(services):
            break
        time.sleep(3)
    for service, names in sorted(services.items()):
        print(f"  {service:10} {len(names):3} spans  e.g. {', '.join(sorted(set(names))[:4])}")
    missing = REQUIRED - set(services)
    if missing:
        print(f"Missing from the trace: {', '.join(sorted(missing))}")
        return 1
    print("One trace from the web request, through the outbox and dispatcher, to the agents' model calls.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
