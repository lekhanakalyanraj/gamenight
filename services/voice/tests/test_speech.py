"""Tier 0: the clips themselves, the fake voice, the cache key and the settings. No network, no database."""

import io
import wave

import pytest

from gamenight_voice import speech
from gamenight_voice.settings import from_env
from gamenight_voice.worker import cache_key


def id3_frames(mp3: bytes) -> dict[bytes, bytes]:
    assert mp3[:5] == b"ID3\x03\x00"
    size = sum(b << s for b, s in zip(mp3[6:10], (21, 14, 7, 0), strict=True))
    frames, i = {}, 10
    while i < 10 + size:
        frame_id, length = mp3[i:i + 4], int.from_bytes(mp3[i + 4:i + 8], "big")
        frames[frame_id] = mp3[i + 10:i + 10 + length]
        i += 10 + length
    return frames


def test_every_mp3_clip_says_in_the_file_that_its_ai_generated():
    audio = b"\xff\xfb\x90\x00" * 8  # MPEG frames, as ElevenLabs returns them
    tagged = speech.tag_mp3(audio)
    frames = id3_frames(tagged)
    assert frames[b"TXXX"] == b"\x00AI_GENERATED\x00true"
    assert b"AI-generated speech" in frames[b"COMM"]
    assert tagged.endswith(audio)


def test_a_tag_the_provider_added_is_replaced_not_stacked():
    theirs = speech.tag_mp3(b"\xff\xfb\x90\x00")
    ours = speech.tag_mp3(theirs)
    assert ours.count(b"ID3") == 1 and ours.endswith(b"\xff\xfb\x90\x00")


def test_the_fake_voice_is_a_real_wav_about_as_long_as_the_line_and_says_what_it_is():
    short, long = speech.fake("Hi."), speech.fake("A much longer line that would take a few seconds to say out loud.")
    assert short.content_type == "audio/wav" and short.extension == "wav"
    with wave.open(io.BytesIO(long.audio)) as clip:
        seconds = clip.getnframes() / clip.getframerate()
        assert clip.getnchannels() == 1 and 3.5 < seconds <= 4.0
    with wave.open(io.BytesIO(short.audio)) as clip:
        assert clip.getnframes() / clip.getframerate() == 0.5
    assert b"ICMT" in long.audio and b"AI-generated speech" in long.audio


def test_the_cache_key_changes_with_the_voice_the_model_or_the_text():
    base = cache_key("v1", "m1", "Hello")
    assert base == cache_key("v1", "m1", "Hello")
    assert len({base, cache_key("v2", "m1", "Hello"), cache_key("v1", "m2", "Hello"), cache_key("v1", "m1", "Hi")}) == 4


@pytest.fixture
def env(monkeypatch):
    for name, value in {"DATABASE_URL": "postgresql://x", "SUPABASE_URL": "http://sb/", "SUPABASE_PUBLISHABLE_KEY": "k",
                        "VOICE_STORAGE_EMAIL": "v@x", "VOICE_STORAGE_PASSWORD": "p"}.items():
        monkeypatch.setenv(name, value)
    for name in ("GAMENIGHT_VOICE", "ELEVENLABS_API_KEY", "VOICE_MONTHLY_CHARACTERS", "VOICE_UNDERCOVER_VOICE_ID"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_the_real_voice_needs_a_key_and_is_capped_by_default(env):
    with pytest.raises(ValueError, match="ELEVENLABS_API_KEY"):
        from_env()
    env.setenv("ELEVENLABS_API_KEY", "key")
    settings = from_env()
    assert settings.provider == "elevenlabs" and settings.monthly_characters == 10_000
    assert settings.supabase_url == "http://sb"


def test_the_fake_voice_is_free_and_uncapped_and_voices_can_be_swapped(env):
    env.setenv("GAMENIGHT_VOICE", "fake")
    env.setenv("VOICE_UNDERCOVER_VOICE_ID", "custom")
    settings = from_env()
    assert settings.monthly_characters is None
    assert settings.voice_for("undercover") == "custom"
    assert settings.voice_for("mafia") == settings.voice_for("host")  # a game without its own voice yet
