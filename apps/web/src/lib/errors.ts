import type { PostgrestError } from "@supabase/supabase-js";

// Codes our RPCs raise on purpose; their messages are written for players and safe to show.
// PT429 is our rate limit on guessing codes (the Data API answers it with HTTP 429); 22023 is a game move
// the rules don't allow ("Vote for another player who's still in.").
const PLAYER_FACING = new Set(["28000", "42501", "P0002", "22023", "23505", "53400", "55000", "PT429"]);

export function friendlyError(error: Pick<PostgrestError, "code" | "message"> | null | undefined): string {
  if (!error) return "Something went wrong. Please try again.";
  if (error.code && PLAYER_FACING.has(error.code)) return error.message;
  if (error.code === "23514") return "Check your nickname: 1 to 20 characters.";
  return "Something went wrong. Please try again.";
}
