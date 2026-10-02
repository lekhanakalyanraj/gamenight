"""Tier 0: the load test's report: percentiles, targets, and what gates."""

import argparse

from gamenight_simulator.game import GameReport
from gamenight_simulator.load import Load, markdown, passed, percentile, summarise


def report(number, policy="sly", completed=True, gm=(1.0, 2.0), clips=(0.5,), leaks=()):
    r = GameReport(number, 5, policy, False, {})
    r.completed, r.gm_seconds, r.clip_seconds, r.leaks = completed, list(gm), list(clips), list(leaks)
    return r


def test_percentiles_take_the_value_at_the_rank():
    assert percentile([], 0.95) is None
    assert percentile([5, 1, 3, 2, 4], 0.5) == 3
    assert percentile(list(range(1, 101)), 0.95) == 96


def run(reports, move_ms, strict=False):
    load = Load(reports=reports, move_ms=move_ms, rooms_ready=2)
    return summarise(load, argparse.Namespace(load=2), 60.0, [])


def test_targets_are_checked_and_latency_only_gates_when_strict():
    s = run([report(1), report(2, "quiz"), report(3, "headsup", gm=(9.0,))], [100.0] * 19 + [900.0])
    assert s["by_game"] == {"undercover": 1, "quiz": 1, "headsup": 1}
    assert s["targets"]["tap_to_own_screen_p95_ms"] == {"value": 900.0, "target": 300.0, "met": False}
    assert s["targets"]["next_phase_p95_s"]["met"] is False and s["targets"]["completion"]["met"] is True
    assert passed(s, strict=False) and not passed(s, strict=True)
    md = markdown(s, strict=False)
    assert "| Tap → own screen (p95) | 900 ms | < 300 ms | **no** |" in md and "**0 leaks**" in md


def test_a_leak_or_too_few_completed_games_always_fails():
    assert not passed(run([report(1, leaks=["a card on the room topic"])], [100.0]), strict=False)
    assert not passed(run([report(i, completed=i > 1) for i in range(1, 11)], [100.0]), strict=False)  # 90% < 98%
