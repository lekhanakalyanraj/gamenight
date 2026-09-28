import asyncio
from types import SimpleNamespace

import jwt
import pytest
from langgraph_sdk import Auth

from gamenight_agents import auth, db


@pytest.fixture(autouse=True)
def token(monkeypatch):
    monkeypatch.setenv("AGENTS_SERVICE_TOKEN", "test-service-token")


def headers(token="test-service-token"):
    return {b"x-gamenight-service-token": token.encode()} if token else {}


def run(coro):
    return asyncio.run(coro)


def status(coro):
    with pytest.raises(Auth.exceptions.HTTPException) as caught:
        run(coro)
    return caught.value.status_code


def test_every_request_needs_the_service_token():
    assert status(auth.authenticate(headers(None), None)) == 401
    assert status(auth.authenticate(headers("wrong"), None)) == 401
    assert status(auth.authenticate(headers("test-service-token-but-longer"), "Bearer x")) == 401


def test_the_token_alone_is_the_dispatcher():
    user = run(auth.authenticate(headers(), None))
    assert user["permissions"] == ["service"]


def test_a_forged_login_is_refused(monkeypatch):
    def bad(token):
        raise jwt.InvalidSignatureError("bad signature")

    monkeypatch.setattr(auth, "verify_supabase_jwt", bad)
    assert status(auth.authenticate(headers(), "Bearer forged")) == 401


def test_guests_cannot_chat_with_the_host_agent(monkeypatch):
    monkeypatch.setattr(auth, "verify_supabase_jwt", lambda t: {"sub": "guest-1", "is_anonymous": True})
    assert status(auth.authenticate(headers(), "Bearer guest")) == 403


def test_a_signed_in_host_is_a_host(monkeypatch):
    monkeypatch.setattr(auth, "verify_supabase_jwt", lambda t: {"sub": "host-1", "is_anonymous": False})
    assert run(auth.authenticate(headers(), "Bearer ok")) == {"identity": "host-1", "permissions": ["host"]}


def ctx(identity, permissions):
    return SimpleNamespace(user=SimpleNamespace(identity=identity), permissions=permissions)


@pytest.fixture
def hosts(monkeypatch):
    async def is_room_host(room_id, user_id):
        return (room_id, user_id) == ("room-a", "host-a")

    monkeypatch.setattr(db, "is_room_host", is_room_host)


def test_hosts_reach_only_their_own_room_thread(hosts):
    assert run(auth._room_host_only(ctx("host-a", ["host"]), {"thread_id": "room-a"})) is True
    assert status(auth._room_host_only(ctx("host-a", ["host"]), {"thread_id": "room-b"})) == 403
    assert status(auth._room_host_only(ctx("host-b", ["host"]), {"thread_id": "room-a"})) == 403
    assert status(auth._room_host_only(ctx("host-a", ["host"]), {})) == 403


def test_the_dispatcher_reaches_every_room_thread(hosts):
    assert run(auth._room_host_only(ctx("service:internal", ["service"]), {"thread_id": "room-z"})) is True


def test_anything_not_explicitly_allowed_is_denied_to_hosts():
    assert status(auth.deny_by_default(ctx("host-a", ["host"]), {})) == 403
    assert run(auth.deny_by_default(ctx("service:internal", ["service"]), {})) is True
