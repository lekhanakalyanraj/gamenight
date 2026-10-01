"use server";

import type { GameAction, QuizAnswer } from "@gamenight/db-types";

import { friendlyError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validate";

// Every rule (whose turn it is, the host only, the phase) is enforced by the RPCs, as the signed-in player;
// these only check the input's shape.

const BAD = { error: "Something went wrong. Please try again." };
const REGIONS = new Set(["IN", "GB", "US"]);

export type GameSetup =
  | { kind: "undercover"; theme: string | null; region: string | null }
  | { kind: "quiz"; rounds: number; seconds: number; region: string | null };

export async function startGame(roomId: string, setup: GameSetup): Promise<{ error?: string }> {
  if (!isUuid(roomId)) return BAD;
  const settings: Record<string, string | number> = {};
  if (setup.region && REGIONS.has(setup.region)) settings.region = setup.region;
  if (setup.kind === "undercover") {
    const cleanTheme = setup.theme?.trim().slice(0, 30);
    if (cleanTheme) settings.theme = cleanTheme;
  } else if (setup.kind === "quiz") {
    if (![3, 4, 5].includes(setup.rounds) || ![10, 20, 30].includes(setup.seconds)) return BAD;
    settings.rounds = setup.rounds;
    settings.seconds = setup.seconds;
  } else {
    return BAD;
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("start_game", { p_room_id: roomId, p_kind: setup.kind, p_settings: settings });
  return error ? { error: friendlyError(error) } : {};
}

/**
 * A quiz answer: an option ({option}), true or false ({value: boolean}) or an estimate ({value: number}). The
 * server stamps the time; the phone makes the answer id, so a retried tap counts once.
 */
export async function answerQuestion(
  gameId: string,
  answer: { option: number } | { value: boolean | number },
  actionId: string,
): Promise<{ answer?: QuizAnswer; error?: string }> {
  if (!isUuid(gameId) || !isUuid(actionId)) return BAD;
  let clean: { option: number } | { value: boolean | number };
  if ("option" in answer) {
    if (!Number.isInteger(answer.option) || answer.option < 0 || answer.option > 3) return BAD;
    clean = { option: answer.option };
  } else if (typeof answer.value === "boolean" || (typeof answer.value === "number" && Number.isFinite(answer.value))) {
    clean = { value: answer.value };
  } else {
    return { error: "Type a number first." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("answer_question", {
    p_game_id: gameId, p_answer: clean, p_action_id: actionId,
  });
  return error ? { error: friendlyError(error) } : { answer: data ?? undefined };
}

/** The last-placed player doubles this question's points (going into the final round, before answering). */
export async function playJoker(gameId: string): Promise<{ error?: string }> {
  if (!isUuid(gameId)) return BAD;
  const supabase = await createClient();
  const { error } = await supabase.rpc("play_joker", { p_game_id: gameId });
  return error ? { error: friendlyError(error) } : {};
}

/** Your topic for Quiz Night, picked in the lobby (the database checks its length and characters). */
export async function setTopic(roomId: string, topic: string | null): Promise<{ error?: string }> {
  if (!isUuid(roomId) || (topic !== null && typeof topic !== "string")) return BAD;
  const clean = topic?.trim().replace(/\s+/g, " ").slice(0, 30) || null;
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_topic", { p_room_id: roomId, p_topic: clean ?? "" }); // "" clears it
  return error ? { error: friendlyError(error) } : {};
}

/**
 * A player's move. The phone makes the move id, so a tap that's retried (a slow network, a double tap)
 * is the same move and counts once.
 */
export async function makeMove(
  gameId: string,
  kind: "done" | "vote" | "guess",
  payload: { target?: string; text?: string },
  actionId: string,
): Promise<{ move?: GameAction; error?: string }> {
  if (!isUuid(gameId) || !isUuid(actionId) || !["done", "vote", "guess"].includes(kind)) return BAD;
  if (kind === "vote" && !isUuid(payload.target)) return BAD;
  if (kind === "guess" && (typeof payload.text !== "string" || payload.text.trim().length === 0)) {
    return { error: "Type a guess first." };
  }
  const clean = kind === "vote" ? { target: payload.target } : kind === "guess" ? { text: payload.text?.trim().slice(0, 40) } : {};
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_action", {
    p_game_id: gameId, p_kind: kind, p_payload: clean, p_action_id: actionId,
  });
  return error ? { error: friendlyError(error) } : { move: data ?? undefined };
}

const CONTROLS = {
  pause: "pause_game",
  resume: "resume_game",
  skip_turn: "skip_turn",
  skip_phase: "skip_phase",
  end: "end_game",
} as const;

/** The host steering: pause, resume, skip a speaker or a phase, end the game, or add 30 seconds. */
export async function hostControl(gameId: string, control: keyof typeof CONTROLS | "extend"): Promise<{ error?: string }> {
  if (!isUuid(gameId)) return BAD;
  const supabase = await createClient();
  if (control === "extend") {
    const { error } = await supabase.rpc("extend_phase", { p_game_id: gameId, p_seconds: 30 });
    return error ? { error: friendlyError(error) } : {};
  }
  if (!(control in CONTROLS)) return BAD;
  const { error } = await supabase.rpc(CONTROLS[control], { p_game_id: gameId });
  return error ? { error: friendlyError(error) } : {};
}

/** The host turns the AI host's voice on or off for the room. Off: captions only, nothing sent to text to speech. */
export async function setVoice(roomId: string, on: boolean): Promise<{ error?: string }> {
  if (!isUuid(roomId) || typeof on !== "boolean") return BAD;
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_voice", { p_room_id: roomId, p_on: on });
  return error ? { error: friendlyError(error) } : {};
}

/** The host agrees with the AI's verdict on Mr. White's guess, or overrules it. */
export async function settleVerdict(gameId: string, overrule: boolean): Promise<{ error?: string }> {
  if (!isUuid(gameId)) return BAD;
  const supabase = await createClient();
  const { error } = await supabase.rpc("settle_judgement", { p_game_id: gameId, p_overrule: overrule });
  return error ? { error: friendlyError(error) } : {};
}
