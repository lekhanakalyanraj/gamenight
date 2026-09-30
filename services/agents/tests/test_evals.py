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


def test_the_eval_game_ends_on_the_databases_win_rule_and_the_next_round_opens_itself(monkeypatch):
    import random

    from evals import game_harness as h
    from gamenight_agents import content, game_master, games, narrator
    from gamenight_agents.turn import Turn, current

    for module, names in ((games, ["state", "setup", "deal", "open_phase", "resolve_vote", "judge", "say"]),
                          (content, ["pick_pair"]), (narrator, ["narrate"])):
        for name in names:
            monkeypatch.setattr(module, name, getattr(module, name))

    def count(state, vote):
        case = h.Game(state=state, names={}, vote_result=vote)
        turn = Turn(state["game"]["id"], "5b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b", [], random.Random(1))
        with h.offline(case):
            token = current.set(turn)
            try:
                return asyncio.run(game_master.resolve_vote.coroutine()), case.state
            finally:
                current.reset(token)

    # Ben out: 2 civilians against 2 infiltrators is level, not a win, so round 2's clues open.
    result, after = count(*h.vote_out("Ben")[::2])
    assert result["game_over"] is False and after["game"]["phase"] == "clues"
    assert game_master.waiting_on_you(after) is None

    # With Priya already out, Ben leaves one civilian: the infiltrators win and nothing more opens.
    state, _, vote = h.vote_out("Ben")
    next(p for p in state["players"] if p["nickname"] == "Priya")["alive"] = False
    result, after = count(state, vote)
    assert result["winner"] == "infiltrators" and result["game_over"] is True
    assert after["game"]["phase"] == "ended" and "next_round" not in result
