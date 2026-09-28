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


def parent_context(traceparent: str | None):
    return propagate.extract({"traceparent": traceparent}) if traceparent else None


def current_traceparent() -> str | None:
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier.get("traceparent")
