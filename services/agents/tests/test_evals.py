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


def test_the_eval_game_refuses_the_moves_the_database_would(monkeypatch):
    import asyncio

    import pytest

    from evals import game_harness as h
    from gamenight_agents import content, games, narrator

    # The harness installs its fakes for a whole eval run; here they're undone after the test.
    for module, names in ((games, ["state", "setup", "deal", "open_phase", "resolve_vote", "judge", "say"]),
                          (content, ["pick_pair"]), (narrator, ["narrate"])):
        for name in names:
            monkeypatch.setattr(module, name, getattr(module, name))

    state, _, _ = h.guess_in("pizza")  # a verdict is waiting for the host: no new round yet
    case = h.Game(state=state, names={})
    with h.offline(case):
        with pytest.raises(games.Refused):
            asyncio.run(games.open_phase(state["game"]["id"], "clues", None, "e"))
        state["game"]["resolved"] = True  # once the verdict stands, the next round may start
        asyncio.run(games.open_phase(state["game"]["id"], "clues", None, "e"))
    assert case.state["game"]["phase"] == "clues"
