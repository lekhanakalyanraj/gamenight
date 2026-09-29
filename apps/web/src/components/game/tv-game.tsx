"use client";

import type { GameResult } from "@gamenight/db-types";
import { LayoutGroup, motion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

import { Avatar, Elimination, PhaseTitle, TimerRing } from "@/components/game/parts";
import { FinalReveal } from "@/components/game/reveal";
import { HostCaption } from "@/components/lobby";
import { useCountdown, useNow } from "@/lib/clock";
import { alive, judgementOf, lastResult, type LiveGame, PHASE_LABEL, type Role, speaker } from "@/lib/game";
import type { LiveRoom } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";

/** How long the TV holds a vote's result before showing the next phase. */
const RESULT_SECONDS = 10;

/**
 * The TV during a game. It reads only public rows (the game, its players, settled results and the AI
 * host's lines), so it can't show a word or a hidden role, even by mistake.
 */
export default function TvGame({ live }: { live: LiveRoom & { game: LiveGame } }) {
  const { game, players, results } = live.game;
  const now = useNow();
  const names = new Map(live.members.map((m) => [m.id, m.nickname]));
  const { left, total } = useCountdown(game.turn_deadline ?? game.phase_deadline, now);
  const recent = lastResult(results);
  const holding = recent && recent.kind === "vote" && now - Date.parse(recent.created_at) < RESULT_SECONDS * 1000;
  const inGame = alive(players);

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="tv-game" data-phase={game.phase} className="grid min-h-dvh grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-8 p-10">
        <section className="flex flex-col gap-6">
          <header className="flex items-center justify-between">
            <div>
              <p className="text-2xl text-muted">{game.phase === "ended" ? "Undercover" : `Round ${Math.max(game.round, 1)}`}</p>
              <PhaseTitle id={game.phase}><h1 className="text-6xl font-semibold">{PHASE_LABEL[game.phase]}</h1></PhaseTitle>
            </div>
            {left !== null && !game.paused_at ? <TimerRing seconds={left} total={total} size={120} /> : null}
          </header>

          <div className="flex flex-1 flex-col items-center justify-center">
            {game.paused_at ? (
              <Big title="Paused by the host">The game will pick up where it left off.</Big>
            ) : holding && recent ? (
              <VoteResult result={recent} names={names} />
            ) : (
              <PhaseTitle id={`${game.phase}-${game.step}-${game.resolved}`} className="flex w-full flex-col items-center">
                <Stage live={live.game} names={names} />
              </PhaseTitle>
            )}
          </div>

          <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />
        </section>

        <aside className="flex flex-col gap-3">
          <h2 className="text-2xl text-muted">{inGame.length} still in</h2>
          <LayoutGroup>
            <ul className="flex flex-col gap-2">
              {[...players].sort((a, b) => Number(b.alive) - Number(a.alive) || a.seat - b.seat).map((p) => (
                <motion.li layout key={p.member_id} data-testid="tv-player" data-alive={p.alive}
                           className={`flex items-center gap-3 rounded-2xl border border-border bg-surface p-3 ${p.alive ? "" : "opacity-50"}`}>
                  <Avatar id={p.member_id} name={names.get(p.member_id) ?? "?"} size={44} dim={!p.alive} />
                  <span className="flex flex-col">
                    <span className="text-xl font-medium">{names.get(p.member_id)}</span>
                    {!p.alive && p.revealed_role ? <span className="text-sm text-danger">out · {roleWord(p.revealed_role as Role)}</span> : null}
                  </span>
                </motion.li>
              ))}
            </ul>
          </LayoutGroup>
          {!live.connected ? <p role="status" className="mt-auto text-xl text-muted">Reconnecting…</p> : null}
        </aside>
      </main>
    </MotionConfig>
  );
}

function roleWord(role: Role) {
  return role === "mr_white" ? "Mr. White" : role;
}

function Stage({ live, names }: { live: LiveGame; names: Map<string, string> }) {
  const { game, players } = live;
  const name = (id: string | null) => (id ? (names.get(id) ?? "?") : "?");

  switch (game.phase) {
    case "setup":
      return <Big title="The detective is dealing…">Check your phone, and keep your card to yourself.</Big>;

    case "clues": {
      const current = speaker(game);
      if (!current) return <Big title="Every clue is in">The detective is thinking…</Big>;
      return (
        <div data-testid="spotlight" className="flex flex-col items-center gap-6">
          <LayoutGroup>
            <motion.div layoutId="spotlight" className="rounded-full p-2 ring-8 ring-accent/70" transition={{ type: "spring", stiffness: 200, damping: 24 }}>
              <motion.div key={current} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
                <Avatar id={current} name={name(current)} size={220} />
              </motion.div>
            </motion.div>
          </LayoutGroup>
          <p className="text-6xl font-semibold">{name(current)} is speaking</p>
          <ol className="flex flex-wrap justify-center gap-4 text-2xl">
            {game.turn_order.map((id, i) => (
              <li key={id} className={i < (game.turn_index ?? 0) ? "text-muted line-through" : i === game.turn_index ? "text-accent" : ""}>
                {name(id)}
              </li>
            ))}
          </ol>
        </div>
      );
    }

    case "discussion":
      return <Big title="Who's hiding something?">Talk it out. The vote opens soon.</Big>;

    case "vote": {
      if (game.resolved) return <Big title="The votes are in">The detective is thinking…</Big>;
      const voters = alive(players).length;
      return (
        <div data-testid="vote-progress" className="flex flex-col items-center gap-6">
          <p className="text-7xl font-semibold">{game.moves_in} of {voters} voted</p>
          <div className="flex gap-3">
            {Array.from({ length: voters }, (_, i) => (
              <motion.span key={i} animate={{ scale: i < game.moves_in ? 1 : 0.6, opacity: i < game.moves_in ? 1 : 0.3 }}
                           className="size-6 rounded-full bg-accent" />
            ))}
          </div>
          <p className="text-3xl text-muted">Vote on your phone. No names until the count.</p>
        </div>
      );
    }

    case "guess": {
      const judgement = judgementOf(game);
      if (judgement) {
        return (
          <div className="flex flex-col items-center gap-4">
            <motion.p initial={{ scale: 3, opacity: 0, rotate: -8 }} animate={{ scale: 1, opacity: 1, rotate: 0 }}
                      transition={{ type: "spring", stiffness: 240, damping: 12 }}
                      className={`text-9xl font-semibold ${judgement.verdict ? "text-accent" : "text-danger"}`}>
              {judgement.verdict ? "Right!" : "Wrong!"}
            </motion.p>
            {!judgement.settled ? <p className="text-3xl text-muted">The host can overrule</p> : null}
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center gap-6">
          <motion.div animate={{ rotate: [0, -4, 4, 0] }} transition={{ repeat: Infinity, duration: 2 }}>
            <Avatar id={game.guesser ?? "x"} name={name(game.guesser)} size={180} />
          </motion.div>
          <Big title={`${name(game.guesser)} was Mr. White`}>One guess at the civilians&apos; word…</Big>
        </div>
      );
    }

    case "ended":
      return <FinalReveal live={live} names={names} big />;
  }
}

/** Everyone's votes, drawn one by one, then who's out (or the tie). */
function VoteResult({ result, names }: { result: GameResult; names: Map<string, string> }) {
  const votes = Object.entries((result.votes ?? {}) as Record<string, string>);
  const name = (id: string) => names.get(id) ?? "?";
  return (
    <div data-testid="vote-result" className="flex w-full max-w-4xl flex-col gap-8">
      <ul className="grid grid-cols-2 gap-x-10 gap-y-3 text-3xl">
        {votes.map(([voter, target], i) => (
          <motion.li key={voter} initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.25 }}
                     className="flex items-center gap-4">
            <span className="w-40 truncate text-right text-muted">{name(voter)}</span>
            <motion.span initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: i * 0.25 + 0.1, duration: 0.3 }}
                         className="h-1 w-16 origin-left rounded bg-accent" aria-hidden />
            <span className="font-medium">{name(target)}</span>
          </motion.li>
        ))}
      </ul>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: votes.length * 0.25 + 0.4 }}>
        {result.tie ? (
          <Big title="A tie!">{(result.tied ?? []).map(name).join(" and ") || "Nobody"}: the detective will decide what happens.</Big>
        ) : result.eliminated && result.revealed_role ? (
          <Elimination id={result.eliminated} name={name(result.eliminated)} role={result.revealed_role as Role} big />
        ) : null}
      </motion.div>
    </div>
  );
}

function Big({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-testid="tv-status" className="flex flex-col items-center gap-4 text-center">
      <p className="text-7xl font-semibold">{title}</p>
      {children ? <p className="text-3xl text-muted">{children}</p> : null}
    </div>
  );
}

