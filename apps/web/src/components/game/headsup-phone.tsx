"use client";

import type { HeadsupTurn } from "@gamenight/db-types";
import { motion, MotionConfig } from "motion/react";
import { useState, useTransition } from "react";

import { HostDrawer } from "@/components/game/host-drawer";
import { Banner, HowTo, PhaseTitle, PhoneHeading, Status, Timer } from "@/components/game/parts";
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
            className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 py-6 pb-28">
        <PhoneHeading
          label={turn && game.phase !== "ended" ? `Heads Up · turn ${turn.number} of ${headsupConfig(game).total_turns}` : "Heads Up"}
          title={turnHeading(game.phase, guesser)}
          timer={(game.phase === "guessing" || game.phase === "ready") && left !== null && !game.paused_at
            ? <Timer seconds={left} total={total} /> : null}
        />

        <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} />

        {game.paused_at ? <Banner>Paused by the host</Banner> : null}

        <PhaseTitle id={`${game.phase}-${turn?.number ?? 0}`} className="flex flex-col gap-4">
          {game.phase === "ended" ? (
            <div data-testid="final-scores" className="flex flex-col gap-6">
              <Podium scores={scores} names={names} />
              <Leaderboard scores={scores} names={names} meId={meId} />
              <Button onClick={onBackToLobby}>{isHost ? "Play again" : "Back to the lobby"}</Button>
            </div>
          ) : !turn || game.phase === "setup" ? (
            <Status title="Heads Up is starting">The first guesser is up in a moment.</Status>
          ) : game.phase === "ready" ? (
            iGuess ? (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}
                          data-testid="your-turn" className="flex flex-col gap-6 bg-accent px-5 py-8 text-accent-ink">
                <p className="caps text-xs">Your turn</p>
                <div>
                  <p className="text-5xl tracking-tight">You&apos;re guessing!</p>
                  <p className="mt-2 text-lg">Turn your back to the TV, now.</p>
                </div>
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
          <p className="caps text-xs text-muted">You&apos;re the host: tap for {guesser} if they can&apos;t</p>
        ) : null}

        <Notice>{error}</Notice>

        {game.phase !== "ended" ? (
          <>
            {game.phase === "recap" ? <Leaderboard scores={scores} names={names} meId={meId} limit={5} /> : null}
            <HowTo><p>{HOW_TO_PLAY[game.phase]}</p></HowTo>
          </>
        ) : null}

        {!live.connected ? <p role="status" className="caps text-xs text-muted">Reconnecting…</p> : null}
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
      {guesser ? <p className="caps text-xs text-muted">For {guesser}</p> : null}
      <div className="flex items-end justify-between gap-4 border-b border-ink pb-3">
        <p data-testid="card-number" className="flex flex-col">
          <span className="caps text-xs text-muted">Card</span>
          <span className="numeral text-8xl leading-none">{String(shown).padStart(2, "0")}</span>
        </p>
        <dl className="flex gap-5 text-right">
          <div className="flex flex-col">
            <dt className="caps text-xs text-muted">Got</dt>
            <dd data-testid="got-count" className="numeral text-5xl leading-none">{turn.got}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="caps text-xs text-muted">Passed</dt>
            <dd data-testid="passed-count" className="numeral text-5xl leading-none text-muted">{turn.passed}</dd>
          </div>
        </dl>
      </div>
      <button type="button" disabled={pending} onClick={() => onTap("got")}
              className="flex h-44 items-end justify-between bg-ink p-5 text-5xl tracking-tight text-background transition active:opacity-80 disabled:opacity-40">
        Got it <span aria-hidden className="caps text-sm opacity-60">✓</span>
      </button>
      <button type="button" disabled={pending} onClick={() => onTap("pass")}
              className="flex h-28 items-end justify-between border border-ink p-5 text-4xl tracking-tight transition active:bg-surface-2 disabled:opacity-40">
        Pass <span aria-hidden className="caps text-sm text-muted">→</span>
      </button>
    </div>
  );
}

function Recap({ turn, guesser }: { turn: HeadsupTurn; guesser: string }) {
  const cards = recapCards(turn);
  return (
    <div data-testid="recap" className="flex flex-col gap-3">
      <p className="text-4xl tracking-tight">{guesser} got {turn.got}!</p>
      <ul className="flex flex-col border-t border-ink">
        {cards.map((c, i) => (
          <li key={i} data-testid="recap-card" data-result={c.result ?? "none"}
              className={`flex items-center justify-between border-b border-border py-2 ${c.result === "got" ? "" : "text-muted"}`}>
            <span>{c.card}</span>
            <span className={`caps text-xs ${c.result === "got" ? "text-ok" : ""}`}>{c.result === "got" ? "Got it" : c.result === "pass" ? "Passed" : "Time"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
