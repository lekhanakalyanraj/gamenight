import type { Game, QuizAnswer, QuizQuestion, QuizScore } from "@gamenight/db-types";

/**
 * Quiz Night on screen. Everything here reads public rows: a question's answer and results are null until its
 * reveal (the database keeps the key elsewhere until then), so a screen can't show an answer early by mistake.
 */

export type QuizKind = "choice" | "true_false" | "estimate" | "picture";
export type QuizConfig = { rounds: number; per_round: number; seconds: number; round_kinds: QuizKind[] };
export type Key = { option?: number; value?: boolean | number };
export type ChoiceResults = { answered: number; right: number; picks: number[] };
export type TrueFalseResults = { answered: number; right: number; picks: { true: number; false: number } };
export type EstimateResults = { answered: number; closest: { member_id: string; value: number }[] };

export const KIND_LABEL: Record<QuizKind, string> = {
  choice: "Multiple choice",
  true_false: "True or false",
  picture: "Picture round",
  estimate: "Closest estimate",
};

export const KIND_HOW: Record<QuizKind, string> = {
  choice: "Pick one of four on your phone. Right and fast scores the most.",
  true_false: "True or false? Right and fast scores the most.",
  picture: "Look at the picture and pick what it shows.",
  estimate: "Type a number. Nobody needs it exactly: the closer you get, the more you score.",
};

/**
 * The answer tiles: a colour and a shape each, the same on the TV and every phone, so you can answer while
 * looking at the TV, and the shape tells them apart without the colour.
 */
export const TILES = [
  { shape: "triangle", label: "Triangle", className: "bg-[#c2410c] text-white" },
  { shape: "diamond", label: "Diamond", className: "bg-[#1d4ed8] text-white" },
  { shape: "circle", label: "Circle", className: "bg-[#a16207] text-white" },
  { shape: "square", label: "Square", className: "bg-[#15803d] text-white" },
] as const;

export const TRUE_FALSE = [
  { value: true, label: "True", className: "bg-[#15803d] text-white" },
  { value: false, label: "False", className: "bg-[#b91c1c] text-white" },
] as const;

export function quizConfig(game: Game): QuizConfig {
  const c = game.config as Partial<QuizConfig>;
  return { rounds: c.rounds ?? 4, per_round: c.per_round ?? 5, seconds: c.seconds ?? 20, round_kinds: c.round_kinds ?? [] };
}

export function totalQuestions(game: Game): number {
  const c = quizConfig(game);
  return c.rounds * c.per_round;
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

/** The revealed answer in words: "Canberra", "False", "1969 (year)". Null before the reveal. */
export function answerText(q: QuizQuestion): string | null {
  const key = keyOf(q);
  if (!key) return null;
  if (key.option !== undefined) return optionsOf(q)[key.option] ?? null;
  if (typeof key.value === "boolean") return key.value ? "True" : "False";
  if (typeof key.value === "number") return `${formatValue(key.value, q.unit)}${q.unit ? ` ${q.unit}` : ""}`;
  return null;
}

/** What a player answered, in words. */
export function pickText(q: QuizQuestion, answer: Key): string {
  if (answer.option !== undefined) return optionsOf(q)[answer.option] ?? "?";
  if (typeof answer.value === "boolean") return answer.value ? "True" : "False";
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

/** The source's article title, from its Wikipedia URL: "Source: Wikipedia, Canberra". */
export function sourceTitle(url: string | null): string | null {
  const match = url?.match(/^https:\/\/en\.wikipedia\.org\/wiki\/([^?#]+)$/);
  return match ? decodeURIComponent(match[1]).replace(/_/g, " ") : null;
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
  const c = quizConfig(game);
  return asked > 0 && asked < c.rounds * c.per_round && asked % c.per_round === 0;
}

/** The round the next question belongs to, and its kind. */
export function nextRound(game: Game, asked: number): { round: number; kind: QuizKind | null } {
  const c = quizConfig(game);
  const round = Math.floor(asked / c.per_round) + 1;
  return { round, kind: c.round_kinds[round - 1] ?? null };
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
