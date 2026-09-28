import json
import urllib.request

from gamenight_dispatcher.health import serve_health


def test_healthz_reports_ok():
    server = serve_health(0)  # any free port
    try:
        port = server.server_address[1]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz") as response:
            assert response.status == 200
            assert json.load(response) == {"status": "ok", "service": "dispatcher"}
    finally:
        server.shutdown()


def test_other_paths_are_not_found():
    server = serve_health(0)
    try:
        port = server.server_address[1]
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/")
            raise AssertionError("expected 404")
        except urllib.error.HTTPError as error:
            assert error.code == 404
    finally:
        server.shutdown()
