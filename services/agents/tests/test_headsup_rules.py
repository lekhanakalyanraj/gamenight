"""Tier 0: the scripted Heads Up host, against a fake database."""

import asyncio
import random

import pytest

from gamenight_agents import games, headsup_rules, narrator
from gamenight_agents.turn import Turn

EVENT = "5b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5c"
PLAYERS = [{"member_id": "m-asha", "nickname": "Asha", "got": 3}, {"member_id": "m-ben", "nickname": "Ben", "got": 5}]


def state(phase="setup", deadline=None, paused=False):
    return {"game": {"phase": phase, "phase_deadline": deadline, "paused": paused}, "players": PLAYERS}


@pytest.fixture
def db(monkeypatch):
    calls = {"next": 0, "said": [], "over": False}

    async def next_turn(game, event):
        calls["next"] += 1
        if calls["over"]:
            return {"game_over": True}
        return {"turn": calls["next"], "of": 4, "round": 1, "guesser": "m-asha", "game_over": False}

    async def narrate(turn, line):
        calls["said"].append(line)
        return {"shown": True, "text": line}

    monkeypatch.setattr(games, "next_turn", next_turn)
    monkeypatch.setattr(narrator, "narrate", narrate)
    return calls


def turn(events=()):
    return Turn("g", EVENT, list(events), random.Random(5))


def test_the_game_starts_with_the_first_guesser_turning_their_back(db):
    assert asyncio.run(headsup_rules.step(turn([{"kind": "game_started"}]), state()))
    assert db["next"] == 1 and db["said"] == ["Heads Up! Turn 1 of 4: Asha, turn your back to the TV!"]


def test_after_the_recap_has_had_its_time_the_next_turn_starts(db):
    assert asyncio.run(headsup_rules.step(turn([{"kind": "deadline_passed"}]), state("recap")))
    assert db["next"] == 1


@pytest.mark.parametrize(("phase", "deadline", "paused"), [
    ("ready", "2099-01-01", False),     # the countdown is the database's
    ("guessing", "2099-01-01", False),  # so is the guessing
    ("recap", "2099-01-01", False),     # the recap still has its time
    ("recap", None, True),              # paused by the host
])
def test_otherwise_it_leaves_the_clock_to_the_database(db, phase, deadline, paused):
    assert not asyncio.run(headsup_rules.step(turn(), state(phase, deadline, paused)))
    assert db["next"] == 0


def test_a_turn_ending_is_called_with_the_guessers_score(db):
    ended = {"kind": "phase_complete", "payload": {"phase": "guessing", "guesser": "m-ben", "got": 4, "passed": 1}}
    asyncio.run(headsup_rules.step(turn([ended]), state("recap", "2099-01-01")))
    assert db["said"] == ["Time! Ben got 4!"] and db["next"] == 0


def test_the_finale_names_the_winner(db):
    asyncio.run(headsup_rules.step(turn([{"kind": "game_ended"}]), state("ended")))
    assert db["said"] == ["That's Heads Up! Ben wins with 5 got!"]


def test_the_game_is_waiting_on_the_host_only_between_turns():
    assert headsup_rules.waiting_on_you(state("recap")) == "next_turn"
    assert headsup_rules.waiting_on_you(state("recap", "2099-01-01")) is None
    assert headsup_rules.waiting_on_you(state("guessing", "2099-01-01")) is None
