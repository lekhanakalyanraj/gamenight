"use client";

import type { GameResult } from "@gamenight/db-types";
import { LayoutGroup, motion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

import { Avatar, Elimination, PhaseTitle, StageHeading, Timer, TvFrame } from "@/components/game/parts";
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
      <TvFrame
        data-testid="tv-game"
        data-phase={game.phase}
        label={game.phase === "ended" ? "Undercover" : `Undercover · round ${Math.max(game.round, 1)}`}
        asideLabel={`${inGame.length} still in`}
        caption={<HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />}
        aside={
          <>
            <LayoutGroup>
              <ul className="flex flex-col border-t border-border">
                {[...players].sort((a, b) => Number(b.alive) - Number(a.alive) || a.seat - b.seat).map((p) => (
                  <motion.li layout key={p.member_id} data-testid="tv-player" data-alive={p.alive}
                             className={`flex items-center gap-4 border-b border-border py-3 ${p.alive ? "" : "opacity-40"}`}>
                    <Avatar id={p.member_id} name={names.get(p.member_id) ?? "?"} size={44} live={p.alive && speaker(game) === p.member_id} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-2xl">{names.get(p.member_id)}</span>
                      {!p.alive && p.revealed_role ? <span className="caps text-sm text-danger">out · {roleWord(p.revealed_role as Role)}</span> : null}
                    </span>
                  </motion.li>
                ))}
              </ul>
            </LayoutGroup>
            {!live.connected ? <p role="status" className="caps mt-auto text-lg text-muted">Reconnecting…</p> : null}
          </>
        }
      >
        <StageHeading
          label={game.phase === "ended" ? "Result" : "Phase"}
          title={PHASE_LABEL[game.phase]}
          swap={game.phase}
          timer={left !== null && !game.paused_at ? <Timer seconds={left} total={total} size={120} /> : null}
        />

        <div className="flex flex-1 flex-col justify-center">
          {game.paused_at ? (
            <Big title="Paused by the host">The game will pick up where it left off.</Big>
          ) : holding && recent ? (
            <VoteResult result={recent} names={names} />
          ) : (
            <PhaseTitle id={`${game.phase}-${game.step}-${game.resolved}`} className="flex w-full flex-col">
              <Stage live={live.game} names={names} />
            </PhaseTitle>
          )}
        </div>
      </TvFrame>
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
        <div data-testid="spotlight" className="flex flex-col gap-10">
          <div className="flex items-center gap-10">
            <motion.div key={current} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}>
              <Avatar id={current} name={name(current)} size={200} live />
            </motion.div>
            <div className="flex flex-col gap-3">
              <p className="caps text-xl text-accent">Speaking now</p>
              <p className="text-8xl leading-none tracking-tight">{name(current)}</p>
            </div>
          </div>
          <ol className="flex flex-wrap border-t border-border text-2xl">
            {game.turn_order.map((id, i) => (
              <li key={id} className={`flex items-baseline gap-3 border-b border-border py-3 pr-10 ${i < (game.turn_index ?? 0) ? "text-muted line-through" : i === game.turn_index ? "text-accent" : ""}`}>
                <span className="font-mono text-base">{String(i + 1).padStart(2, "0")}</span>{name(id)}
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
        <div data-testid="vote-progress" className="flex flex-col gap-8">
          <p className="text-7xl tracking-tight"><span className="numeral text-[10rem]">{game.moves_in}</span> of {voters} voted</p>
          <div className="flex gap-3">
            {Array.from({ length: voters }, (_, i) => (
              <span key={i} className={`size-8 border border-ink transition-colors ${i < game.moves_in ? "bg-ink" : ""}`} />
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
          <div className="flex flex-col gap-4">
            <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
                      className={`text-[12rem] leading-none tracking-tight ${judgement.verdict ? "text-ok" : "text-danger"}`}>
              {judgement.verdict ? "Right!" : "Wrong!"}
            </motion.p>
            {!judgement.settled ? <p className="caps text-2xl text-muted">The host can overrule</p> : null}
          </div>
        );
      }
      return (
        <div className="flex items-center gap-10">
          <Avatar id={game.guesser ?? "x"} name={name(game.guesser)} size={180} live />
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
      <ul className="grid grid-cols-2 gap-x-12 border-t border-border text-3xl">
        {votes.map(([voter, target], i) => (
          <motion.li key={voter} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.25, duration: 0.2 }}
                     className="flex items-center gap-4 border-b border-border py-3">
            <span className="w-44 truncate text-muted">{name(voter)}</span>
            <motion.span initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: i * 0.25 + 0.1, duration: 0.25 }}
                         className="h-px w-16 origin-left bg-ink" aria-hidden />
            <span>{name(target)}</span>
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
    <div data-testid="tv-status" className="flex flex-col gap-5">
      <p className="text-7xl leading-[1.05] tracking-tight">{title}</p>
      {children ? <p className="max-w-4xl text-3xl text-muted">{children}</p> : null}
    </div>
  );
}

