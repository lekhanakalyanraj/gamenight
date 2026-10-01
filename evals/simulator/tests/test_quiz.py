"""The simulator's own view of the quiz rules: it recomputes every score, so it must agree with the database on
the same cases the pgTAP test proves (875 and 625 for speed, 1000/667/333 for estimates, 1500 with the joker)."""

from gamenight_simulator.quiz import broadcast_answer_leaks, early_answer_lines, expected_points

T0 = "2026-10-01T10:00:00+00:00"


def at(seconds: float) -> str:
    return f"2026-10-01T10:00:{seconds:09.6f}+00:00"


def answer(member, value, seconds=0.0, joker=False):
    return {"member_id": member, "answer": value, "answered_at": at(seconds), "joker": joker}


def test_a_right_answer_scores_more_the_faster_it_came_and_a_wrong_one_nothing():
    q = {"kind": "choice", "answer": {"option": 1}, "opened_at": T0, "seconds": 20}
    got = expected_points(q, [answer("asha", {"option": 1}, 5), answer("chen", {"option": 1}, 15),
                              answer("ben", {"option": 0}, 1)])
    assert got == {"asha": 875, "chen": 625, "ben": 0}


def test_the_joker_doubles():
    q = {"kind": "choice", "answer": {"option": 1}, "opened_at": T0, "seconds": 20}
    assert expected_points(q, [answer("priya", {"option": 1}, 10, joker=True)]) == {"priya": 1500}


def test_estimates_score_by_how_close_they_came_and_ties_share_a_place():
    q = {"kind": "estimate", "answer": {"value": 8848.86}, "opened_at": T0, "seconds": 30}
    got = expected_points(q, [answer("asha", {"value": 9000}), answer("ben", {"value": 8800}),
                              answer("chen", {"value": 5000})])
    assert got == {"ben": 1000, "asha": 667, "chen": 333}
    tied = expected_points(q, [answer("a", {"value": 8800}), answer("b", {"value": 8897.72})])
    assert tied == {"a": 1000, "b": 1000}  # both 48.86 away


def test_a_line_singling_out_the_live_answer_is_a_leak_but_reading_every_option_is_not():
    q = {"number": 2, "kind": "choice", "options": ["Sydney", "Canberra"], "answer": {"option": 1},
         "opened_at": at(0), "revealed_at": at(20)}
    lines = [{"text": "Sydney or Canberra?", "created_at": at(1)},
             {"text": "It's Canberra!", "created_at": at(2)},
             {"text": "Canberra, of course.", "created_at": at(25)}]  # after the reveal: fine
    assert early_answer_lines(lines, [q]) == ["question 2: the host singled out the answer early: \"It's Canberra!\""]


def test_an_answer_broadcast_before_its_reveal_is_a_leak():
    def change(table, **row):
        return {"payload": {"table": table, "record": row}}

    leaks = broadcast_answer_leaks([
        change("quiz_questions", number=1, answer=None, revealed_at=None),
        change("quiz_questions", number=1, answer={"option": 1}, revealed_at=at(20)),
        change("quiz_questions", number=2, answer={"option": 0}, revealed_at=None),
        change("quiz_answers", member_id="asha"),
    ])
    assert leaks == ["question 2's answer was broadcast before its reveal",
                     "a player's answer was broadcast to the whole room"]
