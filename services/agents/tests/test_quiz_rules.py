"""Tier 0: the scripted quiz master, against a fake database."""

import asyncio
import random

import pytest

from gamenight_agents import games, narrator, quiz_rules
from gamenight_agents.turn import Turn

EVENT = "5b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"
CONFIG = {"rounds": 3, "per_round": 5, "seconds": 20, "round_kinds": ["choice", "picture", "estimate"]}
MARS = {"id": "q-mars", "topic": "general", "kind": "choice", "prompt": "Red Planet?",
        "options": ["Venus", "Mars"], "answer": {"option": 1}}
CRICKET = {"id": "q-cricket", "topic": "cricket", "kind": "choice", "prompt": "Players on the field?",
           "options": ["10", "11"], "answer": {"option": 1}}


def quiz(phase="setup", deadline=None, asked=0, question=None, players=None):
    return {"game": {"phase": phase, "phase_deadline": deadline, "paused": False, "resolved": False, "config": CONFIG},
            "asked": asked, "total": 15, "question": question,
            "players": players or [
                {"member_id": "m-asha", "nickname": "Asha", "topic": None, "points": 900},
                {"member_id": "m-ben", "nickname": "Ben", "topic": "Cricket", "points": 100}]}


@pytest.fixture
def db(monkeypatch):
    calls = {"asked": [], "revealed": 0, "said": []}

    async def quiz_bank(game, topic=None, kind=None, difficulty=None, limit=20):
        return [q for q in (MARS, CRICKET) if (topic is None or q["topic"] == topic) and (kind in (None, q["kind"]))]

    async def ask(game, question, for_member, event):
        calls["asked"].append((question, for_member))
        return {"number": 1, "of": 15, "round": 1, "kind": "choice", "final_round": False, "jokers_to": []}

    async def reveal(game, event):
        calls["revealed"] += 1
        return {"results": {"answered": 2, "right": 1}}

    async def narrate(turn, line):
        calls["said"].append(line)
        return {"shown": True, "text": line}

    monkeypatch.setattr(games, "quiz_bank", quiz_bank)
    monkeypatch.setattr(games, "ask", ask)
    monkeypatch.setattr(games, "reveal", reveal)
    monkeypatch.setattr(narrator, "narrate", narrate)
    return calls


def turn(events=()):
    return Turn("g", EVENT, list(events), random.Random(5))


def test_a_question_leans_toward_the_topic_of_whoever_is_furthest_behind(db):
    assert asyncio.run(quiz_rules.step(turn(), quiz()))
    assert db["asked"] == [("q-cricket", "m-ben")]
    assert any("for Ben: cricket" in line for line in db["said"])


def test_without_a_matching_topic_it_asks_from_any_topic(db):
    players = [{"member_id": "m-asha", "nickname": "Asha", "topic": "anime", "points": 0}]
    asyncio.run(quiz_rules.step(turn(), quiz(players=players)))
    assert db["asked"][0][1] is None  # nobody to credit


@pytest.mark.parametrize(("state", "moves"), [
    (quiz(phase="question", deadline="2099-01-01T00:00:00Z"), False),  # answers are coming in
    (quiz(phase="reveal", deadline="2099-01-01T00:00:00Z"), False),    # the reveal is on screen
    (quiz(phase="reveal", asked=15), False),                           # nothing left to ask
    (quiz(phase="question", question=MARS), True),                     # answers closed: reveal
])
def test_it_moves_only_when_the_quiz_is_waiting_on_it(db, state, moves):
    assert asyncio.run(quiz_rules.step(turn(), state)) is moves


def test_a_blurted_answer_that_gets_shown_fails_loudly(db, monkeypatch):
    async def shows_everything(turn, line):
        return {"shown": True, "text": line}

    monkeypatch.setattr(narrator, "narrate", shows_everything)
    probing = Turn("g", EVENT, [], random.Random(0))
    probing.rng.random = lambda: 0.0  # always probe
    with pytest.raises(AssertionError, match="live answer"):
        asyncio.run(quiz_rules.leak_probe(probing, MARS))


def test_the_finale_names_the_winner(db):
    asyncio.run(quiz_rules.step(turn([{"kind": "game_ended"}]), quiz(phase="ended")))
    assert db["said"] == ["That's the quiz! Asha wins with 900 points!"]
