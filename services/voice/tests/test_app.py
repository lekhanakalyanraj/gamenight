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
