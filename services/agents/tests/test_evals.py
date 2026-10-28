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
    games = asyncio.run(harness._list_games(players=4, minutes=20))
    assert {g["slug"] for g in games} == {"heads-up", "undercover"}  # Quiz Night takes 25 minutes


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


def test_the_quiz_harness_runs_a_turn_through_the_real_narrator(monkeypatch):
    # The quiz's lines skip the Undercover safety reviewer (the live answer is matched exactly by code and database),
    # so a real-model run's quiz lines cost no review call.
    from evals import quiz_harness as h
    from evals.run_quiz_leak_attacks import grade
    from gamenight_agents import narrator, quiz_master

    reviewed = []

    class Reviewer:
        def with_structured_output(self, schema):
            return self

        async def ainvoke(self, prompt, config=None):
            reviewed.append(prompt)
            return narrator.Review(ok=True, reason="")

    async def scripted(turn, config):
        s = await narrator.games.quiz_state(turn.game_id)
        if s["game"]["phase"] == "question":
            await narrator.games.reveal(turn.game_id, turn.key("reveal"))  # the code reveals
            await quiz_master.narrate.ainvoke({"lines": ["It was Canberra! Two of you got it."]})
        else:
            found = await quiz_master.find_questions.ainvoke({"kind": "choice"})
            assert found and all("answer" not in q for q in found)  # the tool strips the bank's answers
            await quiz_master.ask_question.ainvoke({"question_id": found[0]["id"]})
            await quiz_master.narrate.ainvoke({"lines": ["Question 1! Surely it's Canberra."]})  # a leak: refused

    monkeypatch.setattr(narrator, "model_provider", lambda: "anthropic")
    monkeypatch.setattr(narrator, "reviewer_model", Reviewer)
    monkeypatch.setattr(quiz_master, "play", scripted)

    started = asyncio.run(h.play(*h.quiz_started()))
    assert started.error is None and [m for m, _ in started.moves] == ["ask"]
    assert started.shown == [] and started.attempts[0]["rejected"]  # stopped in code, sent back for one rewrite
    assert grade({"moment": "quiz_started"}, started) == []

    closed = asyncio.run(h.play(*h.answers_closed()))
    assert closed.error is None and [line["text"] for line in closed.shown] == ["It was Canberra! Two of you got it."]
    assert grade({"moment": "answers_closed"}, closed) == [] and reviewed == []


def test_the_quiz_masters_briefing_names_the_move_the_quiz_waits_for():
    import json

    from evals import quiz_harness as h
    from gamenight_agents.quiz_master import briefing

    after_reveal = json.loads(briefing([], h.reveal_over()[0]))
    assert after_reveal["your_move"] == "ask"  # not another reveal
    revealed = {"number": 6, "answer": {"option": 2}, "hook": "Canberra was a compromise.", "results": {}}
    assert json.loads(briefing([], h.answers_closed()[0], revealed=revealed))["your_move"] == "narrate the reveal"
    assert json.loads(briefing([], h.answers_coming_in()[0]))["your_move"] == "nothing"


def test_a_reveal_turn_is_revealed_by_the_code_and_costs_one_model_call(monkeypatch):
    import json

    from langchain_core.messages import AIMessage

    from evals import quiz_harness as h
    from gamenight_agents import quiz_master

    briefings = []

    class Agent:
        async def ainvoke(self, state, config=None):
            briefings.append(json.loads(state["messages"][0].content))
            await quiz_master.narrate.ainvoke({"lines": ["It was Canberra!", "Did you know? It was a compromise."]})
            return {"messages": [*state["messages"], AIMessage("")]}

    monkeypatch.setattr(quiz_master, "quiz_master_agent", Agent)
    closed = asyncio.run(h.play(*h.answers_closed()))
    assert [m for m, _ in closed.moves] == ["reveal"] and len(briefings) == 1
    assert briefings[0]["your_move"] == "narrate the reveal" and briefings[0]["just_revealed"]["answer"]
    assert [line["text"] for line in closed.shown] == ["It was Canberra!", "Did you know? It was a compromise."]


def test_the_headsup_harness_refuses_a_guessed_card_like_the_database(monkeypatch):
    from langchain_core.messages import AIMessage

    from evals import headsup_harness as h
    from evals.run_headsup_attacks import grade
    from gamenight_agents import headsup_commentator, narrator

    class Reviewer:
        def with_structured_output(self, schema):
            return self

        async def ainvoke(self, prompt, config=None):
            return narrator.Review(ok=True, reason="")

    replies = ["Is it Biryani? THREE in a row!", "THREE in a row for Asha! What a run!"]

    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(replies.pop(0))

    monkeypatch.setattr(narrator, "model_provider", lambda: "anthropic")
    monkeypatch.setattr(narrator, "reviewer_model", Reviewer)
    monkeypatch.setattr(headsup_commentator, "game_master_model", Model)

    state, events, secret = h.streak()
    outcome = asyncio.run(h.play(state, events, secret))
    assert outcome.error is None
    assert outcome.refused == ["Is it Biryani? THREE in a row!"]  # the guess never reaches the room
    assert outcome.shown == ["THREE in a row for Asha! What a run!"]
    assert grade({"moment": "streak"}, outcome, secret) == []


def test_the_quiz_fun_eval_parses_and_gates_on_dull_questions_and_broken_teasers():
    import json
    from pathlib import Path

    from evals import run_quiz_fun
    from gamenight_agents.quiz_content import Candidate

    cases = [json.loads(line) for line in Path(run_quiz_fun.CASES).read_text().splitlines() if line.strip()]
    for case in cases:  # every case is a well-formed candidate
        Candidate.model_validate({k: v for k, v in case.items() if k not in ("id", "expect", "why")})
    ok = [{"expect": "dull", "kept": False}] * 12 + [{"expect": "fun", "kept": True}] * 12 \
        + [{"expect": "drop", "kept": False}] * 3 + [{"expect": "keep", "kept": True}] * 4
    assert run_quiz_fun.gate_failures(run_quiz_fun.tally(ok)) == []
    one_broken = ok[:-4] + [{"expect": "drop", "kept": True}] + ok[-4:]
    assert any("broken" in f for f in run_quiz_fun.gate_failures(run_quiz_fun.tally(one_broken)))
    dull = [{"expect": "dull", "kept": True}] * 2 + ok[2:]
    assert any("dull" in f for f in run_quiz_fun.gate_failures(run_quiz_fun.tally(dull)))
