"""Heads Up in the simulator: bots pick interests, the guesser's "phone" taps Got it and Pass, the host cuts countdowns,
turns and recaps short; the host is the scripted referee here, or the real pipeline (--game-master agents). Every game
checks what the database promises:
- the card is a secret from the guesser, and in fact from every phone: the TV (asking as a paired TV) is the only
  screen that gets it; a phone asking is refused; no message on the room topic or a player's own topic, and no host
  line, names a card before its turn's recap; and only the guesser (or the host) can answer a card;
- the game completes: every player's turn, each turn's recap matching its taps, and the standings adding up.
"""

import asyncio
import re
import time
import uuid
from typing import Any

from gamenight_simulator.leaks import private_topic_leaks, record
from gamenight_simulator.referee import PACE, PROBE_RATE, Referee
from gamenight_simulator.supabase import RpcError

NEXT_TURN = "select game_api.gm_next_turn(%(game)s::uuid, %(event_id)s::uuid)"
INTERESTS = [["Cricket", "Food"], ["Movies"], ["Animals", "Sports", "Music"], ["anime"], None, None]


class HeadsUpReferee:
    """The scripted host for the simulator, through the same game_api calls as the real one."""

    def __init__(self, referee: Referee):
        self.r = referee

    async def state(self, game_id: str) -> dict[str, Any]:
        return await self.r._fetch("select game_api.get_headsup_state(%(game)s::uuid)", {"game": game_id})

    async def act(self, game_id: str) -> bool:
        s = await self.state(game_id)
        g = s["game"]
        if g["phase"] == "ended" or g["paused"]:
            return False
        if g["phase"] in ("setup", "recap") and g["phase_deadline"] is None:
            await self.r._gm(NEXT_TURN, game=game_id)
            return True
        if g["phase"] in ("ready", "guessing") and self.r.rng.random() < PROBE_RATE:  # one turn at a time
            await self.r._probe(NEXT_TURN, game=game_id)
        return False


def says(text: str, card: str) -> bool:
    return re.search(r"(?<![\w])" + re.escape(card.strip()) + r"(?![\w])", text, re.IGNORECASE) is not None


async def play_headsup(game: Any, room: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    """Plays one game of Heads Up on an existing Game's table and TV; returns the last game row, and which turn each
    card the TV showed belonged to."""
    sb, report, rng = game.sb, game.report, game.rng
    referee = HeadsUpReferee(game.referee)
    for player in game.table:
        if interests := rng.choice(INTERESTS):
            await sb.rpc(player.session, "set_interests", p_room_id=room["id"], p_interests=interests)
    started = await sb.rpc(game.host.session, "start_game", p_room_id=room["id"], p_kind="heads_up",
                           p_settings=report.settings)
    game.game_id = started["id"]
    by_member = {p.member_id: p for p in game.table}
    card_turn: dict[str, int] = {}
    probed: set[int] = set()
    taps_left: dict[int, int] = {}
    g = started

    turns_total = started["config"]["total_turns"]
    per_turn = 5.0 + 6 * (0.6 + PACE) + 8.0 + 2.0  # a countdown, a few taps, the recap, slack
    timeout = 60.0 + turns_total * per_turn + (turns_total * 15.0 if game.agents is not None else 0)
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        acted = await referee.act(game.game_id) if game.agents is None else False
        g = (await sb.select(game.tv.session, "games", id=game.game_id))[0]
        game.time_game_master(g)
        if g["phase"] == "ended":
            break
        turns = await sb.select(game.tv.session, "headsup_turns", game_id=game.game_id)
        turn = max(turns, key=lambda t: t["number"]) if turns else None
        if not turn or g["paused_at"]:
            await asyncio.sleep(0.2)
            continue
        guesser = by_member.get(turn["member_id"])

        if g["phase"] == "ready" and rng.random() < 0.7:  # the host cuts the countdown short, mostly
            acted = await skip(game, "a countdown") or acted
        elif g["phase"] == "guessing" and guesser:
            live = await sb.rpc(game.tv.session, "headsup_live_card", p_game_id=game.game_id)
            card = (live or {}).get("card")
            if card and live.get("turn") == turn["number"]:
                card_turn.setdefault(card, turn["number"])
            if turn["number"] not in probed:
                probed.add(turn["number"])
                await probe(game, turn, guesser)
            left = taps_left.setdefault(turn["number"], rng.randint(2, 6))
            if left > 0 and card:
                taps_left[turn["number"]] = left - 1
                await asyncio.sleep(rng.uniform(0.2, 0.6))  # a moment of clues
                tapper = game.host if rng.random() < 0.1 else guesser  # now and then the host taps for them
                try:
                    await sb.rpc(tapper.session, "headsup_move", p_game_id=game.game_id,
                                 p_result="got" if rng.random() < 0.7 else "pass", p_card_no=turn["shown"],
                                 p_action_id=str(uuid.uuid4()))
                    acted = True
                except RpcError as error:
                    if error.code == "55000":
                        report.late_moves += 1  # the card (or the turn) moved on first: late, not wrong
                    else:
                        report.errors.append(f"{tapper.name}'s tap was refused: {error}")
            elif left <= 0:
                acted = await skip(game, "a turn") or acted
        elif g["phase"] == "recap" and g["phase_deadline"] and rng.random() < 0.85:
            acted = await skip(game, "a recap") or acted
        if not acted:
            await asyncio.sleep(0.2)
    else:
        report.errors.append(f"didn't finish within {timeout:.0f} s (phase {g['phase']})")
    return g, card_turn


async def skip(game: Any, what: str) -> bool:
    await asyncio.sleep(PACE)
    try:
        await game.sb.rpc(game.host.session, "skip_phase", p_game_id=game.game_id)
        return True
    except RpcError as error:
        if error.code != "55000":  # the timer beat the tap: late, not wrong
            game.report.errors.append(f"the host couldn't skip {what}: {error}")
        return False


async def probe(game: Any, turn: dict[str, Any], guesser: Any) -> None:
    """Once a turn: the guesser and a clue-giver try for the card, and a clue-giver tries to answer it."""
    sb, report = game.sb, game.report
    others = [p for p in game.table if p.member_id != turn["member_id"] and p is not game.host]
    for who in [guesser, *others[:1]]:
        try:
            got = await sb.rpc(who.session, "headsup_live_card", p_game_id=game.game_id)
            report.leaks.append(f"{who.name}'s phone was given the live card: {got}")
        except RpcError as error:
            if error.code != "42501":
                report.errors.append(f"asking for the card failed oddly for {who.name}: {error}")
        rows = await sb.select(who.session, "headsup_turns", game_id=game.game_id, number=str(turn["number"]))
        if any(r.get("cards") for r in rows):
            report.leaks.append(f"{who.name} read turn {turn['number']}'s cards before its recap")
    if others:
        try:
            await sb.rpc(others[0].session, "headsup_move", p_game_id=game.game_id, p_result="got",
                         p_card_no=turn["shown"], p_action_id=str(uuid.uuid4()))
            report.errors.append(f"{others[0].name} answered a card that wasn't theirs to answer")
        except RpcError as error:
            if error.code not in ("42501", "55000"):
                report.errors.append(f"a clue-giver's tap failed oddly: {error}")


def recap_order_leaks(broadcasts: list[dict[str, Any]], card_turn: dict[str, int], where: str) -> list[str]:
    """In the order a screen received them: nothing names a card before the message with its turn's recap."""
    rows = list(map(record, broadcasts))
    recap_at: dict[int, int] = {}
    for i, (table, row) in enumerate(rows):
        if table == "headsup_turns" and row.get("cards") is not None:
            recap_at.setdefault(row.get("number"), i)
    leaks = []
    for card, turn in card_turn.items():
        for _table, row in rows[: recap_at.get(turn, len(rows))]:
            if says(str(row), card):
                leaks.append(f"{where} carried \"{card}\" before turn {turn}'s recap")
                break
    return leaks


async def check_headsup(game: Any, room: dict[str, Any], g: dict[str, Any], card_turn: dict[str, int]) -> None:
    """After the game: secrecy and completion, from what the players and the TV could read."""
    sb, report = game.sb, game.report
    room_topic = f"room:{room['id']}"
    report.leaks += recap_order_leaks(game.tv.realtime.broadcasts.get(room_topic, []), card_turn, "the room topic")
    for player in game.table:
        mine = player.realtime.broadcasts.get(f"member:{player.member_id}", [])
        report.leaks += private_topic_leaks(mine, player.member_id)
        report.leaks += recap_order_leaks(mine, card_turn, f"{player.name}'s own topic")
    turns = sorted(await sb.select(game.tv.session, "headsup_turns", game_id=game.game_id), key=lambda t: t["number"])
    lines = [line for line in await sb.select(game.tv.session, "host_lines", room_id=room["id"])
             if line["kind"] == "narration"]
    report.narrations = len(lines)
    for t in turns:
        for card in (c["card"] for c in t.get("cards") or []):
            for line in lines:
                if line["created_at"] < (t.get("ended_at") or "9999") and says(line["text"], card):
                    report.leaks.append(f"the host said \"{card}\" before turn {t['number']}'s recap: {line['text']!r}")
    if g["phase"] != "ended":
        return

    in_room = {p.member_id for p in game.table}
    if len(turns) != g["config"]["total_turns"]:
        report.errors.append(f"{len(turns)} of {g['config']['total_turns']} turns played")
    for t in turns:
        cards = t.get("cards") or []
        if len(cards) != t["shown"]:
            report.errors.append(f"turn {t['number']}: {t['shown']} cards shown, {len(cards)} in its recap")
        got = sum(1 for c in cards if c["result"] == "got")
        passed = sum(1 for c in cards if c["result"] == "pass")
        if (got, passed) != (t["got"], t["passed"]):
            report.errors.append(f"turn {t['number']}: counted {t['got']}/{t['passed']}, its cards say {got}/{passed}")
    standings = {s["member_id"]: s["got"] for s in (g.get("reveal") or {}).get("standings", [])}
    expected = {m: sum(t["got"] for t in turns if t["member_id"] == m) for m in in_room}
    if standings != expected:
        report.errors.append(f"the standings {standings} don't add up to the turns {expected}")
    names = {p.member_id: p.name for p in game.table}
    top = max(expected, key=lambda m: expected[m]) if expected else None
    report.winner = names.get(top) if top else None
    report.rounds = g["config"]["turns"]
    report.mix = {"turns": len(turns), "cards": sum(t["shown"] for t in turns), "got": sum(t["got"] for t in turns)}
