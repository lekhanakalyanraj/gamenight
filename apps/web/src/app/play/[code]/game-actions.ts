"use server";

import type { GameAction } from "@gamenight/db-types";

import { friendlyError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validate";

// Every rule (whose turn it is, the host only, the phase) is enforced by the RPCs, as the signed-in player;
// these only check the input's shape.

const BAD = { error: "Something went wrong. Please try again." };
const REGIONS = new Set(["IN", "GB", "US"]);

export async function startGame(roomId: string, theme: string | null, region: string | null): Promise<{ error?: string }> {
  if (!isUuid(roomId)) return BAD;
  const settings: Record<string, string> = {};
  const cleanTheme = theme?.trim().slice(0, 30);
  if (cleanTheme) settings.theme = cleanTheme;
  if (region && REGIONS.has(region)) settings.region = region;
  const supabase = await createClient();
  const { error } = await supabase.rpc("start_game", { p_room_id: roomId, p_kind: "undercover", p_settings: settings });
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
