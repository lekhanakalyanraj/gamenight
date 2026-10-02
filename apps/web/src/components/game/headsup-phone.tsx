"use client";

import type { HeadsupTurn } from "@gamenight/db-types";
import { motion, MotionConfig } from "motion/react";
import { type ReactNode, useState, useTransition } from "react";

import { HostDrawer } from "@/components/game/host-drawer";
import { PhaseTitle, TimerRing } from "@/components/game/parts";
import { Leaderboard, Podium } from "@/components/game/quiz-parts";
import { HostCaption } from "@/components/lobby";
import { Button, Notice } from "@/components/ui";
import { headsupMove } from "@/app/play/[code]/game-actions";
import { useCountdown, useNow } from "@/lib/clock";
import { HOW_TO_PLAY, type LiveGame } from "@/lib/game";
import { asScores, currentTurn, headsupConfig, recapCards, turnHeading } from "@/lib/headsup";
import { newId } from "@/lib/ids";
import type { LiveRoom } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";

/**
 * A phone during Heads Up. The guesser gets Got it and Pass (the host may tap for them); everyone else gives clues
 * from the TV. No phone ever has the live card: turns carry counts, and the words arrive with each turn's recap.
 */
export default function PhoneHeadsUp({ live, meId, isHost, onBackToLobby }: {
  live: LiveRoom & { game: LiveGame };
  meId: string;
  isHost: boolean;
  onBackToLobby: () => void;
}) {
  const { game } = live.game;
  const now = useNow();
  const names = new Map(live.members.map((m) => [m.id, m.nickname]));
  const turn = currentTurn(live.game.turns);
  const guesser = turn ? (names.get(turn.member_id) ?? "?") : null;
  const iGuess = turn?.member_id === meId;
  const { left, total } = useCountdown(game.phase_deadline, now);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  // The latest count this phone knows: its own tap's reply can beat the broadcast, so a quick second tap answers the
  // right card.
  const [seen, setSeen] = useState<{ turn: number; shown: number } | null>(null);
  const shown = turn ? Math.max(turn.shown, seen?.turn === turn.number ? seen.shown : 0) : 0;
  const scores = asScores(live.game);

  function tap(result: "got" | "pass") {
    if (!turn) return;
    setError(undefined);
    const id = newId(); // made here, so a retried tap counts once
    const cardNo = shown;
    startTransition(async () => {
      const reply = await headsupMove(game.id, result, cardNo, id);
      if (reply.error) setError(reply.error);
      else if (reply.turn) setSeen({ turn: reply.turn.number, shown: reply.turn.shown });
    });
  }

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="headsup-phone" data-phase={game.phase} data-turn={turn?.number ?? 0} data-guesser={iGuess}
            className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-5 py-6 pb-28">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted">
              {turn && game.phase !== "ended" ? `Turn ${turn.number} of ${headsupConfig(game).total_turns}` : "Heads Up"}
            </p>
            <h1 className="text-2xl font-semibold">{turnHeading(game.phase, guesser)}</h1>
          </div>
          {(game.phase === "guessing" || game.phase === "ready") && left !== null && !game.paused_at
            ? <TimerRing seconds={left} total={total} /> : null}
        </header>

        <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} />

        {game.paused_at ? <Banner>Paused by the host</Banner> : null}

        <PhaseTitle id={`${game.phase}-${turn?.number ?? 0}`} className="flex flex-col gap-4">
          {game.phase === "ended" ? (
            <div data-testid="final-scores" className="flex flex-col gap-5">
              <Podium scores={scores} names={names} />
              <Leaderboard scores={scores} names={names} meId={meId} />
              <Button onClick={onBackToLobby}>{isHost ? "Play again" : "Back to the lobby"}</Button>
            </div>
          ) : !turn || game.phase === "setup" ? (
            <Status title="Heads Up is starting">The first guesser is up in a moment.</Status>
          ) : game.phase === "ready" ? (
            iGuess ? (
              <motion.div initial={{ scale: 0.8 }} animate={{ scale: [0.8, 1.06, 1] }} data-testid="your-turn"
                          className="rounded-3xl bg-accent px-5 py-8 text-center text-accent-ink">
                <p className="text-3xl font-semibold">You&apos;re guessing!</p>
                <p className="mt-2 text-lg">Turn your back to the TV, now.</p>
              </motion.div>
            ) : (
              <Status title={`${guesser} is up`}>Get ready to give clues. No saying the word!</Status>
            )
          ) : game.phase === "guessing" ? (
            iGuess || isHost ? (
              <GuessPad turn={turn} shown={shown} guesser={iGuess ? null : guesser} pending={pending || Boolean(game.paused_at)}
                        onTap={tap} />
            ) : (
              <Status title="Look at the TV!">Give {guesser} clues. No saying it, no spelling it.</Status>
            )
          ) : (
            <Recap turn={turn} guesser={guesser ?? "?"} />
          )}
        </PhaseTitle>

        {game.phase === "guessing" && isHost && !iGuess ? (
          <p className="text-center text-sm text-muted">You&apos;re the host: tap for {guesser} if they can&apos;t.</p>
        ) : null}

        <Notice>{error}</Notice>

        {game.phase !== "ended" ? (
          <>
            {game.phase === "recap" ? <Leaderboard scores={scores} names={names} meId={meId} limit={5} /> : null}
            <details className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium">How to play</summary>
              <p className="mt-2 text-muted">{HOW_TO_PLAY[game.phase]}</p>
            </details>
          </>
        ) : null}

        {!live.connected ? <p role="status" className="text-center text-sm text-muted">Reconnecting…</p> : null}
      </main>
      {isHost && game.phase !== "ended" ? <HostDrawer game={game} roomId={live.room.id} voice={live.room.voice} /> : null}
    </MotionConfig>
  );
}

function GuessPad({ turn, shown, guesser, pending, onTap }: {
  turn: HeadsupTurn;
  shown: number;
  guesser: string | null;  // set when the host taps for someone else
  pending: boolean;
  onTap: (result: "got" | "pass") => void;
}) {
  return (
    <div data-testid="guess-pad" className="flex flex-col gap-4">
      <p className="text-center text-lg">
        {guesser ? `For ${guesser}: ` : ""}Card {shown} · <span className="font-semibold">{turn.got} got</span> · {turn.passed} passed
      </p>
      <button type="button" disabled={pending} onClick={() => onTap("got")}
              className="h-36 rounded-3xl bg-[#15803d] text-4xl font-semibold text-white transition active:scale-95 disabled:opacity-50">
        Got it
      </button>
      <button type="button" disabled={pending} onClick={() => onTap("pass")}
              className="h-24 rounded-3xl border border-border bg-surface-2 text-3xl font-semibold transition active:scale-95 disabled:opacity-50">
        Pass
      </button>
    </div>
  );
}

function Recap({ turn, guesser }: { turn: HeadsupTurn; guesser: string }) {
  const cards = recapCards(turn);
  return (
    <div data-testid="recap" className="flex flex-col gap-3">
      <p className="text-center text-3xl font-semibold">{guesser} got {turn.got}!</p>
      <ul className="flex flex-col gap-1.5">
        {cards.map((c, i) => (
          <li key={i} data-testid="recap-card" data-result={c.result ?? "none"}
              className={`flex items-center justify-between rounded-xl border px-3 py-2 ${c.result === "got" ? "border-[#2bb673]" : "border-border opacity-70"}`}>
            <span>{c.card}</span>
            <span className="text-sm">{c.result === "got" ? "Got it" : c.result === "pass" ? "Passed" : "Time"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Status({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-testid="status" className="flex flex-col gap-1 rounded-2xl border border-border bg-surface px-5 py-6 text-center">
      <p className="text-2xl font-semibold">{title}</p>
      {children ? <p className="text-muted">{children}</p> : null}
    </div>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-xl border border-accent/50 px-3 py-2 text-center text-accent">{children}</p>;
}
