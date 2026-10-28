"""Tier 0: grounded question checks, with Wikipedia and the judge faked (no network, no model)."""

import asyncio

import httpx
import pytest

from gamenight_agents import quiz_content as qc
from gamenight_agents.graphs.supervisor import picked_topics

ARTICLE = ("Apollo 11 (July 16–24, 1969) was the American spaceflight that first landed humans on the Moon. "
           "Commander Neil Armstrong and Lunar Module Pilot Buzz Aldrin landed the Apollo Lunar Module Eagle "
           "on July 20, 1969.")


def candidate(**overrides):
    base = {"kind": "estimate", "difficulty": 1, "prompt": "In what year did people first land on the Moon?",
            "answer_number": 1969, "unit": None, "source_url": "https://en.wikipedia.org/wiki/Apollo_11",
            "source_sentence": "Apollo 11 (July 16-24, 1969) was the American spaceflight that first landed humans "
                               "on the Moon."}
    return qc.Candidate.model_validate(base | overrides)


def wikipedia(title_seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        title_seen.append(request.url.params["titles"])
        if request.url.params["titles"] == "Apollo 11":
            return httpx.Response(200, json={"query": {"pages": {"1": {"title": "Apollo 11", "extract": ARTICLE}}}})
        return httpx.Response(200, json={"query": {"pages": {"-1": {"title": "Nope", "missing": ""}}}})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def judge_says(**verdict):
    async def judge(c, sentence, rating, callbacks=None, page=None):
        return qc.Verdict(**({"supported": True, "single_answer": True, "unambiguous": True, "lasting": True,
                              "fits_rating": True, "reputable_source": True, "reason": "fine"} | verdict))
    return judge


def run_verify(c, judge_fn=None):
    async def go():
        async with wikipedia([]) as http:
            return await qc.verify(http, c, "family", judge_fn=judge_fn or judge_says())
    return asyncio.run(go())


def test_a_grounded_question_is_kept_with_the_articles_own_sentence():
    question, why = run_verify(candidate())
    assert why == "verified" and question["answer"] == {"value": 1969}
    assert question["source_quote"].startswith("Apollo 11 (July 16–24, 1969)")  # the article's, not the model's
    assert question["source_url"] == "https://en.wikipedia.org/wiki/Apollo_11"


@pytest.mark.parametrize(("overrides", "why"), [
    ({"source_sentence": "Apollo 11 landed on the Moon in 1972 after a long delay."}, "isn't on the page"),
    ({"source_url": "https://example.com/apollo"}, "isn't a search result or an English Wikipedia article"),
    ({"source_url": "https://en.wikipedia.org/wiki/Apollo_99"}, "doesn't exist"),
    ({"prompt": "Apollo 11 landed in 1969: what year was that?"}, "gives its answer away"),  # once missed: 1969.0
    ({"prompt": "Was it 1,969 years after the calendar began?"}, "gives its answer away"),
    ({"kind": "choice", "options": ["1969", "1969", "1970", "1971"], "answer_option": 0}, "distinct options"),
    ({"answer_number": None}, "no answer"),
])
def test_anything_unsourced_or_misshapen_is_dropped(overrides, why):
    question, reason = run_verify(candidate(**overrides))
    assert question is None and why in reason


def test_the_judge_has_the_last_word():
    question, reason = run_verify(candidate(), judge_says(lasting=False, reason="records change"))
    assert question is None and "lasting" in reason


def test_model_output_that_isnt_a_clean_list_of_questions_is_dropped_not_repaired():
    text = 'Here you go: [{"kind": "estimate", "difficulty": 1, "prompt": "Year of the Moon landing?", ' \
           '"answer_number": 1969, "source_url": "https://en.wikipedia.org/wiki/Apollo_11", ' \
           '"source_sentence": "x"}, {"kind": "riddle"}]'
    assert [c.kind for c in qc.parse_candidates(text)] == ["estimate"]
    assert qc.parse_candidates("no JSON at all") == []


@pytest.mark.parametrize(("raw", "key"), [
    ("Cricket", "cricket"), ("  Bollywood   Movies ", "bollywood movies"), ("Rock'n'Roll!", "rocknroll"),
    ("90s pop", None), ("!!", None), (None, None),
])
def test_topics_are_filed_the_way_the_bank_expects(raw, key):
    assert qc.topic_key(raw) == key


def test_the_lobby_tops_up_a_few_distinct_topics_at_a_time():
    events = [{"kind": "topic_picked", "payload": {"topic": t}} for t in ("Cricket", "cricket", "Music", "Art", "Food")]
    events.append({"kind": "member_joined", "payload": {"nickname": "Asha"}})
    assert picked_topics(events) == ["cricket", "music", "art"]


def test_a_reply_cut_off_mid_list_gives_nothing_and_says_why():
    # Regression: 600 output tokens cut the list off, so every topic got no questions, silently.
    from langchain_core.messages import AIMessage

    reply = AIMessage('[{"kind": "choice", "prompt": "Who won the', response_metadata={"stop_reason": "max_tokens"})
    assert qc.parse_candidates(qc._text(reply)) == []
    assert "stop_reason=max_tokens" in qc.why_empty(reply)
    assert qc.WRITE_TOKENS >= 9 * 250  # room for a full list of candidates with their sentences


# ---- slice 9: passages, the new kinds, brain teasers, and the shuffle ------------------------------------------------

LONG = ("Mercury is the smallest planet in the Solar System. It is the closest planet to the Sun. "
        "Mercury has no moons. Venus is the second planet from the Sun.")


def test_a_passage_is_up_to_three_consecutive_sentences_from_the_article():
    assert qc.find_passage(LONG, "It is the closest planet to the Sun. Mercury has no moons.") == \
        "It is the closest planet to the Sun. Mercury has no moons."
    assert qc.find_passage(LONG, "Mercury is the smallest planet in the Solar System. Mercury has no moons.") is None
    assert qc.find_passage(LONG, "Mercury has no moons. It is the closest planet to the Sun.") is None  # out of order


def shape(**overrides):
    base = {"kind": "order", "difficulty": 2, "prompt": "Put these in order of size.", "options": ["Earth", "Mars",
            "Moon"], "answer_order": [2, 1, 0], "order_by": "smallest first", "hook": "Mars is half as wide as Earth.",
            "source_url": "https://en.wikipedia.org/wiki/Mars", "source_sentence": "x"}
    return qc.shape_problems(qc.Candidate.model_validate(base | overrides))


@pytest.mark.parametrize(("overrides", "why"), [
    ({}, None),
    ({"answer_order": [0, 0, 1]}, "every option once"),
    ({"order_by": None}, "what it goes by"),
    ({"kind": "connect", "answer_order": None, "order_by": None, "options": ["Planets", "Moons", "Stars", "Comets"],
      "answer_option": 0, "clues": ["Mars", "Venus"]}, "3 or 4 distinct clues"),
    ({"kind": "connect", "answer_order": None, "order_by": None, "options": ["Planets", "Moons", "Stars", "Comets"],
      "answer_option": 0, "clues": ["Mars", "Venus", "The planets of the Sun"]}, "gives the link away"),
    ({"kind": "lightning", "answer_order": None, "order_by": None, "prompt": "Bigger?", "options": ["Mars", "Earth",
      "Moon"], "answer_option": 1}, "2 to 2 distinct options"),
    ({"kind": "fake_real", "answer_order": None, "order_by": None, "options": None, "answer_true": None},
     "no answer"),
    ({"kind": "teaser", "answer_order": None, "order_by": None, "options": ["A", "B", "C", "D"], "answer_option": 0},
     "a brain teaser has no source"),
    ({"hook": "Short."}, "10 to 200"),
])
def test_each_kind_has_its_own_shape(overrides, why):
    problems = shape(**overrides)
    assert (problems == []) if why is None else any(why in p for p in problems), problems


TEASER = qc.Candidate.model_validate({"kind": "teaser", "difficulty": 2, "prompt": "What has keys but no locks?",
                                      "options": ["A piano", "A map", "A diary", "A safe"], "answer_option": 0})


def solver(*results):
    answers = iter(results)

    async def solve(c, rating, rng, callbacks=None):
        ok, fun = next(answers)
        return ok, fun, "worked it out"
    return solve


def test_a_teaser_is_kept_only_when_both_blind_solves_reach_its_answer():
    question, why = asyncio.run(qc.verify_teaser(TEASER, "family", solve_fn=solver((True, 4), (True, 3))))
    assert why == "verified" and question["source_url"] is None and question["fun"] == 3
    question, why = asyncio.run(qc.verify_teaser(TEASER, "family", solve_fn=solver((True, 4), (False, 4))))
    assert question is None and "blind solve 2" in why


def test_the_blind_solve_maps_the_shuffled_options_back(monkeypatch):
    class Model:
        def with_structured_output(self, _schema):
            return self

        async def ainvoke(self, prompt, config=None):
            shown = [line.split(". ", 1)[1] for line in prompt.splitlines() if line.startswith("  ")]
            return qc.Solved(answer=shown.index("A piano"), confident=True, single_answer=True, fits_rating=True,
                             fun=4, reason="keys")
    monkeypatch.setattr(qc, "reviewer_model", lambda max_tokens=0: Model())
    import random
    ok, fun, _ = asyncio.run(qc.solve(TEASER, "family", random.Random(3)))
    assert ok and fun == 4


def test_options_are_shuffled_before_saving_and_an_order_is_never_shown_already_right():
    import random
    q = {"options": ["A", "B", "C", "D"], "answer": {"order": [0, 1, 2, 3]}}
    for seed in range(30):
        moved = qc.shuffled(q, random.Random(seed))
        assert [moved["options"][i] for i in moved["answer"]["order"]] == ["A", "B", "C", "D"]
        assert moved["answer"]["order"] != [0, 1, 2, 3]
    choice = qc.shuffled({"options": ["Right", "W1", "W2", "W3"], "answer": {"option": 0}}, random.Random(1))
    assert choice["options"][choice["answer"]["option"]] == "Right"


def test_the_writer_hears_how_each_player_described_their_pick():
    from gamenight_agents.graphs.supervisor import described
    events = [{"kind": "topic_picked", "payload": {"topic": "Cricket", "context": "IPL, the Dhoni years"}},
              {"kind": "topic_picked", "payload": {"topic": "Music", "context": None}},
              {"kind": "interests_picked", "payload": {"interests": ["Anime", "F1"],
                                                       "context": "One Piece, and the Verstappen era"}},
              {"kind": "topic_picked", "payload": {"topic": "cricket", "context": "Test cricket in the 90s"}}]
    assert described(events, "topic_picked", "cricket") == "Test cricket in the 90s"  # the latest wins
    assert described(events, "topic_picked", "music") is None
    assert described(events, "interests_picked", "F1") == "One Piece, and the Verstappen era"
    assert described(events, "interests_picked", "Cricket") is None  # a quiz topic isn't a Heads Up interest
