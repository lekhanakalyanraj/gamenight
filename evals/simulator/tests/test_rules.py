"""The simulator's own rules: the role mixes it picks, its judge, and what it counts as a leak."""

import random

from gamenight_simulator.leaks import broadcast_leaks, mentions, private_topic_leaks, public_leaks
from gamenight_simulator.referee import legal_mix, same_word


def test_every_mix_the_referee_picks_is_one_the_database_accepts():
    rng = random.Random(7)
    for players in range(3, 17):
        for _ in range(50):
            undercovers, whites = legal_mix(players, rng)
            assert undercovers >= 1
            assert whites <= (2 if players >= 10 else 1 if players >= 5 else 0)
            assert players - undercovers - whites > undercovers + whites


def test_the_scripted_judge_ignores_case_spacing_and_plurals():
    assert same_word("  Filter   Coffee ", "filter coffee")
    assert same_word("samosas", "samosa")
    assert not same_word("coffee", "tea")
    assert not same_word(None, "tea")


def test_words_are_matched_whole_and_in_the_plural():
    assert mentions("I love TEAs", "tea")
    assert mentions('{"text": "tea"}', "tea")
    assert not mentions("steady teacher", "tea")
    assert mentions("the double-decker bus!", "double-decker bus")


def broadcast(table, record):
    return {"event": "UPDATE", "payload": {"table": table, "record": record}, "type": "broadcast"}


def test_a_word_or_a_live_players_role_before_the_end_is_a_leak():
    leaks = broadcast_leaks([
        broadcast("games", {"phase": "vote", "config": {"theme": "drinks"}}),
        broadcast("host_lines", {"text": "Is it chai?"}),
        broadcast("game_players", {"member_id": "m1", "alive": True, "revealed_role": "undercover"}),
    ], ["chai", "filter coffee"])
    assert leaks == ["host_lines row mentions a secret word", "game_players shows the role of m1, who is still in"]


def test_nothing_after_the_end_counts_because_the_end_reveals_everything():
    rows = [
        ("game_players", {"member_id": "m1", "alive": False, "revealed_role": "civilian"}),
        ("games", {"phase": "ended", "reveal": {"words": {"civilian": "chai"}}}),
        ("game_players", {"member_id": "m2", "alive": True, "revealed_role": "mr_white"}),
    ]
    assert public_leaks(rows, ["chai"]) == []


def test_a_private_topic_carries_only_its_own_rows():
    own = broadcast("secrets", {"member_id": "m1", "payload": {"role": "civilian", "word": "chai"}})
    other = broadcast("game_actions", {"member_id": "m2", "kind": "vote"})
    assert private_topic_leaks([own], "m1") == []
    assert private_topic_leaks([own, other], "m1") == ["member:m1 was sent a game_actions row belonging to m2"]


def test_narration_may_not_say_a_word_or_pair_a_hidden_player_with_their_role():
    from gamenight_simulator.leaks import narration_leaks

    lines = [
        {"created_at": "2026-09-29T10:00:01+00:00", "text": "Ben... are you the UNDERCOVER?"},
        {"created_at": "2026-09-29T10:00:02+00:00", "text": "Asha was a civilian."},  # after her reveal
        {"created_at": "2026-09-29T10:00:03+00:00", "text": "Mmm, chai."},
        {"created_at": "2026-09-29T10:00:09+00:00", "text": "The word was chai and Ben was undercover!"},  # the end
    ]
    leaks = narration_leaks(lines, ["chai"], {"Ben": "undercover", "Asha": "civilian"},
                            {"Asha": "2026-09-29T10:00:01.500+00:00"}, "2026-09-29T10:00:08+00:00")
    assert leaks == ["the host paired Ben with their hidden role: 'Ben... are you the UNDERCOVER?'",
                     "the host said a secret word: 'Mmm, chai.'"]
