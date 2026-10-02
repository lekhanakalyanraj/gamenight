"""OpenTelemetry for the voice service: a span per voiced line, plus how long a line waits for its clip, the
characters sent to the provider, and each line's outcome. Exports over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT
is set; otherwise it's a no-op."""

import os
from functools import cache
from typing import Any

from opentelemetry import metrics, trace


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

    resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "voice")})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    metrics.set_meter_provider(
        MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())])
    )


def tracer() -> trace.Tracer:
    setup()
    return trace.get_tracer("gamenight.voice")


@cache
def instruments() -> dict[str, Any]:
    setup()
    meter = metrics.get_meter("gamenight.voice")
    return {
        "latency": meter.create_histogram(
            "gamenight.voice.latency", unit="ms", description="From a line being shown to its clip being ready",
            # fine around the 4 s target (the SDK's defaults jump from 2.5 s to 5 s)
            explicit_bucket_boundaries_advisory=[100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000],
        ),
        "characters": meter.create_counter(
            "gamenight.voice.characters", unit="{character}", description="Characters sent to text to speech"
        ),
        "lines": meter.create_counter(
            "gamenight.voice.lines", unit="{line}", description="Lines handled, by outcome"
        ),
    }
