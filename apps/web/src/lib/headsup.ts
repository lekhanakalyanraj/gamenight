import type { Game, HeadsupTurn, QuizScore } from "@gamenight/db-types";

import type { LiveGame } from "@/lib/game";
import type { TvCard } from "@/lib/realtime";

/**
 * Heads Up on screen. Phones never hold a live card: the turns they read carry counts only, and a turn's cards
 * (with Got it or Pass for each) arrive at its recap. The card on the TV comes on the TV's own topic, and only there.
 */

export type HeadsupConfig = { turns: number; seconds: number; ready_seconds: number; recap_seconds: number; total_turns: number };
export type RecapCard = { card: string; result: "got" | "pass" | null };

export const INTERESTS = [
  "Movies", "Bollywood", "Cricket", "Food", "Animals", "Music", "Sports", "Places", "Famous people", "Science",
  "TV & cartoons",
];

export function headsupConfig(game: Game): HeadsupConfig {
  const c = game.config as Partial<HeadsupConfig>;
  return { turns: c.turns ?? 1, seconds: c.seconds ?? 60, ready_seconds: c.ready_seconds ?? 5,
           recap_seconds: c.recap_seconds ?? 8, total_turns: c.total_turns ?? 0 };
}

/** The turn the room is on: the latest started. */
export function currentTurn(turns: HeadsupTurn[]): HeadsupTurn | null {
  return turns.reduce<HeadsupTurn | null>((last, t) => (!last || t.number > last.number ? t : last), null);
}

export function recapCards(turn: HeadsupTurn): RecapCard[] {
  return Array.isArray(turn.cards) ? (turn.cards as RecapCard[]) : [];
}

/** Everyone's total of Got it, most first; tied totals share a place. */
export function standings(memberIds: string[], turns: HeadsupTurn[]): { member_id: string; got: number; place: number }[] {
  const totals = memberIds.map((member_id) => ({
    member_id, got: turns.filter((t) => t.member_id === member_id).reduce((n, t) => n + t.got, 0),
  }));
  totals.sort((a, b) => b.got - a.got);
  let place = 0;
  return totals.map((s, i) => {
    if (i === 0 || s.got !== totals[i - 1].got) place = i + 1;
    return { ...s, place };
  });
}

/** The card the TV should show now: the one it was sent for this very turn and card, during guessing, unpaused. */
export function cardToShow(game: Game, turn: HeadsupTurn | null, card: TvCard | null): string | null {
  if (!turn || !card || game.phase !== "guessing" || game.paused_at) return null;
  if (card.game_id !== game.id || card.turn !== turn.number || card.card_no !== turn.shown) return null;
  return card.card;
}

/** Scores in the shape the shared leaderboard and podium draw (Got it counts as points). */
export function asScores(live: LiveGame): QuizScore[] {
  return standings(live.players.map((p) => p.member_id), live.turns).map((s) => ({
    game_id: live.game.id, room_id: live.game.room_id, member_id: s.member_id, points: s.got, correct: s.got,
    jokers: 0, joker_on: null,
  }));
}

/** The heading for a phase of a turn: who's up, who's guessing, whose turn just ended. */
export function turnHeading(phase: Game["phase"], guesser: string | null): string {
  if (phase === "ended") return "Final scores";
  if (!guesser) return "Heads Up";
  return phase === "ready" ? `${guesser} is up` : phase === "guessing" ? `${guesser} is guessing` : `${guesser}'s turn`;
}
