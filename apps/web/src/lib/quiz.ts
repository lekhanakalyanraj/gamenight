import type { Game, QuizAnswer, QuizQuestion, QuizScore } from "@gamenight/db-types";

/**
 * Quiz Night on screen. Everything here reads public rows: a question's answer and results are null until its
 * reveal (the database keeps the key elsewhere until then), so a screen can't show an answer early by mistake.
 */

export type QuizKind =
  | "choice" | "true_false" | "estimate" | "picture" | "teaser" | "fake_real" | "lightning" | "order" | "connect";
export type RoundName = "teasers" | "fake_real" | "lightning" | "picture" | "mix" | "order" | "closest" | "connect";
/** One round of the plan the database made at the start: its name, how many questions, and its timing. */
export type RoundPlan = { round: RoundName; questions: number; seconds?: number; extra?: number; reveal: number };
export type QuizConfig = { rounds: number; seconds: number; plan: RoundPlan[] };
export type Key = { option?: number; value?: boolean | number; order?: number[] };
export type ChoiceResults = { answered: number; right: number; picks: number[] };
export type TrueFalseResults = { answered: number; right: number; picks: { true: number; false: number } };
export type EstimateResults = { answered: number; closest: { member_id: string; value: number }[] };
export type OrderResults = { answered: number; right: number };

/** The lengths the host picks from: always teasers first and connections last, the middle filling in. */
export const LENGTHS = [
  { rounds: 3, label: "Short", about: "Teasers, fake or real, connections" },
  { rounds: 5, label: "Standard", about: "Adds lightning and pictures" },
  { rounds: 8, label: "Full", about: "Every round" },
] as const;

export const ROUND_LABEL: Record<RoundName, string> = {
  teasers: "Brain teasers",
  fake_real: "Fake or real",
  lightning: "Lightning round",
  picture: "Picture round",
  mix: "The mix",
  order: "In order",
  closest: "Closest wins",
  connect: "Connections",
};

export const ROUND_HOW: Record<RoundName, string> = {
  teasers: "Riddles, wordplay and little puzzles. Work it out, then pick one.",
  fake_real: "A statement on the TV. Fake or real? Right and fast scores the most.",
  lightning: "Two options, six seconds. Don't think, tap.",
  picture: "Look at the picture and pick what it shows.",
  mix: "Pick one of four. Watch for the twist.",
  order: "Tap the four in order, first to last. Each one in the right place scores.",
  closest: "Type a number. Nobody needs it exactly: the closer you get, the more you score.",
  connect: "Clues drop one by one. What links them? Answer early, score more.",
};

/**
 * The answer tiles: a colour and a shape each, the same on the TV and every phone, so you can answer while
 * looking at the TV, and the shape tells them apart without the colour.
 */
/** Answer tiles are told apart by a letter, not a colour: the design keeps colour for state (right, wrong). */
export const TILES = [{ letter: "A" }, { letter: "B" }, { letter: "C" }, { letter: "D" }] as const;

export const TRUE_FALSE = [
  { value: true, label: "True", letter: "T" },
  { value: false, label: "False", letter: "F" },
] as const;

export const FAKE_REAL = [
  { value: false, label: "Fake", letter: "F" },
  { value: true, label: "Real", letter: "R" },
] as const;

/** How long each connections clue waits before the next one shows. */
export const CLUE_SECONDS = 5;

export function quizConfig(game: Game): QuizConfig {
  const c = game.config as Partial<QuizConfig>;
  return { rounds: c.rounds ?? 0, seconds: c.seconds ?? 20, plan: Array.isArray(c.plan) ? c.plan : [] };
}

export function totalQuestions(game: Game): number {
  return quizConfig(game).plan.reduce((sum, r) => sum + r.questions, 0);
}

/** Where question `number` falls in the plan: its round (from 1), the round's name, and whether it opens it. */
export function slotOf(game: Game, number: number): { round: number; name: RoundName | null; first: boolean } {
  let upto = 0;
  for (const [i, r] of quizConfig(game).plan.entries()) {
    if (number <= upto + r.questions) return { round: i + 1, name: r.round, first: number === upto + 1 };
    upto += r.questions;
  }
  return { round: 0, name: null, first: false };
}

/** The round label for a question on screen: "Round 2 · Fake or real". */
export function roundLabel(game: Game, number: number): string {
  const { round, name } = slotOf(game, number);
  return name ? `Round ${round} · ${ROUND_LABEL[name]}` : "Quiz Night";
}

/** The question the room is on: the latest asked. */
export function currentQuestion(questions: QuizQuestion[]): QuizQuestion | null {
  return questions.reduce<QuizQuestion | null>((last, q) => (!last || q.number > last.number ? q : last), null);
}

export function kindOf(q: QuizQuestion): QuizKind {
  return q.kind as QuizKind;
}

export function optionsOf(q: QuizQuestion): string[] {
  return Array.isArray(q.options) ? (q.options as string[]) : [];
}

/** The keyed answer: only ever set once the question is revealed. */
export function keyOf(q: QuizQuestion): Key | null {
  return q.revealed_at ? ((q.answer as Key | null) ?? null) : null;
}

export function cluesOf(q: QuizQuestion): string[] {
  return Array.isArray(q.clues) ? (q.clues as string[]) : [];
}

/** How many connections clues are showing: one more every CLUE_SECONDS from the question opening, all at the reveal. */
export function cluesShown(q: QuizQuestion, now: number): number {
  const clues = cluesOf(q).length;
  if (q.revealed_at) return clues;
  const opened = Date.parse(q.opened_at);
  const elapsed = Number.isFinite(opened) ? Math.max(0, now - opened) : 0;
  return Math.min(clues, 1 + Math.floor(elapsed / (CLUE_SECONDS * 1000)));
}

/** True for the kinds answered with two value buttons rather than options. */
export function isTwoWay(kind: QuizKind): boolean {
  return kind === "true_false" || kind === "fake_real";
}

/** The revealed answer in words: "Canberra", "Fake", "1969 (year)", "Oldest first: A, B, C, D". Null before. */
export function answerText(q: QuizQuestion): string | null {
  const key = keyOf(q);
  return key ? pickText(q, key) : null;
}

/** An answer in words. */
export function pickText(q: QuizQuestion, answer: Key): string {
  if (answer.order) return `${q.unit ? `${q.unit}: ` : ""}${answer.order.map((i) => optionsOf(q)[i] ?? "?").join(", ")}`;
  if (answer.option !== undefined) return optionsOf(q)[answer.option] ?? "?";
  if (typeof answer.value === "boolean") {
    return kindOf(q) === "fake_real" ? (answer.value ? "Real" : "Fake") : answer.value ? "True" : "False";
  }
  if (typeof answer.value === "number") return `${formatValue(answer.value, q.unit)}${q.unit ? ` ${q.unit}` : ""}`;
  return "?";
}

/** Points and counts, grouped: "4,821". */
export function formatNumber(n: number): string {
  return n.toLocaleString("en");
}

/**
 * An estimate's value: a year stays "1983" (never "1,983"); anything else is grouped. Year questions have no unit
 * (or "year"), so a whole number from 1000 to 2999 without another unit reads as a year.
 */
export function formatValue(n: number, unit: string | null): string {
  const yearish = !unit?.trim() || /^years?$/i.test(unit.trim());
  return yearish && Number.isInteger(n) && n >= 1000 && n <= 2999 ? String(n) : formatNumber(n);
}

/**
 * Where a revealed question came from, for the line under its answer: "Wikipedia, Canberra", a site's name
 * ("britannica.com"), or for a brain teaser "a puzzle by the AI host". Null when there's nothing to say.
 */
export function sourceLabel(q: QuizQuestion): string | null {
  const url = q.source_url;
  if (!url) return kindOf(q) === "teaser" && q.revealed_at ? "A puzzle by the AI host" : null;
  const wiki = url.match(/^https:\/\/en\.wikipedia\.org\/wiki\/([^?#]+)$/);
  if (wiki) return `Source · Wikipedia, ${decodeURIComponent(wiki[1]).replace(/_/g, " ")}`;
  try {
    return `Source · ${new URL(url).hostname.replace(/^www\./, "")}`;
  } catch {
    return null;
  }
}

/** Everyone in points order (ties keep seat order), each with their place; tied points share a place. */
export function standings(scores: QuizScore[]): (QuizScore & { place: number })[] {
  const sorted = [...scores].sort((a, b) => b.points - a.points);
  let place = 0;
  return sorted.map((s, i) => {
    if (i === 0 || s.points !== sorted[i - 1].points) place = i + 1;
    return { ...s, place };
  });
}

export function placeOf(scores: QuizScore[], memberId: string): number | null {
  return standings(scores).find((s) => s.member_id === memberId)?.place ?? null;
}

/** Whether the next question starts a new round (so the screens can introduce it). */
export function nextIsNewRound(game: Game, asked: number): boolean {
  return asked > 0 && asked < totalQuestions(game) && slotOf(game, asked + 1).first;
}

/** The round the next question belongs to, and its name. */
export function nextRound(game: Game, asked: number): { round: number; name: RoundName | null } {
  const { round, name } = slotOf(game, asked + 1);
  return { round, name };
}

/** Longest run of right answers per player, from the revealed answers (readable by everyone after each reveal). */
export function bestStreaks(answers: QuizAnswer[]): Map<string, number> {
  const byMember = new Map<string, QuizAnswer[]>();
  for (const a of answers) byMember.set(a.member_id, [...(byMember.get(a.member_id) ?? []), a]);
  const best = new Map<string, number>();
  for (const [member, list] of byMember) {
    let run = 0;
    let top = 0;
    for (const a of [...list].sort((x, y) => x.number - y.number)) {
      run = a.correct ? run + 1 : 0;
      top = Math.max(top, run);
    }
    best.set(member, top);
  }
  return best;
}

/** How long the last question's answer stays up before the final scores (the same hold as every other reveal). */
export const FINAL_REVEAL_SECONDS = 8;

/**
 * Whether the game has ended but its last question's reveal should still be showing: the database ends the game
 * the moment the last question is revealed, and the room should see that answer before the podium.
 */
export function showingFinalReveal(game: Game, q: QuizQuestion | null, now: number): boolean {
  return game.phase === "ended" && Boolean(q?.revealed_at)
    && now - Date.parse(q?.revealed_at ?? "") < FINAL_REVEAL_SECONDS * 1000;
}

/** Whether the open question is still taking answers (its clock is running). */
export function isOpen(game: Game, q: QuizQuestion | null): boolean {
  return game.phase === "question" && Boolean(q) && !q?.revealed_at && Boolean(game.phase_deadline) && !game.resolved;
}
