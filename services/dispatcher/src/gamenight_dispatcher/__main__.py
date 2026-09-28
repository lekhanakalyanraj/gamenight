"""Entry point: the health endpoint plus the dispatch loop."""

import asyncio
import logging
import os
import signal

from gamenight_dispatcher.agents import AgentServer
from gamenight_dispatcher.dispatcher import run
from gamenight_dispatcher.health import serve_health


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    serve_health(int(os.environ.get("PORT", "8080")))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await run(os.environ["DATABASE_URL"], AgentServer(os.environ["AGENTS_URL"]), stop)


if __name__ == "__main__":
    asyncio.run(main())
