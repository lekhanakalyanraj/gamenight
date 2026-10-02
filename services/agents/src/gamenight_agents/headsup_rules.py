"""The Heads Up host: its moves are fixed rules in code, and its lines come from a commentator (scripted here; the
AI's in headsup_commentator). Scripted lines run with GAMENIGHT_MODEL=fake, in CI and local runs, and once a game has
spent its model budget.

The database runs each turn's clock: the countdown, the guessing, the buzzer. The host starts the next turn once a
recap has had its time (so the room isn't rushed) and calls the moments: who's up, a run of Got it, how a turn went,
who won. It never knows a card that isn't public yet (its state has none), and the database refuses any line that
names one.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from gamenight_agents import games, narrator
from gamenight_agents.turn import Turn

MOVES_PER_TURN = 2

# A moment the host calls: {"kind": "turn_start" | "streak" | "turn_end" | "finale", ...}, all of it public.
Moment = dict[str, Any]
Speaker = Callable[[Turn, Moment, dict[str, Any]], Awaitable[None]]


async def play(turn: Turn, speak: Speaker | None = None) -> None:
    for _ in range(MOVES_PER_TURN):
        if not await step(turn, await games.headsup_state(turn.game_id), speak or say_scripted):
            return


def names(s: dict[str, Any]) -> dict[str, str]:
    return {p["member_id"]: p["nickname"] for p in s["players"]}


async def step(turn: Turn, s: dict[str, Any], speak: Speaker | None = None) -> bool:
    """One move (and its line), if the host has one. Returns whether it moved."""
    speak = speak or say_scripted
    g = s["game"]
    who = names(s)
    if g["phase"] == "ended":
        if any(e["kind"] == "game_ended" for e in turn.events) and turn.lines_shown == 0 and s["players"]:
            ranked = sorted(s["players"], key=lambda p: -p["got"])
            await speak(turn, {"kind": "finale", "winner": ranked[0]["nickname"], "got": ranked[0]["got"],
                               "standings": [{"name": p["nickname"], "got": p["got"]} for p in ranked]}, s)
        return False
    if g["paused"]:
        return False

    if g["phase"] in ("setup", "recap") and g["phase_deadline"] is None:
        result = await games.next_turn(turn.game_id, turn.key("next_turn"))
        if result.get("game_over"):
            return True  # the game_ended event brings the finale line
        await speak(turn, {"kind": "turn_start", "turn": result["turn"], "of": result["of"],
                           "guesser": who.get(result["guesser"], "someone"), "first": result["turn"] == 1}, s)
        return True

    if turn.lines_shown:
        return False
    finished = next((e for e in turn.events if e["kind"] == "phase_complete"
                     and (e.get("payload") or {}).get("phase") == "guessing"), None)
    if g["phase"] == "recap" and finished:
        p = finished["payload"]
        recap = s.get("turn") or {}
        cards = recap.get("cards") if recap.get("number") == p.get("turn") else None
        await speak(turn, {"kind": "turn_end", "guesser": who.get(p.get("guesser"), "They"), "got": p.get("got", 0),
                           "passed": p.get("passed", 0), "cards": cards or []}, s)
        return False
    streak = next((e for e in reversed(turn.events) if e["kind"] == "streak"), None)
    if g["phase"] == "guessing" and streak:
        p = streak["payload"]
        await speak(turn, {"kind": "streak", "guesser": who.get(p.get("guesser"), "They"), "streak": p.get("streak"),
                           "got": p.get("got")}, s)
    return False


def scripted_line(m: Moment) -> str:
    if m["kind"] == "turn_start":
        opening = "Heads Up! " if m["first"] else ""
        return f"{opening}Turn {m['turn']} of {m['of']}: {m['guesser']}, turn your back to the TV!"
    if m["kind"] == "streak":
        return f"{m['streak']} in a row for {m['guesser']}! Keep it going!"
    if m["kind"] == "turn_end":
        if m["got"]:
            return f"Time! {m['guesser']} got {m['got']}!"
        return f"Time! Tough one, {m['guesser']}. Zero this round."
    return f"That's Heads Up! {m['winner']} wins with {m['got']} got!"


async def say_scripted(turn: Turn, moment: Moment, s: dict[str, Any]) -> None:
    await narrator.narrate(turn, scripted_line(moment))


def waiting_on_you(s: dict[str, Any]) -> str | None:
    """The move the game is waiting on the host for, if any (nobody else will make it)."""
    g = s["game"]
    if g["phase"] in ("setup", "recap") and g["phase_deadline"] is None and not g["paused"]:
        return "next_turn"
    return None
