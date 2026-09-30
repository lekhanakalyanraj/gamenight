"""Entry point for local runs (make voice-dev): the same app the image serves."""

import os

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("gamenight_voice.app:app", host="0.0.0.0", port=port, log_level="warning")
