"""OpenTelemetry for the dispatcher: a span per room batch that continues the trace of the request that
caused the event (its traceparent), handed on to the agents; plus outbox lag and delivery metrics.
Exports over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise it's a no-op."""

import os
from functools import cache
from typing import Any

from opentelemetry import metrics, propagate, trace


@cache
def setup() -> None:
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "dispatcher")})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    metrics.set_meter_provider(
        MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())])
    )


def tracer() -> trace.Tracer:
    setup()
    return trace.get_tracer("gamenight.dispatcher")


@cache
def instruments() -> dict[str, Any]:
    setup()
    meter = metrics.get_meter("gamenight.dispatcher")
    return {
        "lag": meter.create_histogram(
            "gamenight.dispatch.lag", unit="ms", description="Time an event waited in the outbox before its run started"
        ),
        "dispatched": meter.create_counter(
            "gamenight.dispatch.events", unit="{event}", description="Events handed to agents"
        ),
        "failed": meter.create_counter(
            "gamenight.dispatch.failures", unit="{event}", description="Events that failed to dispatch"
        ),
    }


# The latest operations numbers (dispatch.ops_stats), refreshed every 15 s and read by the gauges when metrics are
# exported. Counts only: rooms open, players in them, games running by kind.
OPS: dict[str, Any] = {}


def _observe(key: str):
    from opentelemetry.metrics import Observation

    def callback(_options):
        value = OPS.get(key)
        if isinstance(value, dict):
            return [Observation(n, {"gamenight.game.kind": kind}) for kind, n in value.items()]
        return [Observation(value)] if value is not None else []
    return callback


@cache
def ops_gauges() -> None:
    setup()
    meter = metrics.get_meter("gamenight.dispatcher")
    meter.create_observable_gauge("gamenight.rooms.open", [_observe("rooms_open")], unit="{room}",
                                  description="Rooms not closed")
    meter.create_observable_gauge("gamenight.rooms.players", [_observe("players_in_rooms")], unit="{player}",
                                  description="Players in open rooms")
    meter.create_observable_gauge("gamenight.games.running", [_observe("games_running")], unit="{game}",
                                  description="Games not ended, by kind")


def parent_context(traceparent: str | None):
    return propagate.extract({"traceparent": traceparent}) if traceparent else None


def current_traceparent() -> str | None:
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier.get("traceparent")
