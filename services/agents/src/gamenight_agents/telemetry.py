"""OpenTelemetry for the agents: one trace from the phone tap to the model call.

- Each run gets a span that continues the caller's trace, from the `traceparent` in the run's metadata
  (the dispatcher and the web proxy put it there).
- A LangChain callback handler adds a span per model call and tool call, with OpenTelemetry's GenAI
  attributes (gen_ai.*), plus token and call metrics.

Exports over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise it's a no-op, so tests and CI run as
before. (LangSmith's own OTel mode ran away on CPU here, so these spans are produced directly.)
"""

import os
from collections.abc import Iterator
from contextlib import contextmanager
from functools import cache
from typing import Any
from uuid import UUID

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult
from opentelemetry import metrics, propagate, trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

SERVICE = "agents"


@cache
def setup() -> None:
    """Install exporters once per process, only when an OTLP endpoint is configured."""
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", SERVICE)})
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(
        MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())])
    )


def tracer() -> trace.Tracer:
    setup()
    return trace.get_tracer("gamenight.agents")


# US dollars per million tokens (input, output), for the dashboards' cost estimate. A model that isn't listed counts
# its tokens but no cost, rather than a guessed one.
PRICES: dict[str, tuple[float, float]] = {
    "claude-haiku-4-5-20251001": (1.00, 5.00),
}


def cost(model: str, usage: dict[str, int]) -> float | None:
    """The estimated cost of one model call, or None for a model without a price here."""
    price = PRICES.get(model)
    if price is None:
        return None
    return (usage.get("input_tokens", 0) * price[0] + usage.get("output_tokens", 0) * price[1]) / 1_000_000


@cache
def _instruments() -> tuple[Any, Any, Any]:
    setup()
    meter = metrics.get_meter("gamenight.agents")
    tokens = meter.create_counter("gamenight.llm.tokens", unit="{token}", description="Model tokens used")
    calls = meter.create_counter("gamenight.llm.calls", unit="{call}", description="Model calls")
    dollars = meter.create_counter("gamenight.llm.cost", unit="{USD}", description="Estimated model cost, US dollars")
    return tokens, calls, dollars


# Buckets for timings in seconds, fine around the 5 s target (the SDK's defaults suit milliseconds: every timing
# here would land in 0-5 and every p95 read 4.75).
SECONDS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 30, 60]


@cache
def game_instruments() -> dict[str, Any]:
    """The game master's numbers, by game kind: how long a turn takes, how long from the event that woke it, how many
    model calls it makes, and how often the database refuses one of its moves (and whether it then made a legal one)."""
    setup()
    meter = metrics.get_meter("gamenight.agents")
    return {
        "run": meter.create_histogram("gamenight.game_master.run", unit="s", description="One game-master turn",
                                      explicit_bucket_boundaries_advisory=SECONDS),
        "event_to_done": meter.create_histogram(
            "gamenight.game.event_to_done", unit="s",
            description="From the database writing an event to the game master finishing its turn",
            explicit_bucket_boundaries_advisory=SECONDS),
        "turns": meter.create_counter("gamenight.game_master.turns", unit="{turn}", description="Game-master turns"),
        "model_calls": meter.create_counter("gamenight.game_master.model_calls", unit="{call}",
                                            description="Model calls in game-master turns"),
        "refused": meter.create_counter("gamenight.game_master.refused", unit="{move}",
                                        description="Game-master moves the database refused (illegal moves)"),
        "refused_turns": meter.create_counter("gamenight.game_master.refused_turns", unit="{turn}",
                                              description="Turns with at least one refused move"),
        "recovered": meter.create_counter("gamenight.game_master.recovered", unit="{turn}",
                                          description="Turns with a refused move that still moved the game on"),
        "lines_rejected": meter.create_counter("gamenight.narrator.rejected", unit="{line}",
                                               description="Lines the narrator's checks rejected"),
        "stalls_caught": meter.create_counter("gamenight.game_master.stalls_caught", unit="{turn}",
                                              description="Turns that left the game waiting, asked again"),
        "finished": meter.create_counter("gamenight.games.finished", unit="{game}",
                                         description="Games that reached their end (for cost per game)"),
    }


def record_turn(kind: str, turn: Any, seconds: float, events: list[dict[str, Any]]) -> None:
    """A game-master turn's numbers, for the dashboards. events: the turn's live events (each with "at", when the
    database wrote it, if the dispatcher sent it)."""
    from datetime import UTC, datetime

    m, labels = game_instruments(), {"gamenight.game.kind": kind}
    m["run"].record(seconds, labels)
    m["turns"].add(1, labels)
    m["model_calls"].add(turn.model_calls, labels)
    m["lines_rejected"].add(turn.lines_rejected, labels)
    m["stalls_caught"].add(turn.stalls_caught, labels)
    if turn.refused:
        m["refused"].add(turn.refused, labels)
        m["refused_turns"].add(1, labels)
        if turn.moved:
            m["recovered"].add(1, labels)
    if any(e.get("kind") == "game_ended" for e in events):
        m["finished"].add(1, labels)
    now = datetime.now(UTC)
    for at in (e.get("at") for e in events):
        if at:
            m["event_to_done"].record((now - datetime.fromisoformat(at)).total_seconds(), labels)


@contextmanager
def run_span(name: str, config: dict[str, Any] | None, **attributes: Any) -> Iterator[Span]:
    """A span for one agent run, continuing the trace named in the run metadata's traceparent."""
    metadata = (config or {}).get("metadata") or {}
    parent = propagate.extract({"traceparent": metadata["traceparent"]}) if metadata.get("traceparent") else None
    # SERVER: the run serves the caller's request, so the service map draws caller → agents.
    with tracer().start_as_current_span(name, context=parent, kind=SpanKind.SERVER) as span:
        for key, value in attributes.items():
            if value is not None:
                span.set_attribute(f"gamenight.{key}", value)
        yield span


def current_traceparent() -> str | None:
    """The active trace as a W3C traceparent (for outgoing calls, e.g. to the catalog)."""
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier.get("traceparent")


class GenAITracer(AsyncCallbackHandler):
    """Model and tool calls as OpenTelemetry spans with gen_ai.* attributes, nested under the current span."""

    def __init__(self, game: str = "other") -> None:
        """game: what the calls are for (a game kind, "lobby" or "chat"), so cost can be told apart by game."""
        self._spans: dict[UUID, Span] = {}
        self._models: dict[UUID, str] = {}
        self._game = game

    def _start(self, run_id: UUID, parent_run_id: UUID | None, name: str, attributes: dict[str, Any]) -> None:
        parent = self._spans.get(parent_run_id) if parent_run_id else None
        context = trace.set_span_in_context(parent) if parent else None
        self._spans[run_id] = tracer().start_span(name, context=context, attributes=attributes)

    def _end(self, run_id: UUID, error: BaseException | None = None) -> Span | None:
        span = self._spans.pop(run_id, None)
        if span is not None:
            if error is not None:
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, type(error).__name__))
            span.end()
        return span

    async def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None, metadata=None, **kwargs):
        model = (metadata or {}).get("ls_model_name") or (kwargs.get("invocation_params") or {}).get("model", "unknown")
        provider = (metadata or {}).get("ls_provider", "unknown")
        self._models[run_id] = model
        self._start(run_id, parent_run_id, f"chat {model}", {
            "gen_ai.operation.name": "chat",
            "gen_ai.system": provider,
            "gen_ai.request.model": model,
        })

    async def on_llm_end(self, response: LLMResult, *, run_id, parent_run_id=None, **kwargs):
        span = self._spans.get(run_id)
        if span is not None:
            usage = _usage(response)
            model = self._models.pop(run_id, "unknown")
            for key, value in usage.items():
                span.set_attribute(f"gen_ai.usage.{key}", value)
            tokens, calls, dollars = _instruments()
            labels = {"gen_ai.request.model": model, "gamenight.game.kind": self._game}
            calls.add(1, labels)
            for kind in ("input_tokens", "output_tokens"):
                if kind in usage:
                    tokens.add(usage[kind], labels | {"gen_ai.token.type": kind.split("_")[0]})
            if (spent := cost(model, usage)) is not None:
                dollars.add(spent, labels)
        self._end(run_id)

    async def on_llm_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self._models.pop(run_id, None)
        self._end(run_id, error)

    async def on_tool_start(self, serialized, input_str, *, run_id, parent_run_id=None, **kwargs):
        name = (serialized or {}).get("name", "tool")
        self._start(run_id, parent_run_id, f"execute_tool {name}", {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
        })

    async def on_tool_end(self, output, *, run_id, parent_run_id=None, **kwargs):
        self._end(run_id)

    async def on_tool_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        self._end(run_id, error)


def _usage(response: LLMResult) -> dict[str, int]:
    """Token counts from the model's usage metadata (input_tokens / output_tokens)."""
    for generations in response.generations:
        for generation in generations:
            message = getattr(generation, "message", None)
            usage = getattr(message, "usage_metadata", None) if message is not None else None
            if usage:
                return {k: int(usage[k]) for k in ("input_tokens", "output_tokens") if k in usage}
    return {}
