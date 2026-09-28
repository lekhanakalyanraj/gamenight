#!/usr/bin/env python3
"""Run Supabase's security and performance advisors (splinter) against a Postgres database.

Fails on any ERROR or WARN finding that isn't in supabase/advisors-allowlist.txt. Uses only the
standard library and `psql`, so it runs the same locally and in CI.

We fetch splinter.sql at a pinned commit and check its hash instead of vendoring it, because the
upstream repo doesn't publish a licence file. `supabase db advisors` would be simpler, but it
currently fails on local projects with custom ports (supabase/cli#4965).

Usage: scripts/db-advisors.py [--db-url URL]
"""

import argparse
import csv
import hashlib
import io
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

SPLINTER_COMMIT = "e74a9e36cb12258cb67d1464bc1cb196e9cd8446"  # release 2026.09.1
SPLINTER_SHA256 = "d8d558baad3e03832e521c527907fa50a9a172fabd899dd0f5c2504a5a0e9349"
SPLINTER_URL = f"https://raw.githubusercontent.com/supabase/splinter/{SPLINTER_COMMIT}/splinter.sql"

ROOT = Path(__file__).resolve().parent.parent
ALLOWLIST = ROOT / "supabase" / "advisors-allowlist.txt"
CACHE = ROOT / "supabase" / ".temp" / f"splinter-{SPLINTER_COMMIT[:12]}.sql"
DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:55422/postgres"


def splinter_sql() -> bytes:
    if CACHE.exists():
        sql = CACHE.read_bytes()
    else:
        with urllib.request.urlopen(SPLINTER_URL, timeout=30) as response:
            sql = response.read()
    digest = hashlib.sha256(sql).hexdigest()
    if digest != SPLINTER_SHA256:
        sys.exit(f"splinter.sql hash mismatch: expected {SPLINTER_SHA256}, got {digest}")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(sql)
    return sql


def allowlist() -> set[str]:
    """One cache_key per line; everything after '#' is the reason, which is required."""
    keys = set()
    for number, line in enumerate(ALLOWLIST.read_text().splitlines(), start=1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, _, reason = line.partition("#")
        if not reason.strip():
            sys.exit(f"{ALLOWLIST.name}:{number}: every allowlisted finding needs a '# reason'")
        keys.add(key.strip())
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db-url", default=os.environ.get("DB_URL", DEFAULT_DB_URL))
    args = parser.parse_args()

    # splinter.sql uses `set local`, so it must run inside a single transaction (-1).
    result = subprocess.run(
        ["psql", args.db_url, "--quiet", "--no-psqlrc", "--csv", "--single-transaction", "-v", "ON_ERROR_STOP=1"],
        input=splinter_sql(),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr.decode())
        return result.returncode

    findings = list(csv.DictReader(io.StringIO(result.stdout.decode())))
    allowed = allowlist()
    blocking = [f for f in findings if f["level"] in ("ERROR", "WARN") and f["cache_key"] not in allowed]
    stale = allowed - {f["cache_key"] for f in findings}

    for f in findings:
        mark = "FAIL" if f in blocking else ("ok  " if f["cache_key"] in allowed else "info")
        print(f"{mark}  {f['level']:5}  {f['name']}: {f['detail']}")
    for key in sorted(stale):
        print(f"note  allowlist entry no longer matches anything, remove it: {key}")

    print(f"\n{len(findings)} findings, {len(blocking)} blocking")
    if blocking:
        print("Fix them, or add their cache_key to supabase/advisors-allowlist.txt with a reason.")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
