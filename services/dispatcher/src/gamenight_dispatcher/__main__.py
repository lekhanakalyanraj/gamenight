"""Entry point. For now the dispatcher only reports healthy; slice 2 adds the outbox consumer and timers."""

import logging
import os
import signal
import threading

from gamenight_dispatcher.health import serve_health

log = logging.getLogger("gamenight.dispatcher")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    port = int(os.environ.get("PORT", "8080"))
    server = serve_health(port)
    log.info("health on :%d; outbox consumer arrives in slice 2", port)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    stop.wait()
    server.shutdown()


if __name__ == "__main__":
    main()
