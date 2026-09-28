"""Tier 0 tests for the eval harness itself (no model calls)."""

import asyncio

from evals import harness
from evals.run_golden import checks
from gamenight_agents import db


def test_hard_checks_catch_each_kind_of_miss():
    case = {"must_call": ["suggest_games"], "must_not_call": ["announce"], "must_include_any": ["Undercover"],
            "must_not_include": ["**"], "max_chars": 20, "must_announce": True}
    failed = checks(case, "Try **Mafia** tonight, it's great", ["announce"], [])
    assert len(failed) == 6
    assert checks({"must_include_any": ["undercover"]}, "Undercover it is", [], []) == []


def test_concurrent_cases_never_see_each_others_room():
    # Regression: patching module functions per case let concurrent cases overwrite each other's fixtures.
    async def snapshot_in(room):
        with harness.offline(room, []):
            await asyncio.sleep(0.01)  # interleave with the other case
            return (await db.room_snapshot("any"))["players"]

    async def both():
        small = harness.Room(["Priya", "Asha", "Ben"])
        big = harness.Room([f"P{i}" for i in range(12)])
        return await asyncio.gather(snapshot_in(small), snapshot_in(big))

    small, big = asyncio.run(both())
    assert len(small) == 3 and len(big) == 12


def test_the_catalog_fixture_filters_like_the_real_catalog():
    games = asyncio.run(harness._list_games(players=4, minutes=30))
    assert {g["slug"] for g in games} == {"heads-up", "quiz-night", "undercover"}  # Mafia: 5+ players, 40 min
