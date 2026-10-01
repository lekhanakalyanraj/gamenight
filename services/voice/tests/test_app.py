from fastapi.testclient import TestClient

from gamenight_voice.app import app

client = TestClient(app)


def test_healthz_reports_ok():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "voice"}


def test_api_docs_are_not_exposed():
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_a_stuck_worker_fails_the_health_check_so_it_is_restarted(monkeypatch):
    import time

    from gamenight_voice import app as app_module
    from gamenight_voice.settings import Settings
    from gamenight_voice.worker import Worker

    stuck = Worker(Settings("postgresql://x", "http://sb", "k", "v@x", "p", provider="fake"), None, None)
    stuck.last_loop = time.monotonic() - 120
    monkeypatch.setattr(app_module, "worker", stuck)
    response = client.get("/healthz")
    assert response.status_code == 503 and response.json()["status"] == "stuck"
