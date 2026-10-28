"use client";

import type { HeadsupTurn } from "@gamenight/db-types";
import { motion, MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

import { Avatar, PhaseTitle, StageHeading, Timer, TvFrame } from "@/components/game/parts";
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
      <TvFrame
        data-testid="headsup-tv"
        data-phase={game.phase}
        data-turn={turn?.number ?? 0}
        label={turn && game.phase !== "ended" ? `Heads Up · turn ${turn.number} of ${config.total_turns}` : "Heads Up"}
        asideLabel="Got it, so far"
        caption={<HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />}
        aside={
          <>
            <Leaderboard scores={scores} names={names} big />
            {!live.connected ? <p role="status" className="caps mt-auto text-lg text-muted">Reconnecting…</p> : null}
          </>
        }
      >
        <StageHeading
          label={game.phase === "ended" ? "Game over" : "Now"}
          title={turnHeading(game.phase, guesser)}
          swap={`${game.phase}-${turn?.number ?? 0}`}
          timer={game.phase === "guessing" && left !== null && !game.paused_at ? <Timer seconds={left} total={total} size={120} /> : null}
        />

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
                <div data-testid="tv-ready" className="flex items-center gap-12">
                  <Avatar id={turn.member_id} name={guesser ?? "?"} size={200} live />
                  <div className="flex flex-col gap-6">
                    <p className="text-7xl leading-[1.05] tracking-tight">{guesser}, turn your back to the TV!</p>
                    <motion.p key={left} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
                              className="numeral text-[12rem] text-accent">{left ?? ""}</motion.p>
                  </div>
                </div>
              ) : game.phase === "guessing" ? (
                <Guessing turn={turn} card={card} guesser={guesser ?? "?"} />
              ) : (
                <Recap turn={turn} guesser={guesser ?? "?"} />
              )}
            </PhaseTitle>
          )}
        </div>
      </TvFrame>
    </MotionConfig>
  );
}

function Guessing({ turn, card, guesser }: { turn: HeadsupTurn; card: string | null; guesser: string }) {
  return (
    <div className="flex flex-col gap-8">
      <p className="text-3xl text-muted">Give {guesser} clues. No saying it, no spelling it!</p>
      {/* The live card, stated once on a steady element (the animated one below swaps with the next). */}
      <div data-testid="tv-live" data-card={card ?? ""} data-card-no={turn.shown}
           className="grid min-h-[40vh] w-full place-items-center border-y border-ink px-10">
        {/* Each card slides in and the last one goes at once: an exit animation could hold a stale card on screen
            when the guesser taps twice inside it. */}
        <motion.p key={`${turn.number}-${turn.shown}`} data-testid="tv-card"
                  initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                  className="text-center text-[9rem] leading-none tracking-tight">
          {card ?? "…"}
        </motion.p>
      </div>
      <p className="caps flex gap-10 text-3xl"><span className="text-ok">{turn.got} got</span><span className="text-muted">{turn.passed} passed</span></p>
    </div>
  );
}

function Recap({ turn, guesser }: { turn: HeadsupTurn; guesser: string }) {
  const cards = recapCards(turn);
  return (
    <div data-testid="tv-recap" className="flex flex-col gap-6">
      <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="text-7xl tracking-tight">
        {guesser} got {turn.got}!
      </motion.p>
      <ul className="grid grid-cols-2 gap-x-12 border-t border-border text-3xl">
        {cards.map((c, i) => (
          <motion.li key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.12, duration: 0.2 }}
                     data-testid="tv-recap-card" data-result={c.result ?? "none"}
                     className={`flex items-center gap-4 border-b border-border py-3 ${c.result === "got" ? "" : "text-muted line-through"}`}>
            <span aria-hidden className={`font-mono ${c.result === "got" ? "text-ok" : "text-muted"}`}>{c.result === "got" ? "✓" : "✗"}</span>
            {c.card}
          </motion.li>
        ))}
      </ul>
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
