import type { Game, GamePlayer, GameResult, HeadsupTurn, QuizQuestion, QuizScore } from "@gamenight/db-types";

/**
 * The public game, as every screen in the room sees it (broadcast whole on room:{id}; never a word, and a quiz
 * question's answer only once it's revealed). questions and scores are a quiz's, turns are Heads Up's; empty for the
 * other games. A Heads Up card is never here: it goes only to the room's TVs.
 */
export type LiveGame = {
  game: Game;
  players: GamePlayer[];
  results: GameResult[];
  questions: QuizQuestion[];
  scores: QuizScore[];
  turns: HeadsupTurn[];
};

export type Role = "civilian" | "undercover" | "mr_white";

/** A player's own card, readable only by them (secrets table, member:{id} topic). */
export type Card = { role: Role; word?: string };

export type Judgement = { verdict: boolean; overruled: boolean; settled: boolean };

/** What the end of a game reveals: both words, every role, Mr. White's guesses and the reasoning. */
export type Reveal = {
  words: { civilian: string; undercover: string } | null;
  roles: Record<string, Role>;
  guesses: { member_id: string; guess: string | null; verdict: boolean | null; reasoning: string | null; overruled: boolean }[];
};

// One literal string, so the Supabase client can infer the row types from it.
export const GAME_SELECT =
  "id, room_id, kind, phase, step, round, settings, config, turn_order, turn_index, turn_deadline, phase_deadline, paused_at, paused_turn_left, paused_phase_left, vote_candidates, revoted, moves_in, resolved, guesser, judgement, winner, reveal, created_at, ended_at, game_players(game_id, member_id, room_id, seat, alive, eliminated_round, revealed_role), game_results(id, game_id, room_id, step, round, kind, votes, eliminated, revealed_role, tie, tied, verdict, overruled, created_at), quiz_questions(game_id, room_id, number, round, step, kind, topic, for_member, difficulty, prompt, options, unit, image_path, image_credit, seconds, opened_at, answer, source_url, results, revealed_at), quiz_scores(game_id, room_id, member_id, points, correct, jokers, joker_on), headsup_turns(game_id, room_id, number, round, member_id, step, started_at, ends_at, ended_at, shown, got, passed, cards)";

export const ROLE_LABEL: Record<Role, string> = { civilian: "a civilian", undercover: "undercover", mr_white: "Mr. White" };

export const PHASE_LABEL: Record<Game["phase"], string> = {
  setup: "Dealing",
  clues: "Clues",
  discussion: "Discussion",
  vote: "Vote",
  guess: "Mr. White's guess",
  ended: "Game over",
  question: "Question",
  reveal: "The answer",
  ready: "Get ready",
  guessing: "Guess!",
  recap: "Time!",
};

export const WINNER_LABEL: Record<string, string> = {
  civilians: "The civilians win",
  infiltrators: "The infiltrators win",
  mr_white: "Mr. White wins",
};

/** How to play, for the phase you're in: plain words, one tap away on every phone. */
export const HOW_TO_PLAY: Record<Game["phase"], string> = {
  setup: "Everyone gets a secret word. Most share one; a few get a close but different word; Mr. White gets none, and nobody is told which side they're on.",
  clues: "When the TV calls your name, say one word out loud that fits your word. Too obvious and the others will guess it; too vague and you'll look suspicious.",
  discussion: "Talk it over. Whose clue didn't quite fit? Mr. White is bluffing without a word.",
  vote: "Vote for the player you think has a different word. The most-voted player is out and their role is shown.",
  guess: "Mr. White was caught, and gets one guess at the civilians' word. Guess right and Mr. White wins alone.",
  ended: "The civilians win when every undercover and Mr. White is out; the infiltrators win when one civilian is left.",
  question: "Everyone answers the same question on their phone. A right answer scores 500 to 1,000 points: the faster, the more. Estimates score by how close you get.",
  reveal: "The answer, how the room did, and the leaderboard. Going into the final round, whoever is last gets a double-points joker.",
  ready: "The guesser turns their back to the TV. Everyone else: get ready to give clues, without saying the word.",
  guessing: "The word is on the TV. Shout clues (no saying it, no spelling it); the guesser taps Got it or Pass.",
  recap: "That turn's words and score. The next guesser is up soon.",
};

export function fromRow(row: Game & {
  game_players: GamePlayer[];
  game_results: GameResult[];
  quiz_questions: QuizQuestion[];
  quiz_scores: QuizScore[];
  headsup_turns: HeadsupTurn[];
}): LiveGame {
  const { game_players, game_results, quiz_questions, quiz_scores, headsup_turns, ...game } = row;
  return { game, players: game_players, results: game_results, questions: quiz_questions, scores: quiz_scores, turns: headsup_turns };
}

export function judgementOf(game: Game): Judgement | null {
  return (game.judgement as Judgement | null) ?? null;
}

export function revealOf(game: Game): Reveal | null {
  return (game.reveal as Reveal | null) ?? null;
}

export function speaker(game: Game): string | null {
  return game.phase === "clues" && game.turn_index !== null ? (game.turn_order[game.turn_index] ?? null) : null;
}

export function alive(players: GamePlayer[]): GamePlayer[] {
  return players.filter((p) => p.alive).sort((a, b) => a.seat - b.seat);
}

/** Who I may vote for: anyone still in but me, or only the tied players in a revote. */
export function voteCandidates(game: Game, players: GamePlayer[], me: string): GamePlayer[] {
  return alive(players).filter((p) => p.member_id !== me && (!game.vote_candidates || game.vote_candidates.includes(p.member_id)));
}

/** The latest result: the vote just counted (or the guess just settled). */
export function lastResult(results: GameResult[]): GameResult | null {
  return results.reduce<GameResult | null>((last, r) => (!last || r.step > last.step ? r : last), null);
}
