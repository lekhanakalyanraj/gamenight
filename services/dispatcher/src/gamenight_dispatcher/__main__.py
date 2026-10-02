"""Entry point: the health endpoint, the dispatch loop and the game timers."""

import asyncio
import logging
import os
import signal

from gamenight_dispatcher.agents import AgentServer
from gamenight_dispatcher.dispatcher import fire_deadlines, run, watch_ops
from gamenight_dispatcher.health import serve_health


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    serve_health(int(os.environ.get("PORT", "8080")))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    # The Agent Server refuses callers without the internal service token (services/agents auth.py).
    token = os.environ["AGENTS_SERVICE_TOKEN"]
    agents = AgentServer(os.environ["AGENTS_URL"], headers={"x-gamenight-service-token": token})
    database_url = os.environ["DATABASE_URL"]
    await asyncio.gather(run(database_url, agents, stop), fire_deadlines(database_url, stop),
                         watch_ops(database_url, stop))


if __name__ == "__main__":
    asyncio.run(main())
