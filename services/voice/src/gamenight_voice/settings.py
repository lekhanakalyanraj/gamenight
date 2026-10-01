"""The voice service's settings, all from the environment. Only this service holds the ElevenLabs key."""

import os
from dataclasses import dataclass, field

# ElevenLabs' premade voices, one per persona; any of them can be swapped with VOICE_<PERSONA>_VOICE_ID.
VOICES = {
    "host": "EXAVITQu4vr4xnSDxMaL",  # Sarah: warm and bright, for the lobby
    "undercover": "JBFqnCBsd6RMkjVDRZzb",  # George: a storyteller's voice, for the sly detective
    "quiz": "IKne3meq5aSn9XLyUdCD",  # Charlie: quick and upbeat, for the quiz-show host
}


@dataclass(frozen=True)
class Settings:
    database_url: str
    supabase_url: str
    supabase_key: str  # the publishable key: the voice service signs in to Storage like any user
    storage_email: str
    storage_password: str
    provider: str = "elevenlabs"  # or "fake": a generated tone, free, for CI and the simulator
    elevenlabs_key: str = ""
    model: str = "eleven_flash_v2_5"  # ElevenLabs' fastest model: the room is waiting
    monthly_characters: int | None = 10_000  # None: no cap (the fake voice)
    voices: dict[str, str] = field(default_factory=lambda: dict(VOICES))

    def voice_for(self, persona: str) -> str:
        return self.voices.get(persona) or self.voices["host"]


def from_env() -> Settings:
    provider = os.environ.get("GAMENIGHT_VOICE", "elevenlabs")
    if provider not in ("elevenlabs", "fake"):
        raise ValueError(f"GAMENIGHT_VOICE must be elevenlabs or fake, not {provider!r}")
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if provider == "elevenlabs" and not key:
        raise ValueError("ELEVENLABS_API_KEY is required (or set GAMENIGHT_VOICE=fake)")
    cap = os.environ.get("VOICE_MONTHLY_CHARACTERS")
    return Settings(
        database_url=os.environ["DATABASE_URL"],
        supabase_url=os.environ["SUPABASE_URL"].rstrip("/"),
        supabase_key=os.environ["SUPABASE_PUBLISHABLE_KEY"],
        storage_email=os.environ["VOICE_STORAGE_EMAIL"],
        storage_password=os.environ["VOICE_STORAGE_PASSWORD"],
        provider=provider,
        elevenlabs_key=key,
        model=os.environ.get("VOICE_MODEL", "eleven_flash_v2_5"),
        monthly_characters=int(cap) if cap else (10_000 if provider == "elevenlabs" else None),
        voices={p: os.environ.get(f"VOICE_{p.upper()}_VOICE_ID", v) for p, v in VOICES.items()},
    )
