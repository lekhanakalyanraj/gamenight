"""Tier 0: the Docker image runs what `langgraph dev` runs.

langgraph.json configures the graphs and the custom auth for the dev server; the image sets the same through
environment variables. They drifted once: the image served only the host agent's graph, and with no custom auth,
so it answered requests without the internal service token.
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def image_env() -> dict[str, dict]:
    dockerfile = (ROOT / "Dockerfile").read_text()
    return {name: json.loads(value) for name, value in re.findall(r"^ENV (\w+)='(\{.*\})'$", dockerfile, re.MULTILINE)}


def in_image(path: str) -> str:
    return "/deps/agents/" + path.removeprefix("./")


def test_the_image_serves_every_graph_langgraph_json_does():
    config = json.loads((ROOT / "langgraph.json").read_text())
    assert image_env()["LANGSERVE_GRAPHS"] == {name: in_image(path) for name, path in config["graphs"].items()}


def test_the_image_enforces_the_custom_auth():
    config = json.loads((ROOT / "langgraph.json").read_text())
    assert image_env().get("LANGGRAPH_AUTH") == {"path": in_image(config["auth"]["path"])}


def test_the_scripted_models_can_be_dumped_to_json(monkeypatch):
    # Regression: the Agent Server dumps a run's model to JSON, and a model holding an endless iterator
    # (cycle([...])) never finished dumping: the image's server ran out of memory on the first host chat.
    import json

    from gamenight_agents import models

    monkeypatch.setenv("GAMENIGHT_MODEL", "fake")
    for make in (models.host_model, models.chat_model):
        dumped = make().model_dump(mode="json")
        assert json.dumps(dumped) and dumped["reply"]
