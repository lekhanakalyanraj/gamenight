"""The scripted game master: fixed rules in place of the model (GAMENIGHT_MODEL=fake, and the fallback once a
game has used its model budget). It plays through the same database moves, content specialist and narrator
as the AI, so CI runs the whole pipeline for free. Some of its lines deliberately try to leak the word, to
prove the narrator stops them.
"""

from typing import Any

from gamenight_agents import content, games, narrator
from gamenight_agents.turn import Turn

MOVES_PER_TURN = 6


def legal_mix(players: int, rng) -> tuple[int, int]:
    """A role mix the database accepts: (undercovers, Mr. Whites)."""
    max_whites = 2 if players >= 10 else 1 if players >= 5 else 0
    while True:
        whites, undercovers = rng.randint(0, max_whites), rng.randint(1, max(1, players // 3))
        if players - undercovers - whites > undercovers + whites:
            return undercovers, whites


def same_word(guess: str | None, word: str) -> bool:
    def norm(text: str) -> str:
        return " ".join(text.lower().split()).removesuffix("s")

    return guess is not None and norm(guess) == norm(word)


async def say(turn: Turn, line: str, state: dict[str, Any]) -> None:
    """Now and then, first tries a line that spells out the civilians' word; the narrator must refuse it."""
    word = (state.get("words") or {}).get("civilian")
    if word and state["game"]["phase"] != "ended" and turn.rng.random() < 0.3:
        leaky = f"Psst... is it {' '.join(word.replace(' ', ''))}?"
        result = await narrator.narrate(turn, leaky)
        if result["shown"] and result["text"] == leaky:
            raise AssertionError(f"the narrator let a spelled-out secret word through: {result}")
    await narrator.narrate(turn, line)


async def play(turn: Turn) -> None:
    for _ in range(MOVES_PER_TURN):
        if not await step(turn, await games.state(turn.game_id)):
            return


async def step(turn: Turn, s: dict[str, Any]) -> bool:
    """One move, if the game master has one. Returns whether it moved."""
    g, rng, game = s["game"], turn.rng, turn.game_id
    alive = [p["member_id"] for p in s["players"] if p["alive"]]
    names = {p["member_id"]: p["nickname"] for p in s["players"]}

    if g["phase"] == "ended":
        if any(e["kind"] == "game_ended" for e in turn.events) and turn.lines_shown == 0:
            await narrator.narrate(turn, narrator.STOCK["ended"])
        return False
    if g["paused"]:
        return False

    match g["phase"]:
        case "setup" if s["words"] is None:
            pair = await content.pick_pair(game, s, None, rng)
            turn.picked = (pair["word_a"], pair["word_b"])
            undercovers, whites = legal_mix(len(s["players"]), rng)
            await games.setup(game, pair["id"], undercovers, whites, 20, turn.key("setup"))
            await games.deal(game, turn.key("deal"))
            await narrator.narrate(turn, narrator.STOCK["setup"])
        case "setup":
            await games.open_phase(game, "clues", None, turn.key("open"), rng.sample(alive, len(alive)))
        case "clues" if g["turn_index"] is None:
            await games.open_phase(game, "discussion", 30, turn.key("open"))
        case "discussion":  # bots don't talk, so the scripted game master closes discussion at once
            await games.open_phase(game, "vote", rng.randint(20, 40), turn.key("open"))
        case "vote" if not g["resolved"] and g["phase_deadline"] is None:
            result = await games.resolve_vote(game, turn.key("resolve"))
            if result.get("tie"):
                await say(turn, "A tie! The detective narrows their eyes.", s)
            else:
                await say(turn, f"{names[result['eliminated']]} is out. They were {result['role'].replace('_', ' ')}.",
                          await games.state(game))
        case "vote" if g["resolved"]:
            last = s["results"][-1]
            tied = last.get("tied") or []
            if last["tie"] and not g["revoted"] and len(tied) >= 2 and rng.random() < 0.6:
                await games.open_phase(game, "vote", 30, turn.key("open"), candidates=tied)
            else:
                await games.open_phase(game, "clues", None, turn.key("open"))
        case "guess" if g["judgement"] is None and g["phase_deadline"] is None:
            verdict = same_word(s["guess"], s["words"]["civilian"])
            await games.judge(game, verdict, "Exactly the word." if verdict else "Not the word.", turn.key("judge"))
        case "guess" if g["resolved"]:
            await say(turn, "Wrong! The game goes on.", s)
            await games.open_phase(game, "clues", None, turn.key("open"))
        case _:
            return False  # the players', the host's or the timer's move
    return True
