"""Text to speech: ElevenLabs, or a free fake voice (a short tone) for CI and the simulator.

Every clip says in the file itself that it's AI-generated (EU AI Act Article 50): an ID3 tag on MP3, an INFO
comment on WAV. The TV also labels the host as AI, so it's marked both where it's heard and where it's kept.
"""

import math
import struct
from dataclasses import dataclass

import httpx

AI_NOTE = "AI-generated speech: the voice of gamenight's AI host"
ELEVENLABS = "https://api.elevenlabs.io/v1/text-to-speech"


@dataclass(frozen=True)
class Clip:
    audio: bytes
    content_type: str
    extension: str


class SpeechError(Exception):
    """The provider didn't return audio: retried a couple of times, then the line stays a caption."""


async def elevenlabs(http: httpx.AsyncClient, key: str, model: str, voice_id: str, text: str) -> Clip:
    try:
        response = await http.post(
            f"{ELEVENLABS}/{voice_id}",
            params={"output_format": "mp3_44100_128"},
            headers={"xi-api-key": key},
            json={"text": text, "model_id": model},
        )
    except httpx.HTTPError as error:
        raise SpeechError(f"ElevenLabs unreachable: {error!r}") from error
    if response.status_code != 200 or not response.content:
        raise SpeechError(f"ElevenLabs {response.status_code}: {response.text[:200]}")
    return Clip(tag_mp3(response.content), "audio/mpeg", "mp3")


def fake(text: str) -> Clip:
    """A quiet tone about as long as the line would take to say: the whole path, for free."""
    return Clip(tone_wav(min(max(len(text) / 15, 0.5), 4.0)), "audio/wav", "wav")


# ---- tagging the files ---------------------------------------------------------------------------------------

def _syncsafe(n: int) -> bytes:
    return bytes((n >> shift) & 0x7F for shift in (21, 14, 7, 0))


def _frame_header(frame_id: bytes, data: bytes) -> bytes:
    return frame_id + struct.pack(">I", len(data)) + b"\x00\x00"  # ID3v2.3 frame sizes aren't syncsafe


def _without_id3(mp3: bytes) -> bytes:
    if mp3[:3] != b"ID3" or len(mp3) < 10:
        return mp3
    size = sum(b << shift for b, shift in zip(mp3[6:10], (21, 14, 7, 0), strict=True))
    footer = 10 if mp3[5] & 0x10 else 0
    return mp3[10 + size + footer:]


def tag_mp3(mp3: bytes) -> bytes:
    """Replaces any ID3v2 tag with ours: a comment and an AI_GENERATED=true field."""
    comment = b"\x00" + b"eng" + b"\x00" + AI_NOTE.encode("latin-1")
    marker = b"\x00" + b"AI_GENERATED\x00" + b"true"
    frames = _frame_header(b"COMM", comment) + comment + _frame_header(b"TXXX", marker) + marker
    return b"ID3\x03\x00\x00" + _syncsafe(len(frames)) + frames + _without_id3(mp3)


def tone_wav(seconds: float, rate: int = 8000) -> bytes:
    """8-bit mono PCM: a soft 440 Hz tone that fades in and out, with an INFO comment saying what it is."""
    n = int(seconds * rate)
    fade = max(1, rate // 20)
    samples = bytes(
        128 + int(24 * min(1.0, i / fade, (n - i) / fade) * math.sin(2 * math.pi * 440 * i / rate)) for i in range(n)
    )
    note = AI_NOTE.encode("ascii") + b" (a fake voice for tests)\x00"
    note += b"\x00" * (len(note) % 2)
    info = b"INFO" + b"ICMT" + struct.pack("<I", len(note)) + note
    fmt = struct.pack("<HHIIHH", 1, 1, rate, rate, 1, 8)
    body = (b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"LIST" + struct.pack("<I", len(info)) + info
            + b"data" + struct.pack("<I", len(samples)) + samples + b"\x00" * (len(samples) % 2))
    return b"RIFF" + struct.pack("<I", len(body)) + body
