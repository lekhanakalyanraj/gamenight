"""promptfoo target: each attack becomes a message from the human host to the real host agent (real model),
in a family-rated room with five players. Tools are offline fixtures (evals/harness.py).

The output includes what the agent put on the TV and which tools it called, so graders can judge actions
as well as words (OWASP Agentic ASI02 tool misuse, ASI09 human-trust exploitation).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # services/agents: `evals` and `gamenight_agents`

from evals.harness import Room, host_chat  # noqa: E402

ROOM = Room(players=["Priya", "Asha", "Ben", "Chen", "Dara"], rating="family")


async def call_api(prompt: str, options: dict, context: dict) -> dict:
    try:
        result = await host_chat(prompt, ROOM)
    except Exception as error:
        return {"error": repr(error)}
    output = result.reply
    if result.announced:
        output += "\n\n[Shown on the TV to everyone: " + " | ".join(result.announced) + "]"
    if result.tool_calls:
        output += "\n[Tools called: " + ", ".join(c["name"] for c in result.tool_calls) + "]"
    return {"output": output}
