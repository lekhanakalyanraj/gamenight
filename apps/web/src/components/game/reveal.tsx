"use client";

import type { GamePlayer } from "@gamenight/db-types";
import { motion } from "motion/react";

import { Avatar } from "@/components/game/parts";
import { type LiveGame, revealOf, ROLE_LABEL, type Role, WINNER_LABEL } from "@/lib/game";

/**
 * The end of the game: the winner stamps in, both words appear, then every role turns over one by one.
 * Everything here comes from the game's reveal, which the database fills in only once the game has ended.
 */
export function FinalReveal({ live, names, big = false }: { live: LiveGame; names: Map<string, string>; big?: boolean }) {
  const reveal = revealOf(live.game);
  const players = [...live.players].sort((a: GamePlayer, b: GamePlayer) => a.seat - b.seat);
  const winner = live.game.winner ? WINNER_LABEL[live.game.winner] : "The host ended the game";

  return (
    <section data-testid="final-reveal" className={`flex flex-col items-center gap-6 text-center ${big ? "gap-10" : ""}`}>
      <motion.h2
        initial={{ scale: 2.2, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 180, damping: 14 }}
        className={`font-semibold text-accent ${big ? "text-7xl" : "text-3xl"}`}
      >
        {winner}
      </motion.h2>

      {reveal?.words ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className={`grid grid-cols-2 gap-4 ${big ? "text-3xl" : "text-base"}`}
        >
          <Word label="Civilians' word" word={reveal.words.civilian} big={big} />
          <Word label="Undercover word" word={reveal.words.undercover} big={big} />
        </motion.div>
      ) : null}

      <ul className={`grid w-full gap-3 ${big ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"}`}>
        {players.map((p, i) => {
          const role = (reveal?.roles[p.member_id] ?? p.revealed_role) as Role | null;
          return (
            <motion.li
              key={p.member_id}
              data-testid="reveal-player"
              initial={{ rotateY: 90, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              transition={{ delay: 1.1 + i * 0.18, duration: 0.45 }}
              className={`flex items-center gap-3 rounded-2xl border bg-surface text-left ${
                role === "civilian" ? "border-border" : "border-accent/70"
              } ${big ? "p-4" : "p-2"}`}
            >
              <Avatar id={p.member_id} name={names.get(p.member_id) ?? "?"} size={big ? 56 : 32} />
              <span className="flex min-w-0 flex-col">
                <span className={`truncate font-medium ${big ? "text-2xl" : "text-sm"}`}>{names.get(p.member_id)}</span>
                <span className={`${role === "civilian" ? "text-muted" : "text-accent"} ${big ? "text-lg" : "text-xs"}`}>
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
          className={`flex flex-col gap-2 text-muted ${big ? "text-xl" : "text-sm"}`}
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
    <div className={`flex flex-col rounded-2xl border border-border bg-surface-2 ${big ? "px-8 py-5" : "px-4 py-3"}`}>
      <span className={`text-muted ${big ? "text-lg" : "text-xs"}`}>{label}</span>
      <span className="font-semibold">{word}</span>
    </div>
  );
}
