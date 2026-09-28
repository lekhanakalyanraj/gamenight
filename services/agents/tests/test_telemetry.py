"""Tier 0: an agent run continues the caller's trace, and model calls become gen_ai spans under it."""

import asyncio

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from gamenight_agents import host
from gamenight_agents.graphs.supervisor import graph

exporter = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(exporter))
trace.set_tracer_provider(_provider)

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
CALLER_SPAN = "00f067aa0ba902b7"


def test_host_chat_continues_the_callers_trace_with_gen_ai_spans(monkeypatch):
    monkeypatch.setenv("GAMENIGHT_MODEL", "fake")
    host.host_agent.cache_clear()
    exporter.clear()
    config = {
        "configurable": {"thread_id": "room-1"},
        "metadata": {"traceparent": f"00-{TRACE_ID}-{CALLER_SPAN}-01"},
    }
    asyncio.run(graph.ainvoke({"messages": [("user", "What should we play?")]}, config))

    spans = {s.name: s for s in exporter.get_finished_spans()}
    run = spans["agents.host_chat"]
    assert format(run.context.trace_id, "032x") == TRACE_ID  # same trace as the web request
    assert format(run.parent.span_id, "016x") == CALLER_SPAN
    assert run.attributes["gamenight.room_id"] == "room-1"

    chat = next(s for name, s in spans.items() if name.startswith("chat "))
    assert chat.attributes["gen_ai.operation.name"] == "chat"
    assert chat.context.trace_id == run.context.trace_id
    assert chat.parent.span_id == run.context.span_id  # nested under the run


def test_without_a_traceparent_the_run_starts_its_own_trace(monkeypatch):
    monkeypatch.setenv("GAMENIGHT_MODEL", "fake")
    host.host_agent.cache_clear()
    exporter.clear()
    asyncio.run(graph.ainvoke({"messages": [("user", "hi")]}, {"configurable": {"thread_id": "room-2"}}))
    run = next(s for s in exporter.get_finished_spans() if s.name == "agents.host_chat")
    assert run.parent is None
