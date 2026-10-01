"""The narrator's first check, in plain code: a line must not give away a secret word or a hidden role.

It blocks a live word however it's written (any case or accent, plural, letters split up, reversed), and,
being deliberately strict, any line naming a player who's still hidden together with a role word. The
safety reviewer (a model) looks for subtler hints after this; the database refuses exact words last.
"""

import math
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


def says_number(text: str, number: float) -> bool:
    """Whether the text states the number ("1969", "1,969", "8848.86"), not just digits inside a longer one."""
    said = re.findall(r"(?<![\d.])\d[\d,]*(?:\.\d+)?(?![\d.])", text)
    return any(math.isclose(float(n.replace(",", "")), number) for n in said)


def quiz_answer_leaks(line: str, question: dict | None) -> list[str]:
    """A line that gives away a live quiz answer: naming the right option without the others (reading them all out
    is fine), ruling out every other option, or saying an estimate's number. The database refuses the first and the
    last too. The reasons never name the answer: they go back to the quiz master, which isn't told it."""
    if not question or question.get("revealed_at") or not question.get("key"):
        return []
    key = question["key"]
    text = normalise(line)
    if question.get("kind") in ("choice", "picture") and "option" in key and question.get("options"):
        options = [normalise(option) for option in question["options"]]
        right = options[key["option"]]
        others = [o for i, o in enumerate(options) if i != key["option"]]
        named = _has(text, right)
        if named and not all(_has(text, o) for o in others):
            return ["it picks out one option while the question is open: read them all, or none"]
        if not named and others and all(_has(text, o) for o in others):
            return ["it leaves one option out while the question is open: read them all, or none"]
    if question.get("kind") == "estimate" and isinstance(key.get("value"), int | float) \
            and says_number(line, key["value"]):
        return ["it says a number that could be the answer while the question is open"]
    return []
