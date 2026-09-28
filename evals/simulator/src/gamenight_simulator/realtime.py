"""A minimal Supabase Realtime client: the Phoenix channel protocol over one websocket. It joins private
topics as one user and keeps every broadcast that arrives, so the simulator can check what each screen
was sent."""

import asyncio
import contextlib
import itertools
import json
from typing import Any

import websockets

# Realtime takes a few seconds to refuse a topic the user may not read.
JOIN_TIMEOUT = 20.0


class Realtime:
    def __init__(self, url: str, key: str, token: str):
        self._url = url.replace("http", "ws", 1) + f"/realtime/v1/websocket?apikey={key}&vsn=1.0.0"
        self.token = token  # sent with each join, so a refreshed login applies to the next topic
        self._refs = itertools.count(1)
        self._replies: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._tasks: list[asyncio.Task] = []
        self._ws: Any = None
        self._watching: set[str] = set()  # topics joined or being joined; late messages for others are dropped
        self._refused: set[str] = set()
        self.broadcasts: dict[str, list[dict[str, Any]]] = {}
        self.interruptions: list[str] = []  # channel errors or a dropped socket: broadcasts may have been lost

    async def __aenter__(self) -> "Realtime":
        self._ws = await websockets.connect(self._url, max_size=2**22)
        self._tasks = [asyncio.create_task(self._read()), asyncio.create_task(self._heartbeat())]
        return self

    async def __aexit__(self, *exc: object) -> None:
        for task in self._tasks:
            task.cancel()
        with contextlib.suppress(Exception):
            await self._ws.close()

    async def _send(self, topic: str, event: str, payload: dict[str, Any]) -> str:
        ref = str(next(self._refs))
        message = {"topic": topic, "event": event, "payload": payload, "ref": ref, "join_ref": ref}
        await self._ws.send(json.dumps(message))
        return ref

    async def join(self, topic: str) -> bool:
        """Joins a private topic. False if Realtime refuses it, which means RLS on realtime.messages said no.
        Anything that arrives on the topic is kept either way, so a refused topic that still delivers shows up."""
        self._watching.add(topic)
        self.broadcasts.setdefault(topic, [])
        ref = str(next(self._refs))
        reply = self._replies[ref] = asyncio.get_running_loop().create_future()
        await self._ws.send(json.dumps({
            "topic": f"realtime:{topic}", "event": "phx_join", "ref": ref, "join_ref": ref,
            "payload": {
                "config": {"broadcast": {"self": False}, "presence": {"key": ""}, "postgres_changes": [],
                           "private": True},
                "access_token": self.token,
            },
        }))
        if self._tasks[0].done():
            raise ConnectionError("the Realtime connection has closed")
        joined = (await asyncio.wait_for(reply, JOIN_TIMEOUT)).get("status") == "ok"
        if not joined:
            self._refused.add(topic)
        return joined

    async def leave(self, topic: str) -> None:
        self._watching.discard(topic)
        await self._send(f"realtime:{topic}", "phx_leave", {})

    async def _read(self) -> None:
        async for raw in self._ws:
            message = json.loads(raw)
            topic = message.get("topic", "").removeprefix("realtime:")
            if message.get("event") == "phx_reply":
                reply = self._replies.pop(message.get("ref"), None)
                if reply is not None and not reply.done():
                    reply.set_result(message["payload"])
            elif message.get("event") == "broadcast" and topic in self._watching:
                self.broadcasts[topic].append(message["payload"])
            elif topic in self._watching - self._refused and (message.get("event") in ("phx_error", "phx_close") or (
                    message.get("event") == "system" and message.get("payload", {}).get("status") not in (None, "ok"))):
                self.interruptions.append(f"{message['event']} on {topic}: {json.dumps(message.get('payload'))[:120]}")
        self.interruptions.append("the socket closed")

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(20)
            await self._send("phoenix", "heartbeat", {})
