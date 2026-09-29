"""One simulated game: a host and bots at a table, a paired TV, the game master, and leak probes.

Every screen is a real signed-in user: bots move with submit_action, the host uses the host controls,
the TV only watches. The simulator also knows the truth (through the game master's view), which it
uses to steer bot votes and to know which words must never show up.
"""

import asyncio
import contextlib
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from gamenight_simulator.agents import Agents
from gamenight_simulator.leaks import broadcast_leaks, narration_leaks, private_topic_leaks, public_leaks, record
from gamenight_simulator.realtime import Realtime
from gamenight_simulator.referee import Referee
from gamenight_simulator.supabase import RpcError, Session, Supabase

# Bots can't hear spoken clues, so a policy stands in for how well the table reads them:
#   random: everyone votes at random
#   sharp:  civilians usually spot an infiltrator
#   sly:    the infiltrators pile onto one civilian
POLICIES = ("random", "sharp", "sly")
DECOYS = ["pizza", "tiger", "piano", "beach", "rocket", "coffee", "tea", "football", "Diwali", "idli"]
THEMES = [None, None, "food", "drinks", "animals", "sports", "travel"]
REGIONS = [None, None, "IN", "GB", "US"]
DELIVERY_TIMEOUT = 30.0
# Realtime allows a project 100 events a second (locally and on Supabase's free tier), and a move fans out
# into several. Bots at full speed blow through that and Realtime throttles the room, so they pace
# themselves: still far quicker than people, but under the limit.
PACE = 0.1
STALLS_PER_GAME = 2  # enough to run out one clue timer and one vote or guess timer


@dataclass
class Player:
    name: str
    session: Session
    realtime: Realtime | None  # a fresh connection for each game, as a page opens when it joins a room
    member_id: str = ""


@dataclass
class GameReport:
    number: int
    players: int
    policy: str
    staller: bool
    settings: dict[str, Any]
    mix: dict[str, Any] = field(default_factory=dict)
    winner: str | None = None
    rounds: int = 0
    seconds: float = 0.0
    completed: bool = False
    inconclusive: str | None = None  # Realtime lost messages, so the broadcast scan is incomplete: replayed
    leaks: list[str] = field(default_factory=list)
    illegal_refused: int = 0
    late_moves: int = 0
    narrations: int = 0
    gm: dict[str, Any] = field(default_factory=dict)  # the AI game master's totals (agents mode)
    gm_seconds: list[float] = field(default_factory=list)  # how long each wait for the game master took
    errors: list[str] = field(default_factory=list)


class Game:
    def __init__(self, sb: Supabase, referee: Referee, host: Player, table: list[Player], tv: Player,
                 rng: random.Random, report: GameReport, staller: Player | None, agents: Agents | None = None):
        self.sb, self.referee, self.host, self.table, self.tv = sb, referee, host, table, tv
        self.agents = agents  # None: the scripted referee plays the game master here; else the real pipeline does
        self.gm_since: float | None = None
        self.seen_since: dict[tuple, float] = {}
        self.rng, self.report, self.staller = rng, report, staller
        self.by_member: dict[str, Player] = {}
        self.game_id = ""
        self.truth: dict[str, Any] = {}
        self.done: set[tuple] = set()  # moves already decided: (kind, step, ...)
        self.stalls_left = STALLS_PER_GAME if staller else 0

    # ---- moves ------------------------------------------------------------------------------------------

    async def move(self, player: Player, kind: str, payload: dict[str, Any]) -> None:
        await asyncio.sleep(PACE)
        try:
            await self.sb.rpc(player.session, "submit_action", p_game_id=self.game_id, p_kind=kind,
                              p_payload=payload, p_action_id=str(uuid.uuid4()))
        except RpcError as error:
            if error.code == "55000":  # a timer beat the tap: late, not wrong
                self.report.late_moves += 1
            else:
                self.report.errors.append(f"{player.name}'s {kind} was refused: {error}")

    async def expect_refused(self, player: Player, kind: str, payload: dict[str, Any], code: str) -> None:
        await asyncio.sleep(PACE)
        try:
            await self.sb.rpc(player.session, "submit_action", p_game_id=self.game_id, p_kind=kind,
                              p_payload=payload, p_action_id=str(uuid.uuid4()))
        except RpcError as error:
            if error.code == code:
                self.report.illegal_refused += 1
            else:
                self.report.errors.append(f"illegal {kind} by {player.name} refused with {error.code}, expected {code}")
            return
        self.report.errors.append(f"the database accepted an illegal {kind} by {player.name}: {payload}")

    def stalls(self, player: Player) -> bool:
        """Whether this move is one the staller lets its timer run out on."""
        if player is not self.staller or self.stalls_left == 0 or self.rng.random() < 0.5:
            return False
        self.stalls_left -= 1
        return True

    @staticmethod
    def gm_turn(g: dict[str, Any]) -> bool:
        """Whether the game is waiting on the game master (not on the players, the host or a timer)."""
        phase = g["phase"]
        return g["paused_at"] is None and (
            phase == "setup"
            or (phase == "clues" and g["turn_index"] is None)
            or (phase == "discussion" and g["phase_deadline"] is None)
            or (phase == "vote" and (g["resolved"] or g["phase_deadline"] is None))
            or (phase == "guess" and ((g["judgement"] is None and g["phase_deadline"] is None) or g["resolved"])))

    def time_game_master(self, g: dict[str, Any]) -> None:
        now = time.monotonic()
        if self.gm_turn(g) and g["phase"] != "ended":
            self.gm_since = self.gm_since or now
        elif self.gm_since is not None:
            self.report.gm_seconds.append(round(now - self.gm_since, 2))
            self.gm_since = None

    def once(self, *key: Any) -> bool:
        if key in self.done:
            return False
        self.done.add(key)
        return True

    def target(self, voter: str, g: dict[str, Any], alive: list[str]) -> str:
        roles = {p["member_id"]: p["role"] for p in self.truth["players"]}
        candidates = [m for m in (g["vote_candidates"] or alive) if m != voter]
        civilians = [m for m in candidates if roles[m] == "civilian"]
        infiltrators = [m for m in candidates if roles[m] != "civilian"]
        policy = self.report.policy
        if policy == "sharp" and roles[voter] == "civilian" and infiltrators and self.rng.random() < 0.6:
            return self.rng.choice(infiltrators)
        if policy == "sly" and roles[voter] != "civilian" and civilians:
            return min(civilians)  # every infiltrator picks the same one
        return self.rng.choice(candidates)

    async def players_move(self, g: dict[str, Any], alive: list[str]) -> bool:
        """The bots' and the host's moves for the current state. Returns whether anyone moved."""
        rng, step, phase = self.rng, g["step"], g["phase"]
        if g["paused_at"] is not None:
            return False

        if phase == "discussion" and g["phase_deadline"] is not None and self.agents is not None:
            # Bots don't talk: after a moment the host skips discussion, and the game master opens the vote.
            since = self.seen_since.setdefault(("discussion", step), time.monotonic())
            if time.monotonic() - since > 3 and self.once("skip", step):
                await self.sb.rpc(self.host.session, "skip_phase", p_game_id=self.game_id)
                return True
            return False

        if phase == "clues" and g["turn_index"] is not None and self.once("turn", step, g["turn_index"]):
            speaker = self.by_member[g["turn_order"][g["turn_index"]]]
            if self.once("probe", "turn"):
                other = rng.choice([p for p in self.table if p is not speaker])
                await self.expect_refused(other, "done", {}, "55000")
            if self.stalls(speaker):
                return False  # lets the clue timer run out
            await self.move(speaker, "done", {})
            return True

        if phase == "vote" and not g["resolved"]:
            moved = False
            for member in alive:
                if not self.once("vote", step, member):
                    continue
                voter = self.by_member[member]
                if self.once("probe", "self-vote"):
                    await self.expect_refused(voter, "vote", {"target": member}, "22023")
                if self.once("probe", "pause"):
                    await self.pause_and_resume(voter, member, g, alive)
                if self.stalls(voter):
                    continue  # abstains: the vote timer decides
                await self.move(voter, "vote", {"target": self.target(member, g, alive)})
                moved = True
            out = [m for m in self.by_member if m not in alive]
            if out and self.once("probe", "dead-vote"):
                await self.expect_refused(self.by_member[out[0]], "vote", {"target": alive[0]}, "55000")
            return moved

        if phase == "guess" and g["judgement"] is None and self.once("guess", step):
            guesser = self.by_member[g["guesser"]]
            if self.once("probe", "guess"):
                other = self.by_member[rng.choice([m for m in alive if m != g["guesser"]])]
                await self.expect_refused(other, "guess", {"text": "pizza"}, "55000")
            if self.stalls(guesser):
                return False  # doesn't guess in time
            lucky = rng.random() < 0.3  # the simulator peeks, so the "right guess" path gets exercised
            guess = self.truth["words"]["civilian"] if lucky else rng.choice(DECOYS)
            await self.move(guesser, "guess", {"text": guess})
            return True

        if phase == "guess" and g["judgement"] and not g["judgement"].get("settled") and self.once("settle", step):
            choice = rng.random()
            if choice < 0.8:  # otherwise the 10-second window settles it
                await self.sb.rpc(self.host.session, "settle_judgement", p_game_id=self.game_id,
                                  p_overrule=choice < 0.25)
                return True
        return False

    async def pause_and_resume(self, voter: Player, member: str, g: dict[str, Any], alive: list[str]) -> None:
        """The host pauses mid-vote: moves are refused until they resume."""
        if self.rng.random() >= 0.3:
            return
        await self.sb.rpc(self.host.session, "pause_game", p_game_id=self.game_id)
        await self.expect_refused(voter, "vote", {"target": self.target(member, g, alive)}, "55000")
        await self.sb.rpc(self.host.session, "resume_game", p_game_id=self.game_id)

    # ---- the game -------------------------------------------------------------------------------------------

    async def setup_room(self) -> dict[str, Any]:
        sb, host = self.sb, self.host
        room = await sb.rpc(host.session, "create_room", p_nickname=host.name)
        for bot in self.table[1:]:
            await sb.rpc(bot.session, "join_room", p_code=room["code"], p_nickname=bot.name)
        members = {m["user_id"]: m["id"] for m in await sb.select(host.session, "room_members", room_id=room["id"])}
        for player in self.table:
            player.member_id = members[player.session.user_id]
            self.by_member[player.member_id] = player
        code = await sb.rpc(self.tv.session, "start_display_pairing")
        await sb.rpc(host.session, "pair_display", p_room_id=room["id"], p_code=code)

        joined = await asyncio.gather(
            self.tv.realtime.join(f"room:{room['id']}"),
            *(p.realtime.join(f"member:{p.member_id}") for p in self.table),
        )
        if not all(joined):
            self.report.errors.append("a screen couldn't join its own topic")
        return room

    def tv_summary(self, room_topic: str) -> str:
        games = [row for table, row in map(record, self.tv.realtime.broadcasts.get(room_topic, [])) if table == "games"]
        last = f", the last in phase {games[-1].get('phase')} at step {games[-1].get('step')}" if games else ""
        return f"the TV: the game's end (it got {len(games)} game updates{last})"

    async def undelivered(self, room_topic: str) -> list[str]:
        """Waits until the TV has the game's end and every phone its card. Realtime reads the database's change
        log in commit order, so by then everything sent earlier has arrived too, and the scans are complete."""
        def received(player: Player, topic: str, table: str, **match: Any) -> bool:
            return any(t == table and all(row.get(k) == v for k, v in match.items())
                       for t, row in map(record, player.realtime.broadcasts.get(topic, [])))

        started = time.monotonic()
        while time.monotonic() - started < DELIVERY_TIMEOUT:
            missing = [] if received(self.tv, room_topic, "games", phase="ended") else [self.tv_summary(room_topic)]
            missing += [f"{p.name}: their card" for p in self.table
                        if not received(p, f"member:{p.member_id}", "secrets")]
            if not missing:
                await asyncio.sleep(0.5)  # other screens' sockets may be a moment behind
                return []
            await asyncio.sleep(0.2)
        return missing

    async def probe_topics(self) -> list[str]:
        """Every player, and the TV, tries to listen on someone else's private topic. All must be refused."""
        attempts = [(p, self.rng.choice([q for q in self.table if q is not p])) for p in self.table]
        attempts.append((self.tv, self.host))
        results = await asyncio.gather(*(p.realtime.join(f"member:{q.member_id}") for p, q in attempts))
        return [f"{p.name} could listen on {q.name}'s private topic"
                for (p, q), joined in zip(attempts, results, strict=True) if joined]

    async def narration_scan(self, room_id: str, g: dict[str, Any], words: list[str]) -> list[str]:
        lines = [line for line in await self.sb.select(self.tv.session, "host_lines", room_id=room_id)
                 if line["kind"] == "narration"]
        self.report.narrations = len(lines)
        results = await self.sb.select(self.tv.session, "game_results", game_id=self.game_id)
        names = {p["member_id"]: p["nickname"] for p in self.truth["players"]}
        roles = {p["nickname"]: p["role"] for p in self.truth["players"]}
        revealed_at: dict[str, str] = {}  # when each role was first shown (Mr. White also has a later guess result)
        for r in sorted((r for r in results if r.get("eliminated")), key=lambda r: r["created_at"]):
            revealed_at.setdefault(names[r["eliminated"]], r["created_at"])
        return narration_leaks(lines, words, roles, revealed_at, g.get("ended_at"))

    async def read_cards(self) -> list[str]:
        leaks = []
        for player in self.table:
            rows = await self.sb.select(player.session, "secrets", game_id=self.game_id)
            if [r["member_id"] for r in rows] != [player.member_id]:
                leaks.append(f"{player.name} read {len(rows)} cards, not just their own")
        if await self.sb.select(self.tv.session, "secrets", game_id=self.game_id):
            leaks.append("the TV could read cards")
        return leaks

    async def play(self) -> None:
        report, sb = self.report, self.sb
        started = time.monotonic()
        # One trace per game: every call carries it, so each game-master run for this game joins the trace.
        sb.traceparent = f"00-{uuid.uuid4().hex}-{uuid.uuid4().hex[:16]}-01"
        room = await self.setup_room()
        game = await sb.rpc(self.host.session, "start_game", p_room_id=room["id"], p_kind="undercover",
                            p_settings=report.settings)
        self.game_id = game["id"]
        seen: list[tuple[str, dict[str, Any]]] = []  # public rows as the TV read them, in order
        probes: asyncio.Task | None = None
        g = game

        # Generous: a normal game takes seconds; each stall waits out a timer of up to 60 s.
        timeout = 60.0 + 5.0 * len(self.table) + 60.0 * self.stalls_left
        if self.agents is not None:  # each game-master turn is a few seconds of model calls
            timeout += 20.0 * len(self.table)
        while time.monotonic() - started < timeout:
            acted = await self.referee.act(self.game_id) if self.agents is None else False
            g = (await sb.select(self.tv.session, "games", id=self.game_id))[0]
            self.time_game_master(g)
            players = await sb.select(self.tv.session, "game_players", game_id=self.game_id)
            seen += [("games", g), *(("game_players", p) for p in players)]
            if g["phase"] == "ended":
                break
            if g["phase"] != "setup" and not self.truth:
                self.truth = await self.referee.state(self.game_id)
                report.leaks += await self.read_cards()
                probes = asyncio.create_task(self.probe_topics())
            if self.truth:
                alive = [p["member_id"] for p in players if p["alive"]]
                acted = await self.players_move(g, alive) or acted
            if not acted:
                await asyncio.sleep(0.2)
        else:
            report.errors.append(f"didn't finish within {timeout:.0f} s (phase {g['phase']})")

        room_topic = f"room:{room['id']}"
        if self.agents is not None and not await self.agents.wait_idle(self.game_id):
            report.errors.append("the game master was still busy 30 s after the game ended")
        # Local Realtime restarts its database stream every 10 minutes ("rebalancing"), and broadcasts sent
        # during the gap are lost. A game that spans one can't be fully scanned, so it's inconclusive.
        lost = await self.undelivered(room_topic)
        steps = {row.get("step") for table, row in map(record, self.tv.realtime.broadcasts.get(room_topic, []))
                 if table == "games"}
        if skipped := sorted(set(range(0, g.get("step", 0) + 1)) - steps):
            lost.append(f"the TV missed steps {skipped[:5]}")
        lost += [i for p in [self.tv, *self.table] for i in p.realtime.interruptions]
        if lost:
            report.inconclusive = f"Realtime lost messages: {', '.join(lost[:3])}" + (
                f" and {len(lost) - 3} more" if len(lost) > 3 else "")
        words = [self.truth["words"]["civilian"], self.truth["words"]["undercover"]] if self.truth else []
        report.leaks += broadcast_leaks(self.tv.realtime.broadcasts.get(room_topic, []), words)
        report.leaks += public_leaks(seen, words)
        for player in self.table:
            report.leaks += private_topic_leaks(player.realtime.broadcasts.get(f"member:{player.member_id}", []),
                                                player.member_id)
            moves = await sb.select(player.session, "game_actions", game_id=self.game_id)
            if any(m["member_id"] != player.member_id for m in moves):
                report.leaks.append(f"{player.name} could read someone else's moves")
        if self.truth:
            report.leaks += await self.narration_scan(room["id"], g, words)
        if self.agents is not None:
            report.gm = await self.agents.game_stats(self.game_id)
        if probes is not None:
            report.leaks += await probes
            for player in [*self.table, self.tv]:
                for topic, received in player.realtime.broadcasts.items():
                    if topic.startswith("member:") and topic != f"member:{player.member_id}" and received:
                        report.leaks.append(f"{player.name} received broadcasts on {topic}")

        report.winner, report.rounds = g.get("winner"), g.get("round", 0)
        report.mix = {k: g["config"].get(k) for k in ("civilians", "undercovers", "mr_whites")}
        report.seconds = round(time.monotonic() - started, 1)
        report.completed = g["phase"] == "ended" and not report.errors and not report.inconclusive

        # Tidy up: stop listening, and close the room (a host may keep only 3 rooms open).
        for player in [*self.table, self.tv]:
            for topic in list(player.realtime.broadcasts):
                await player.realtime.leave(topic)
            player.realtime.broadcasts.clear()
        await sb.rpc(self.host.session, "leave_room", p_room_id=room["id"])


async def play_game(sb: Supabase, referee: Referee, host: Player, bots: list[Player], tv: Player,
                    rng: random.Random, number: int, min_players: int, max_players: int,
                    stall_rate: float, agents: Agents | None = None) -> GameReport:
    table = [host, *rng.sample(bots, rng.randint(min_players, max_players) - 1)]
    staller = rng.choice(table[1:]) if rng.random() < stall_rate else None
    settings = {k: v for k, v in {"theme": rng.choice(THEMES), "region": rng.choice(REGIONS)}.items() if v}
    report = GameReport(number, len(table), rng.choice(POLICIES), staller is not None, settings)
    referee.turn_seconds = 10 if staller else 20
    # A hang anywhere (a socket, the database) fails this game, not the whole run.
    limit = 120.0 + 10.0 * len(table) + 60.0 * STALLS_PER_GAME * report.staller + DELIVERY_TIMEOUT
    limit += 20.0 * len(table) if agents else 0
    try:
        async with contextlib.AsyncExitStack() as stack:
            async def connect(player: Player) -> Player:
                screen = await stack.enter_async_context(Realtime(sb.url, sb.key, player.session.token))
                return Player(player.name, player.session, screen)

            screens = [await connect(p) for p in table]  # table[0] is the host
            stalling = screens[table.index(staller)] if staller else None
            game = Game(sb, referee, screens[0], screens, await connect(tv), rng, report, stalling, agents)
            await asyncio.wait_for(game.play(), limit)
    except TimeoutError:
        report.errors.append(f"the game hung: no result within {limit:.0f} s")
    except Exception as error:  # a crash is a failed game with its reason, not the end of the run
        where = f" ({error.request.method} {error.request.url.path})" if isinstance(error, httpx.HTTPError) and \
            getattr(error, "_request", None) else ""
        report.errors.append(f"{type(error).__name__}{where}: {error}")
    return report
