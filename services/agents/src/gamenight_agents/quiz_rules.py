"""The scripted quiz master: fixed rules that run a whole Quiz Night with no model (GAMENIGHT_MODEL=fake in CI and
local runs, and until the AI quiz master arrives). It plays through the same database moves and narrator as the AI
will. Now and then it tries a line that blurts out the live answer, to prove the database refuses it.

The rules, as approved: each round has its kind (config.round_kinds); questions lean toward the topics of the
players furthest behind, falling back to any topic; the database does the timing and all the scoring.
"""

from typing import Any

from gamenight_agents import games, narrator
from gamenight_agents.quiz_content import topic_key
from gamenight_agents.turn import Turn

MOVES_PER_TURN = 3
KIND_NAMES = {"choice": "multiple choice", "true_false": "true or false", "picture": "picture round",
              "estimate": "closest guess wins"}


async def play(turn: Turn) -> None:
    for _ in range(MOVES_PER_TURN):
        if not await step(turn, await games.quiz_state(turn.game_id)):
            return


async def step(turn: Turn, s: dict[str, Any]) -> bool:
    """One move, if the quiz master has one. Returns whether it moved."""
    g = s["game"]
    names = {p["member_id"]: p["nickname"] for p in s["players"]}
    if g["phase"] == "ended":
        if any(e["kind"] == "game_ended" for e in turn.events) and turn.lines_shown == 0 and s["players"]:
            top = s["players"][0]  # sorted by points
            await narrator.narrate(turn, f"That's the quiz! {top['nickname']} wins with {top['points']} points!")
        return False
    if g["paused"]:
        return False

    if g["phase"] in ("setup", "reveal") and g["phase_deadline"] is None and s["asked"] < s["total"]:
        picked = await pick(turn, s)
        if picked is None:
            return False  # nothing left to ask: the host can end the game
        question, for_member = picked
        asked = await games.ask(turn.game_id, question["id"], for_member, turn.key("ask"))
        await leak_probe(turn, question)
        await narrator.narrate(turn, intro(asked, g["config"]["per_round"], names.get(for_member), question))
        return True
    if g["phase"] == "question" and g["phase_deadline"] is None and not g["resolved"]:
        revealed = await games.reveal(turn.game_id, turn.key("reveal"))
        results = revealed["results"]
        if s["question"]["kind"] == "estimate":
            line = f"Closest guess wins! {len(results.get('closest', []))} nailed it."
        else:
            line = f"{results.get('right', 0)} of {results.get('answered', 0)} got it!"
        await narrator.narrate(turn, line)
        return True
    return False  # answers are coming in, or the reveal is on screen


async def pick(turn: Turn, s: dict[str, Any]) -> tuple[dict[str, Any], str | None] | None:
    """The next question: this round's kind, from the topic of the player furthest behind who has one."""
    config = s["game"]["config"]
    round_index = min(s["asked"] // config["per_round"], len(config["round_kinds"]) - 1)
    kind = config["round_kinds"][round_index]
    for player in sorted(s["players"], key=lambda p: (p["points"], turn.rng.random())):
        if topic := topic_key(player.get("topic")):
            found = await games.quiz_bank(turn.game_id, topic=topic, kind=kind, limit=5)
            if found:
                return turn.rng.choice(found), player["member_id"]
    for any_kind in (kind, None):  # no player's topic has one: any topic, then any kind
        found = await games.quiz_bank(turn.game_id, kind=any_kind, limit=10)
        if found:
            return turn.rng.choice(found), None
    return None


def intro(asked: dict[str, Any], per_round: int, name: str | None, question: dict[str, Any]) -> str:
    opening = ""
    if (asked["number"] - 1) % per_round == 0:  # the first question of a round
        opening = f"Round {asked['round']}: {KIND_NAMES.get(asked['kind'], asked['kind'])}! "
    if asked.get("final_round") and asked.get("jokers_to"):
        opening = "Final round, and the joker is in play! "
    credit = f" This one's for {name}: {question['topic']}!" if name else ""
    return f"{opening}Question {asked['number']} of {asked['of']}.{credit}"[:200]


async def leak_probe(turn: Turn, question: dict[str, Any]) -> None:
    """Now and then, try to blurt out the live answer: the database must refuse it (a shown one fails loudly)."""
    answer = question.get("answer") or {}
    if "option" in answer and question.get("options"):
        text = question["options"][answer["option"]]
    elif question["kind"] == "estimate":
        text = str(answer.get("value"))
    else:
        return
    if turn.rng.random() >= 0.3:
        return
    leaky = f"Psst... it's {text}!"
    result = await narrator.narrate(turn, leaky)
    if result.get("shown") and result.get("text") == leaky:
        raise AssertionError(f"a line naming only the live answer was shown: {result}")
