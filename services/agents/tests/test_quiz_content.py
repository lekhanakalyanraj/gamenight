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
    async def judge(c, sentence, rating, callbacks=None):
        return qc.Verdict(**({"supported": True, "single_answer": True, "unambiguous": True, "lasting": True,
                              "fits_rating": True, "reason": "fine"} | verdict))
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
    ({"source_sentence": "Apollo 11 landed on the Moon in 1972 after a long delay."}, "isn't in the article"),
    ({"source_url": "https://example.com/apollo"}, "isn't an English Wikipedia article"),
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
