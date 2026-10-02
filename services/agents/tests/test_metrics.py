"""Tier 0: the numbers the dashboards show, as the agents record them (read back from an in-memory exporter)."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from gamenight_agents import telemetry

READER = InMemoryMetricReader()


@pytest.fixture(scope="module", autouse=True)
def provider():
    metrics.set_meter_provider(MeterProvider(metric_readers=[READER]))
    telemetry.game_instruments.cache_clear()
    telemetry._instruments.cache_clear()
    yield


def points(name: str) -> list:
    data = READER.get_metrics_data()
    return [p for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics if m.name == name
            for p in m.data.data_points]


def test_cost_is_estimated_from_the_price_table_and_never_guessed():
    assert telemetry.cost("claude-haiku-4-5-20251001", {"input_tokens": 1_000_000, "output_tokens": 200_000}) == 2.0
    assert telemetry.cost("some-unpriced-model", {"input_tokens": 1000}) is None


def test_a_turn_records_its_time_refusals_recovery_and_time_from_its_event():
    turn = SimpleNamespace(model_calls=3, refused=2, moved=True, lines_rejected=1, stalls_caught=0)
    two_seconds_ago = (datetime.now(UTC) - timedelta(seconds=2)).isoformat()
    telemetry.record_turn("quiz", turn, 1.5, [{"kind": "phase_complete", "at": two_seconds_ago},
                                              {"kind": "game_ended", "at": None}])
    quiz = {"gamenight.game.kind": "quiz"}
    assert [p.value for p in points("gamenight.game_master.refused") if dict(p.attributes) == quiz] == [2]
    assert [p.value for p in points("gamenight.game_master.recovered") if dict(p.attributes) == quiz] == [1]
    assert [p.value for p in points("gamenight.game_master.model_calls") if dict(p.attributes) == quiz] == [3]
    (waited,) = [p for p in points("gamenight.game.event_to_done") if dict(p.attributes) == quiz]
    assert waited.count == 1 and 1.9 < waited.sum < 5  # only events that carry their time count
    (run,) = [p for p in points("gamenight.game_master.run") if dict(p.attributes) == quiz]
    assert run.sum == 1.5
    assert [p.value for p in points("gamenight.games.finished") if dict(p.attributes) == quiz] == [1]


def test_a_turn_without_refusals_counts_none():
    turn = SimpleNamespace(model_calls=0, refused=0, moved=True, lines_rejected=0, stalls_caught=0)
    telemetry.record_turn("heads_up", turn, 0.2, [])
    refused = points("gamenight.game_master.refused")
    assert not [p for p in refused if dict(p.attributes).get("gamenight.game.kind") == "heads_up"]
