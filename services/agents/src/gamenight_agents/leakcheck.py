"""The narrator's first check, in plain code: a line must not give away a secret word or a hidden role.

It blocks a live word however it's written (any case or accent, plural, letters split up, reversed), and,
being deliberately strict, any line naming a player who's still hidden together with a role word. The
safety reviewer (a model) looks for subtler hints after this; the database refuses exact words last.
"""

import re
import unicodedata

ROLE_WORDS = ("undercover", "mr white", "mister white", "civilian", "infiltrator")
STOPWORDS = {"the", "and", "a", "an", "of", "in", "on"}


def normalise(text: str) -> str:
    """Lowercase, accents removed, and anything that isn't a letter or digit turned into single spaces."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def _has(text: str, phrase: str) -> bool:
    return re.search(rf"\b{re.escape(phrase)}(e?s)?\b", text) is not None


def _spelled_out(text: str) -> list[str]:
    """Runs of single letters, joined: "c h a i", "c.h.a.i" and "c-h-a-i" all become "chai"."""
    return ["".join(run.split()) for run in re.findall(r"\b(?:[a-z0-9] )+[a-z0-9]\b", text)]


def word_leaks(line: str, words: list[str]) -> list[str]:
    text = normalise(line)
    spelled = _spelled_out(text)
    reasons = []
    for word in words:
        phrase = normalise(word)
        squashed = phrase.replace(" ", "")
        # A multi-word secret also leaks through its main words ("coffee" for "filter coffee").
        parts = [p for p in phrase.split() if len(p) >= 4 and p not in STOPWORDS] if " " in phrase else []
        if _has(text, phrase) or any(_has(text, p) for p in parts):
            reasons.append(f"it says a secret word ({word})")
        elif any(squashed in s or squashed[::-1] in s for s in spelled) or _has(text, squashed[::-1]):
            reasons.append(f"it spells out or reverses a secret word ({word})")
    return reasons


def role_leaks(line: str, hidden_players: list[str]) -> list[str]:
    """Any role word next to the name of a player whose role hasn't been revealed."""
    text = normalise(line)
    if not any(_has(text, role) for role in ROLE_WORDS):
        return []
    return [f"it names {name} alongside a role" for name in hidden_players if name and _has(text, normalise(name))]


def leaks(line: str, state: dict, picked: tuple[str, ...] = ()) -> list[str]:
    """Why this line can't be shown during this game (empty: it passes). After the end, everything may be said.
    `picked`: the pair's words before the deal, when the game state doesn't hold them yet."""
    if state["game"]["phase"] == "ended":
        return []
    dealt = state.get("words") or {}
    words = [w for w in (dealt.get("civilian"), dealt.get("undercover"), *picked) if w]
    hidden = [p["nickname"] for p in state.get("players", []) if not p.get("revealed_role")]
    return word_leaks(line, words) + role_leaks(line, hidden)
