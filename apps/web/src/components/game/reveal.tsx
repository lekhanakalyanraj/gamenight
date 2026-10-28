"use client";

import type { GamePlayer } from "@gamenight/db-types";
import { motion } from "motion/react";

import { Avatar } from "@/components/game/parts";
import { type LiveGame, revealOf, ROLE_LABEL, type Role, WINNER_LABEL } from "@/lib/game";

/**
 * The end of the game: the winner drops in, both words appear, then every role is read out row by row.
 * Everything here comes from the game's reveal, which the database fills in only once the game has ended.
 */
export function FinalReveal({ live, names, big = false }: { live: LiveGame; names: Map<string, string>; big?: boolean }) {
  const reveal = revealOf(live.game);
  const players = [...live.players].sort((a: GamePlayer, b: GamePlayer) => a.seat - b.seat);
  const winner = live.game.winner ? WINNER_LABEL[live.game.winner] : "The host ended the game";

  return (
    <section data-testid="final-reveal" className={`flex flex-col ${big ? "gap-10" : "gap-6"}`}>
      <motion.h2
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
        className={`tracking-tight ${big ? "text-8xl leading-none" : "text-4xl"}`}
      >
        {winner}
      </motion.h2>

      {reveal?.words ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className={`grid grid-cols-2 border-y border-ink ${big ? "text-5xl" : "text-xl"}`}
        >
          <Word label="Civilians' word" word={reveal.words.civilian} big={big} />
          <Word label="Undercover word" word={reveal.words.undercover} big={big} />
        </motion.div>
      ) : null}

      <ul className={`grid w-full gap-x-8 ${big ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2 gap-x-4"}`}>
        {players.map((p, i) => {
          const role = (reveal?.roles[p.member_id] ?? p.revealed_role) as Role | null;
          return (
            <motion.li
              key={p.member_id}
              data-testid="reveal-player"
              data-role={role ?? ""}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 1.1 + i * 0.18, duration: 0.22 }}
              className={`flex items-center gap-3 border-b border-border ${big ? "py-4" : "py-2"}`}
            >
              <Avatar id={p.member_id} name={names.get(p.member_id) ?? "?"} size={big ? 56 : 32} live={role !== null && role !== "civilian"} />
              <span className="flex min-w-0 flex-col">
                <span className={`truncate ${big ? "text-2xl" : "text-sm"}`}>{names.get(p.member_id)}</span>
                <span className={`caps ${role === "civilian" ? "text-muted" : "text-foreground"} ${big ? "text-base" : "text-[11px]"}`}>
                  {role ? ROLE_LABEL[role] : ""}
                </span>
              </span>
            </motion.li>
          );
        })}
      </ul>

      {reveal?.guesses.length ? (
        <motion.ul
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.4 + players.length * 0.18 }}
          className={`flex flex-col gap-2 border-l-2 border-border pl-4 text-muted ${big ? "text-xl" : "text-sm"}`}
        >
          {reveal.guesses.map((g) => (
            <li key={`${g.member_id}-${g.guess}`}>
              {names.get(g.member_id)} guessed &ldquo;{g.guess ?? "nothing"}&rdquo;: {g.verdict ? "right" : "wrong"}
              {g.overruled ? " (the host overruled the detective)" : ""}. {g.reasoning}
            </li>
          ))}
        </motion.ul>
      ) : null}
    </section>
  );
}

function Word({ label, word, big }: { label: string; word: string; big: boolean }) {
  return (
    <div className={`flex flex-col gap-2 border-ink [&:first-child]:border-r ${big ? "py-6 pr-8 [&:last-child]:pl-8" : "py-3 pr-4 [&:last-child]:pl-4"}`}>
      <span className={`caps text-muted ${big ? "text-lg" : "text-[11px]"}`}>{label}</span>
      <span>{word}</span>
    </div>
  );
}
