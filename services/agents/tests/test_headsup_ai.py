"""Tier 0: Heads Up's AI parts (the deck builder and the commentator), with the model and the database faked."""

import asyncio
import random

import pytest
from langchain_core.messages import AIMessage

from gamenight_agents import db, headsup_commentator, headsup_content, headsup_rules, narrator
from gamenight_agents.graphs.supervisor import picked_interests
from gamenight_agents.turn import Turn

EVENT = "5b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5d"


def turn(events=()):
    return Turn("g", EVENT, list(events), random.Random(5))


# ---- the deck builder --------------------------------------------------------------------------------------------

def test_cards_are_tidied_deduplicated_and_malformed_ones_dropped_not_repaired():
    text = 'Sure! ["Virat  Kohli", "virat kohli", "<b>Bold</b>", 42, "A", "Taj Mahal", "' + "x" * 41 + '"]'
    assert headsup_content.parse_cards(text) == ["Virat Kohli", "Taj Mahal"]
    assert headsup_content.parse_cards("no list here") == []
    assert headsup_content.parse_cards("[not json]") == []


@pytest.fixture
def bank(monkeypatch):
    saved = []

    async def coverage(room_id, topic):
        return 3

    async def save(topic, card, rating):
        saved.append((topic, card, rating))
        return "new-id"

    monkeypatch.setattr(db, "headsup_coverage", coverage)
    monkeypatch.setattr(db, "save_headsup_card", save)
    return saved


def test_only_cards_the_review_keeps_are_saved_under_the_interest(monkeypatch, bank):
    async def write(interest, rating, region, wanted, callbacks=None):
        return ["Elephant", "My neighbour Raj", "Giraffe", "Platypus"]

    async def review(interest, cards, rating, region, callbacks=None):
        verdicts = [headsup_content.CardVerdict(card="elephant", keep=True, reason=""),
                    headsup_content.CardVerdict(card="My neighbour Raj", keep=False, reason="a private person"),
                    headsup_content.CardVerdict(card="Giraffe", keep=True, reason="")]
        return {v.card.lower(): v for v in verdicts}  # Platypus: not ruled on, so not kept

    monkeypatch.setattr(headsup_content, "write", write)
    monkeypatch.setattr(headsup_content, "review", review)
    result = asyncio.run(headsup_content.top_up("room", "  Wild Animals! ", "family"))
    assert bank == [("wild animals", "Elephant", "family"), ("wild animals", "Giraffe", "family")]
    assert result["saved"] == 2 and len(result["dropped"]) == 2
    assert any("private person" in d for d in result["dropped"]) and any("not reviewed" in d for d in result["dropped"])


def test_an_interest_that_isnt_one_or_is_covered_writes_nothing(monkeypatch, bank):
    async def write(*args, **kwargs):
        raise AssertionError("no model call")

    monkeypatch.setattr(headsup_content, "write", write)
    assert asyncio.run(headsup_content.top_up("room", "<<<>>>", "family"))["saved"] == 0

    async def covered(room_id, topic):
        return headsup_content.TARGET

    monkeypatch.setattr(db, "headsup_coverage", covered)
    assert asyncio.run(headsup_content.top_up("room", "Cricket", "family"))["saved"] == 0


def test_the_lobby_builds_a_few_distinct_interests_at_a_time_latest_first():
    events = [{"kind": "interests_picked", "payload": {"interests": ["Cricket", "Food"]}},
              {"kind": "member_joined", "payload": {}},
              {"kind": "interests_picked", "payload": {"interests": ["cricket", "Space travel", "Jazz", "<x>"]}}]
    assert picked_interests(events) == ["cricket", "Space travel", "Jazz"]


# ---- the moments and the commentator -----------------------------------------------------------------------------

def state(phase="recap", deadline="2099-01-01", cards=None):
    return {"game": {"phase": phase, "phase_deadline": deadline, "paused": False}, "age_rating": "family",
            "players": [{"member_id": "m-asha", "nickname": "Asha", "got": 4}],
            "turn": {"number": 2, "cards": cards}}


def test_a_turn_end_comes_with_that_turns_public_cards_and_a_streak_is_called_mid_turn():
    heard = []

    async def speak(t, moment, s):
        heard.append(moment)

    ended = {"kind": "phase_complete", "payload": {"phase": "guessing", "turn": 2, "guesser": "m-asha", "got": 1}}
    cards = [{"card": "Pizza", "result": "got"}]
    asyncio.run(headsup_rules.step(turn([ended]), state(cards=cards), speak))
    assert heard[-1] == {"kind": "turn_end", "guesser": "Asha", "got": 1, "passed": 0, "cards": cards}
    streak = {"kind": "streak", "payload": {"guesser": "m-asha", "streak": 3, "got": 3}}
    asyncio.run(headsup_rules.step(turn([streak]), state("guessing"), speak))
    assert heard[-1] == {"kind": "streak", "guesser": "Asha", "streak": 3, "got": 3}
    assert headsup_rules.scripted_line(heard[-1]) == "3 in a row for Asha! Keep it going!"


class FakeModel:
    def __init__(self, replies):
        self.replies, self.prompts = list(replies), []

    async def ainvoke(self, messages, config=None):
        self.prompts.append(messages)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return AIMessage(reply)


@pytest.fixture
def said(monkeypatch):
    lines = []

    async def narrate(t, line):
        lines.append(line)
        if "Pizza" in line and len(lines) == 1:
            return {"shown": False, "rejected": ["the database found a secret word in it"]}
        return {"shown": True, "text": line}

    monkeypatch.setattr(narrator, "narrate", narrate)
    return lines


MOMENT = {"kind": "streak", "guesser": "Asha", "streak": 3, "got": 3}


def test_the_commentator_writes_the_line_from_public_facts_only(monkeypatch, said):
    model = FakeModel(["THREE in a row for Asha! Unstoppable!"])
    monkeypatch.setattr(headsup_commentator, "game_master_model", lambda: model)
    asyncio.run(headsup_commentator.speak(turn(), MOMENT, state("guessing")))
    assert said == ["THREE in a row for Asha! Unstoppable!"]
    sent = model.prompts[0][1].content
    assert '"streak": 3' in sent and "cards" not in sent  # it's never told a live card


def test_a_refused_line_is_rewritten_once_with_the_reason(monkeypatch, said):
    model = FakeModel(["Is it Pizza? Three in a row!", "Three in a row for Asha!"])
    monkeypatch.setattr(headsup_commentator, "game_master_model", lambda: model)
    asyncio.run(headsup_commentator.speak(turn(), MOMENT, state("guessing")))
    assert said == ["Is it Pizza? Three in a row!", "Three in a row for Asha!"]
    assert "secret word" in model.prompts[1][-1].content


def test_a_model_failure_falls_back_to_the_scripted_line(monkeypatch, said):
    model = FakeModel([TimeoutError("slow")])
    monkeypatch.setattr(headsup_commentator, "game_master_model", lambda: model)
    asyncio.run(headsup_commentator.speak(turn(), MOMENT, state("guessing")))
    assert said == ["3 in a row for Asha! Keep it going!"]


def test_the_region_is_named_for_the_model():
    assert headsup_content.region_text("IN") == ", in India" and headsup_content.region_text(None) == ""
