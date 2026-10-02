"use client";

import type { HeadsupTurn } from "@gamenight/db-types";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

import { Avatar, PhaseTitle, TimerRing } from "@/components/game/parts";
import { Leaderboard, Podium } from "@/components/game/quiz-parts";
import { HostCaption } from "@/components/lobby";
import { useCountdown, useNow } from "@/lib/clock";
import type { LiveGame } from "@/lib/game";
import { asScores, cardToShow, currentTurn, headsupConfig, recapCards, turnHeading } from "@/lib/headsup";
import type { LiveRoom, TvCard } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";
import { useSupabase } from "@/lib/supabase/client";

/**
 * The TV during Heads Up: the only screen that ever shows the live card. It arrives on the TV's own topic (`pushed`);
 * a TV that has just loaded, or missed a push, asks for it (headsup_live_card answers paired TVs only).
 */
export default function TvHeadsUp({ live, pushed }: { live: LiveRoom & { game: LiveGame }; pushed: TvCard | null }) {
  const { game } = live.game;
  const now = useNow();
  const names = new Map(live.members.map((m) => [m.id, m.nickname]));
  const turn = currentTurn(live.game.turns);
  const guesser = turn ? (names.get(turn.member_id) ?? "?") : null;
  const { left, total } = useCountdown(game.phase_deadline, now);
  const supabase = useSupabase();
  const [fetched, setFetched] = useState<TvCard | null>(null);

  // Ask for the card whenever a new one should be up and the push hasn't brought it (a reload, a missed broadcast).
  const want = game.phase === "guessing" && turn ? `${turn.number}:${turn.shown}` : null;
  const pushedMatches = Boolean(cardToShow(game, turn, pushed));
  useEffect(() => {
    if (!want || pushedMatches) return;
    let cancelled = false;
    void supabase.rpc("headsup_live_card", { p_game_id: game.id }).then(({ data }) => {
      if (!cancelled && data) setFetched(data as TvCard);
    });
    return () => {
      cancelled = true;
    };
  }, [want, pushedMatches, game.id, supabase]);

  const card = cardToShow(game, turn, pushed) ?? cardToShow(game, turn, fetched);
  const scores = asScores(live.game);
  const config = headsupConfig(game);

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="headsup-tv" data-phase={game.phase} data-turn={turn?.number ?? 0}
            className="grid min-h-dvh grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-8 p-10">
        <section className="flex min-w-0 flex-col gap-6">
          <header className="flex items-center justify-between gap-6">
            <div>
              <p className="text-2xl text-muted">{turn && game.phase !== "ended" ? `Turn ${turn.number} of ${config.total_turns}` : "Heads Up"}</p>
              <h1 className="text-6xl font-semibold">
                {turnHeading(game.phase, guesser)}
              </h1>
            </div>
            {game.phase === "guessing" && left !== null && !game.paused_at ? <TimerRing seconds={left} total={total} size={120} /> : null}
          </header>

          <div className="flex flex-1 flex-col justify-center">
            {game.paused_at ? (
              <Big title="Paused by the host">The turn will pick up where it left off.</Big>
            ) : (
              <PhaseTitle id={`${game.phase}-${turn?.number ?? 0}`} className="flex w-full flex-col">
                {game.phase === "ended" ? (
                  <div data-testid="final-scores" className="flex flex-col gap-10">
                    <Podium scores={scores} names={names} big />
                  </div>
                ) : !turn || game.phase === "setup" ? (
                  <Big title="Heads Up!">The guesser turns away from the TV; everyone else shouts clues.</Big>
                ) : game.phase === "ready" ? (
                  <div data-testid="tv-ready" className="flex flex-col items-center gap-6 text-center">
                    <Avatar id={turn.member_id} name={guesser ?? "?"} size={180} />
                    <p className="text-7xl font-semibold">{guesser}, turn your back to the TV!</p>
                    <motion.p key={left} initial={{ scale: 1.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                              className="text-9xl font-semibold text-accent">{left ?? ""}</motion.p>
                  </div>
                ) : game.phase === "guessing" ? (
                  <Guessing turn={turn} card={card} guesser={guesser ?? "?"} />
                ) : (
                  <Recap turn={turn} guesser={guesser ?? "?"} />
                )}
              </PhaseTitle>
            )}
          </div>

          <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />
        </section>

        <aside className="flex flex-col gap-3">
          <h2 className="text-2xl text-muted">Got it, so far</h2>
          <Leaderboard scores={scores} names={names} big />
          {!live.connected ? <p role="status" className="mt-auto text-xl text-muted">Reconnecting…</p> : null}
        </aside>
      </main>
    </MotionConfig>
  );
}

function Guessing({ turn, card, guesser }: { turn: HeadsupTurn; card: string | null; guesser: string }) {
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <p className="text-3xl text-muted">Give {guesser} clues. No saying it, no spelling it!</p>
      {/* The live card, stated once on a steady element (the animated one below swaps with the next). */}
      <div data-testid="tv-live" data-card={card ?? ""} data-card-no={turn.shown}
           className="grid min-h-[38vh] w-full place-items-center rounded-3xl bg-surface-2 px-10">
        {/* "wait": the old card leaves, then the new one comes in. ("popLayout" injects a <style> element, which the
            strict style CSP blocks.) */}
        <AnimatePresence mode="wait">
          <motion.p key={`${turn.number}-${turn.shown}`} data-testid="tv-card"
                    initial={{ y: 60, opacity: 0, rotate: -3 }} animate={{ y: 0, opacity: 1, rotate: 0 }}
                    exit={{ y: -60, opacity: 0, transition: { duration: 0.12 } }}
                    transition={{ type: "spring", stiffness: 260, damping: 20 }}
                    className="text-8xl leading-tight font-semibold">
            {card ?? "…"}
          </motion.p>
        </AnimatePresence>
      </div>
      <p className="text-4xl"><span className="font-semibold text-[#2bb673]">{turn.got} got</span> · {turn.passed} passed</p>
    </div>
  );
}

function Recap({ turn, guesser }: { turn: HeadsupTurn; guesser: string }) {
  const cards = recapCards(turn);
  return (
    <div data-testid="tv-recap" className="flex flex-col gap-6">
      <motion.p initial={{ scale: 1.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-7xl font-semibold">
        {guesser} got {turn.got}!
      </motion.p>
      <ul className="grid grid-cols-2 gap-3 text-3xl">
        {cards.map((c, i) => (
          <motion.li key={i} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.12 }}
                     data-testid="tv-recap-card" data-result={c.result ?? "none"}
                     className={`flex items-center gap-3 ${c.result === "got" ? "" : "text-muted line-through"}`}>
            <span aria-hidden className={c.result === "got" ? "text-[#2bb673]" : "text-muted"}>{c.result === "got" ? "✓" : "✗"}</span>
            {c.card}
          </motion.li>
        ))}
      </ul>
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
