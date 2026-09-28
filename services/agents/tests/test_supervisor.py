from gamenight_agents.graphs.supervisor import graph


def test_host_chat_goes_to_the_host():
    result = graph.invoke({"messages": [("user", "hi")]})
    assert "host agent" in result["messages"][-1].content


def test_game_events_are_routed_and_consumed():
    result = graph.invoke({"messages": [], "event": {"type": "phase_complete"}})
    assert result["messages"][-1].content == "Received game event: phase_complete"
    assert result["event"] is None
