"""The voice service's HTTP app. For now it only reports healthy; slice 4 adds narration to audio."""

from fastapi import FastAPI

app = FastAPI(title="gamenight voice", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "voice"}
