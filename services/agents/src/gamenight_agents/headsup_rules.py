"""The scripted Heads Up host: fixed rules that run a whole game with no model (GAMENIGHT_MODEL=fake in CI and local
runs, and until the AI commentator arrives in 6b). It plays through the same database moves and narrator as the AI
will.

The database runs each turn's clock: the countdown, the guessing, the buzzer. The host starts the next turn once a
recap has had its time (so the room isn't rushed) and calls the turns: who's up, how they did, who won. It never
knows a card that isn't public yet (its state has none), and the database refuses any line that names one.
"""

from typing import Any

from gamenight_agents import games, narrator
from gamenight_agents.turn import Turn

MOVES_PER_TURN = 2


async def play(turn: Turn) -> None:
    for _ in range(MOVES_PER_TURN):
        if not await step(turn, await games.headsup_state(turn.game_id)):
            return


def names(s: dict[str, Any]) -> dict[str, str]:
    return {p["member_id"]: p["nickname"] for p in s["players"]}


async def step(turn: Turn, s: dict[str, Any]) -> bool:
    """One move, if the host has one. Returns whether it moved."""
    g = s["game"]
    if g["phase"] == "ended":
        if any(e["kind"] == "game_ended" for e in turn.events) and turn.lines_shown == 0 and s["players"]:
            top = max(s["players"], key=lambda p: p["got"])
            await narrator.narrate(turn, f"That's Heads Up! {top['nickname']} wins with {top['got']} got!")
        return False
    if g["paused"]:
        return False

    if g["phase"] in ("setup", "recap") and g["phase_deadline"] is None:
        result = await games.next_turn(turn.game_id, turn.key("next_turn"))
        if result.get("game_over"):
            return True  # the game_ended event brings the finale line
        guesser = names(s).get(result["guesser"], "someone")
        opening = "Heads Up! " if result["turn"] == 1 else ""
        await narrator.narrate(turn, f"{opening}Turn {result['turn']} of {result['of']}: {guesser}, "
                                     "turn your back to the TV!")
        return True

    finished = next((e for e in turn.events if e["kind"] == "phase_complete"
                     and (e.get("payload") or {}).get("phase") == "guessing"), None)
    if g["phase"] == "recap" and finished and turn.lines_shown == 0:
        p = finished["payload"]
        who = names(s).get(p.get("guesser"), "They")
        got = p.get("got", 0)
        line = f"Time! {who} got {got}!" if got else f"Time! Tough one, {who}. Zero this round."
        await narrator.narrate(turn, line)
        return False
    return False


def waiting_on_you(s: dict[str, Any]) -> str | None:
    """The move the game is waiting on the host for, if any (nobody else will make it)."""
    g = s["game"]
    if g["phase"] in ("setup", "recap") and g["phase_deadline"] is None and not g["paused"]:
        return "next_turn"
    return None
