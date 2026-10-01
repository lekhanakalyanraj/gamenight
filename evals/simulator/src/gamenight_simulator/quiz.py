"""Quiz Night in the simulator: bots pick topics, answer on their "phones" (answer_question, play_joker), and the host
skips reveals now and then; the quiz master is the scripted referee here, or the real pipeline (--game-master
agents). Every game checks what the database promises:
- the answer is secret until its reveal: no broadcast carries it early, no player reads another's answer before
  the reveal, and no line the host said singled it out;
- the scoring: every question's points are recomputed here from the answers and the key (speed bonus, estimates
  ranked by closeness, the joker) and must match the database's;
- the game completes: every question asked and revealed, and the leaderboard adds up.
"""

import asyncio
import random
import re
import time
import uuid
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from gamenight_simulator.leaks import private_topic_leaks, record
from gamenight_simulator.referee import PACE, PROBE_RATE, Referee
from gamenight_simulator.supabase import RpcError

ASK = "select game_api.gm_ask(%(game)s::uuid, %(question)s::uuid, %(member)s::uuid, %(event_id)s::uuid)"
REVEAL = "select game_api.gm_reveal(%(game)s::uuid, %(event_id)s::uuid)"
TOPICS = ["Cricket", "Music", "Science", "Geography", "Food", "Anime", None, None]  # anime: no questions, so a fallback


class QuizReferee:
    """The scripted quiz master for the simulator, through the same game_api calls as the real one. It shares the
    Undercover referee's connection and checks: replays apply once, and illegal moves are refused."""

    def __init__(self, referee: Referee):
        self.r = referee

    async def state(self, game_id: str) -> dict[str, Any]:
        return await self.r._fetch("select game_api.get_quiz_state(%(game)s::uuid)", {"game": game_id})

    async def act(self, game_id: str) -> bool:
        s = await self.state(game_id)
        g = s["game"]
        if g["phase"] == "ended" or g["paused"]:
            return False
        if g["phase"] in ("setup", "reveal") and g["phase_deadline"] is None and s["asked"] < s["total"]:
            picked = await self.pick(game_id, s)
            if picked is None:
                return False
            await self.r._gm(ASK, game=game_id, question=picked[0], member=picked[1])
            return True
        if g["phase"] == "question" and g["phase_deadline"] is None and not g["resolved"]:
            await self.r._gm(REVEAL, game=game_id)
            return True
        if g["phase"] == "question" and self.r.rng.random() < PROBE_RATE:  # one question at a time
            question, _ = await self.pick(game_id, s) or (str(uuid.uuid4()), None)
            await self.r._probe(ASK, game=game_id, question=question, member=None)
        elif g["phase"] == "reveal" and self.r.rng.random() < PROBE_RATE:  # nothing to reveal
            await self.r._probe(REVEAL, game=game_id)
        return False

    async def pick(self, game_id: str, s: dict[str, Any]) -> tuple[str, str | None] | None:
        """This round's kind, from the topic of the player furthest behind who has questions for it."""
        config = s["game"]["config"]
        kind = config["round_kinds"][min(s["asked"] // config["per_round"], len(config["round_kinds"]) - 1)]
        bank = "select game_api.quiz_bank(%(game)s::uuid, %(topic)s, %(kind)s, null, 10)"
        for player in sorted(s["players"], key=lambda p: (p["points"], self.r.rng.random())):
            if player.get("topic"):
                found = await self.r._fetch(bank, {"game": game_id, "topic": player["topic"].lower(), "kind": kind})
                if found:
                    return self.r.rng.choice(found)["id"], player["member_id"]
        for any_kind in (kind, None):
            found = await self.r._fetch(bank, {"game": game_id, "topic": None, "kind": any_kind})
            if found:
                return self.r.rng.choice(found)["id"], None
        return None


# ---- the checks, computed independently of the database ---------------------------------------------------------

def _at(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp)


def _round(value: Decimal) -> int:
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))  # as Postgres rounds numerics


def expected_points(question: dict[str, Any], answers: list[dict[str, Any]]) -> dict[str, int]:
    """Each player's points for one revealed question, by the rules, from the answers and the key alone."""
    key = question["answer"]
    points: dict[str, int] = {}
    if question["kind"] == "estimate":
        target = Decimal(str(key["value"]))
        distance = {a["member_id"]: abs(Decimal(str(a["answer"]["value"])) - target) for a in answers}
        n = len(answers)
        for a in answers:
            place = 1 + sum(1 for d in distance.values() if d < distance[a["member_id"]])
            points[a["member_id"]] = _round(Decimal(1000) * (n - place + 1) / n) * (2 if a["joker"] else 1)
        return points
    for a in answers:
        if a["answer"] != key:
            points[a["member_id"]] = 0
            continue
        elapsed = Decimal(str((_at(a["answered_at"]) - _at(question["opened_at"])).total_seconds()))
        bonus = _round(500 * max(Decimal(0), 1 - elapsed / question["seconds"]))
        points[a["member_id"]] = (500 + bonus) * (2 if a["joker"] else 1)
    return points


def early_answer_lines(lines: list[dict[str, Any]], questions: list[dict[str, Any]]) -> list[str]:
    """Host lines shown while a question was open that single out its answer."""
    def says(text: str, word: str) -> bool:
        return re.search(r"\b" + re.escape(str(word).strip()) + r"\b", text, re.IGNORECASE) is not None

    leaks = []
    for q in questions:
        opened, revealed, key = q["opened_at"], q["revealed_at"], q["answer"] or {}
        for line in lines:
            if not (opened <= line["created_at"] < (revealed or "9999")):
                continue
            text = line["text"]
            if q["kind"] in ("choice", "picture") and "option" in key:
                right = q["options"][key["option"]]
                if says(text, right) and not all(says(text, o) for o in q["options"]):
                    leaks.append(f"question {q['number']}: the host singled out the answer early: {text!r}")
            elif q["kind"] == "estimate" and re.search(
                    r"(?<![\d.])" + re.escape(str(key.get("value"))) + r"(?!\d)", text):
                leaks.append(f"question {q['number']}: the host said the estimate's answer early: {text!r}")
    return leaks


def broadcast_answer_leaks(broadcasts: list[dict[str, Any]]) -> list[str]:
    """On the room's topic: a question's answer only with its reveal, and nobody's answers at all."""
    leaks = []
    for table, row in map(record, broadcasts):
        if table == "quiz_questions" and row.get("answer") is not None and row.get("revealed_at") is None:
            leaks.append(f"question {row.get('number')}'s answer was broadcast before its reveal")
        if table == "quiz_answers":
            leaks.append("a player's answer was broadcast to the whole room")
    return leaks


async def play_quiz(game: Any, room: dict[str, Any]) -> tuple[dict[str, Any], list[tuple[str, dict[str, Any]]]]:
    """Plays one quiz on an existing Game's table and TV; returns the last game row, and the public rows seen."""
    sb, report, rng = game.sb, game.report, game.rng
    referee = QuizReferee(game.referee)
    for player in game.table:
        if topic := rng.choice(TOPICS):
            await sb.rpc(player.session, "set_topic", p_room_id=room["id"], p_topic=topic)
    started = await sb.rpc(game.host.session, "start_game", p_room_id=room["id"], p_kind="quiz",
                           p_settings=report.settings)
    game.game_id = started["id"]
    skill = {p.member_id: rng.uniform(0.3, 0.95) for p in game.table}
    answered: set[tuple[int, str]] = set()
    probed: set[int] = set()
    seen: list[tuple[str, dict[str, Any]]] = []
    g = started

    # Per question: answers (a few a moment), sometimes a timer run out, sometimes the reveal's 8 s hold; the AI
    # quiz master adds its own turns in agents mode.
    config = started.get("config") or {}
    questions = config.get("rounds", 4) * config.get("per_round", 5)
    per_question = 2.0 + 0.3 * len(game.table) + 0.15 * config.get("seconds", 20) + 1.5
    timeout = 60.0 + questions * per_question + (questions * 12.0 if game.agents is not None else 0)
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        acted = await referee.act(game.game_id) if game.agents is None else False
        g = (await sb.select(game.tv.session, "games", id=game.game_id))[0]
        game.time_game_master(g)
        questions = await sb.select(game.tv.session, "quiz_questions", game_id=game.game_id)
        seen += [("games", g), *(("quiz_questions", q) for q in questions)]
        if g["phase"] == "ended":
            break
        current = max(questions, key=lambda q: q["number"]) if questions else None
        if g["phase"] == "question" and g["phase_deadline"] and current:
            if current["number"] not in probed:  # before its reveal, a player sees only their own answer to it
                probed.add(current["number"])
                prober = rng.choice(game.table)
                rows = await sb.select(prober.session, "quiz_answers", game_id=game.game_id,
                                       number=str(current["number"]))  # earlier questions are revealed: public
                if any(r["member_id"] != prober.member_id for r in rows):
                    report.leaks.append(f"{prober.name} read someone else's answer before the reveal")
            truth = (await referee.state(game.game_id))["question"]
            if truth and truth["number"] == current["number"]:
                acted = await answer_some(game, truth, skill, answered) or acted
        elif g["phase"] == "reveal" and g["phase_deadline"] and rng.random() < 0.85:
            await asyncio.sleep(PACE)
            try:  # the host skips the reveal's hold (sometimes they let the timer run)
                await sb.rpc(game.host.session, "skip_phase", p_game_id=game.game_id)
                acted = True
            except RpcError as error:
                if error.code != "55000":  # the timer beat the tap: late, not wrong
                    report.errors.append(f"the host couldn't skip a reveal: {error}")
        if not acted:
            await asyncio.sleep(0.2)
    else:
        report.errors.append(f"didn't finish within {timeout:.0f} s (phase {g['phase']})")
    return g, seen


async def answer_some(game: Any, truth: dict[str, Any], skill: dict[str, float], answered: set) -> bool:
    """A couple of players answer (so their times differ); now and then one sits it out and the timer closes it."""
    sb, rng, number = game.sb, game.rng, truth["number"]
    waiting = [p for p in game.table if (number, p.member_id) not in answered]
    rng.shuffle(waiting)  # who's quickest varies, rather than whoever sits first
    moved = False
    for player in waiting[: rng.randint(2, 3)]:
        answered.add((number, player.member_id))
        if rng.random() < 0.01:
            continue  # sits this one out: the question's timer closes it
        scores = await sb.select(player.session, "quiz_scores", game_id=game.game_id, member_id=player.member_id)
        await asyncio.sleep(PACE)
        try:
            if scores and scores[0]["jokers"] > 0:
                await sb.rpc(player.session, "play_joker", p_game_id=game.game_id)
            await sb.rpc(player.session, "answer_question", p_game_id=game.game_id,
                         p_answer=pick_answer(truth, rng.random() < skill[player.member_id], rng),
                         p_action_id=str(uuid.uuid4()))
            moved = True
        except RpcError as error:
            if error.code == "55000":
                game.report.late_moves += 1
            else:
                game.report.errors.append(f"{player.name}'s answer was refused: {error}")
    return moved


def pick_answer(truth: dict[str, Any], right: bool, rng: random.Random) -> dict[str, Any]:
    key = truth["key"]
    if truth["kind"] == "true_false":
        return {"value": key["value"] if right else not key["value"]}
    if truth["kind"] == "estimate":
        value = float(key["value"])
        return {"value": round(value * (rng.uniform(0.95, 1.05) if right else rng.uniform(0.5, 1.5)), 2)}
    options = range(len(truth["options"]))
    return {"option": key["option"] if right else rng.choice([o for o in options if o != key["option"]])}


async def check_quiz(game: Any, room: dict[str, Any], g: dict[str, Any]) -> None:
    """After the game: secrecy, scoring and completion, from what the players and the TV could read."""
    sb, report = game.sb, game.report
    room_topic = f"room:{room['id']}"
    report.leaks += broadcast_answer_leaks(game.tv.realtime.broadcasts.get(room_topic, []))
    for player in game.table:
        report.leaks += private_topic_leaks(player.realtime.broadcasts.get(f"member:{player.member_id}", []),
                                            player.member_id)
    questions = sorted(await sb.select(game.tv.session, "quiz_questions", game_id=game.game_id),
                       key=lambda q: q["number"])
    lines = [line for line in await sb.select(game.tv.session, "host_lines", room_id=room["id"])
             if line["kind"] == "narration"]
    report.narrations = len(lines)
    report.leaks += early_answer_lines(lines, questions)
    if g["phase"] != "ended":
        return

    answers = await sb.select(game.host.session, "quiz_answers", game_id=game.game_id)
    scores = await sb.select(game.tv.session, "quiz_scores", game_id=game.game_id)
    total = g["config"]["rounds"] * g["config"]["per_round"]
    if len(questions) != total or any(q["answer"] is None for q in questions):
        report.errors.append(f"{len(questions)} of {total} questions asked, not all revealed")
    for q in questions:
        mine = [a for a in answers if a["number"] == q["number"]]
        expected = expected_points(q, mine)
        actual = {a["member_id"]: a["points"] for a in mine}
        if expected != actual:
            report.errors.append(f"question {q['number']} ({q['kind']}) scored {actual}, the rules say {expected}")
    for s in scores:
        if s["points"] != sum(a["points"] or 0 for a in answers if a["member_id"] == s["member_id"]):
            report.errors.append(f"a leaderboard total doesn't add up for {s['member_id']}")
    top = max(scores, key=lambda s: s["points"]) if scores else None
    names = {p.member_id: p.name for p in game.table}
    report.winner = names.get(top["member_id"]) if top else None
    report.mix = {"questions": total, "jokers": sum(1 for a in answers if a["joker"])}
