"""Tier 0: preparing a whole quiz before it starts, against a fake bank (no database, no model)."""

import asyncio
import random

import pytest
from langchain_core.messages import AIMessage

from gamenight_agents import games, quiz_planner
from gamenight_agents.turn import Turn

PLAN = [{"round": "teasers", "questions": 2}, {"round": "picture", "questions": 2},
        {"round": "connect", "questions": 2}]


def bank(kinds: dict[str, int], topic: str = "general") -> list[dict]:
    return [{"id": f"{kind}-{topic}-{i}", "kind": kind, "topic": topic, "prompt": f"{kind} {topic} {i}",
             "options": ["Red", "Blue", "Green", "Pink"], "answer": {"option": 1}, "hook": f"A {kind} fact."}
            for kind, n in kinds.items() for i in range(n)]


def state(plan=PLAN):
    return {"planned": False, "game": {"phase": "setup", "paused": False, "config": {"plan": plan}},
            "players": [{"member_id": "m-asha", "nickname": "Asha", "topic": "Cricket"},
                        {"member_id": "m-ben", "nickname": "Ben", "topic": "Anime"},
                        {"member_id": "m-chen", "nickname": "Chen", "topic": None}]}


@pytest.fixture
def db(monkeypatch):
    rows = bank({"teaser": 3, "connect": 3}) + bank({"teaser": 1}, "cricket") + bank({"connect": 1}, "anime") \
        + bank({"choice": 6})
    calls = {"planned": None}

    async def quiz_bank(game, topic=None, kind=None, difficulty=None, limit=20):
        return [q for q in rows if (topic is None or q["topic"] == topic) and (kind is None or q["kind"] == kind)]

    async def plan_quiz(game, items, event, rounds=None):
        calls["planned"] = (items, rounds)
        return {"planned": len(items)}

    monkeypatch.setattr(games, "quiz_bank", quiz_bank)
    monkeypatch.setattr(games, "plan_quiz", plan_quiz)
    monkeypatch.setattr(quiz_planner, "model_provider", lambda: "fake")
    return calls


def turn():
    return Turn("g", "5b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b", [], random.Random(2))


def test_every_slot_is_filled_crediting_topics_and_a_round_the_bank_cant_fill_is_swapped(db):
    slots, rounds = asyncio.run(quiz_planner.assemble(turn(), state()))
    assert rounds == ["teasers", "mix", "connect"]  # no pictures in this bank: the mix (its own 5 questions) instead
    assert [s["question"]["kind"] for s in slots] == ["teaser"] * 2 + ["choice"] * 5 + ["connect"] * 2
    assert len({s["question"]["id"] for s in slots}) == 9  # no repeats
    credited = {s["question"]["id"]: s["for_member"] for s in slots}
    assert credited["teaser-cricket-0"] == "m-asha" and credited["connect-anime-0"] == "m-ben"


def test_the_opener_and_the_finale_are_never_swapped(db):
    short = [{"round": "teasers", "questions": 9}, {"round": "mix", "questions": 1},
             {"round": "connect", "questions": 1}]
    assert asyncio.run(quiz_planner.assemble(turn(), state(short))) is None  # 4 teasers in the bank: play it live


def test_a_planned_quiz_goes_to_the_database_with_its_lines(db):
    assert asyncio.run(quiz_planner.plan(turn(), state()))
    items, rounds = db["planned"]
    assert rounds == ["teasers", "mix", "connect"] and len(items) == 9
    assert items[0]["lead_in"].startswith("Brain teasers to start.")
    assert items[0]["reveal_line"] == "A teaser fact."


def test_a_model_lead_in_that_gives_the_answer_away_falls_back_to_its_template(db, monkeypatch):
    replies = iter([AIMessage('[{"number": 1, "line": "Easy one. It\'s Blue."}, {"number": 2, "line": "Next."}]'),
                    AIMessage('[{"number": 1, "line": "Blue it was."}]')])

    class Model:
        async def ainvoke(self, prompt, config=None):
            return next(replies)

    monkeypatch.setattr(quiz_planner, "model_provider", lambda: "anthropic")
    monkeypatch.setattr(quiz_planner, "content_model", lambda max_tokens=0: Model())
    t = turn()
    assert asyncio.run(quiz_planner.plan(t, state()))
    items, _ = db["planned"]
    assert items[0]["lead_in"].startswith("Brain teasers to start.")  # "It's Blue" names the answer: refused
    assert items[1]["lead_in"] == "Next." and items[0]["reveal_line"] == "Blue it was."
    assert t.model_calls == 2


def test_an_already_planned_quiz_is_left_alone(db):
    assert asyncio.run(quiz_planner.plan(turn(), {**state(), "planned": True}))
    assert db["planned"] is None
