import type { AgeRating, HostLine, Room, RoomDisplay, RoomMember } from "@gamenight/db-types";

/** What the lobby screens need from each table. Realtime events carry full rows, which fit these. */
export type LobbyRoom = Pick<Room, "id" | "code" | "status" | "age_rating" | "max_players" | "voice" | "pets">;
export type LobbyMember = Pick<RoomMember, "id" | "user_id" | "nickname" | "role" | "joined_at" | "left_at" | "removed_by_host" | "topic" | "interests"
  | "topic_context" | "interests_context">;
export type LobbyDisplay = Pick<RoomDisplay, "id" | "user_id" | "paired_at">;
export type LobbyHostLine = Pick<HostLine, "id" | "kind" | "text" | "created_at">;
/** A voiced line's audio (narration.clips, broadcast to the room): a file in the private narration bucket. */
export type LobbyClip = { line_id: string; path: string; created_at: string };

// One literal string, so the Supabase client can infer the result type from it.
export const LOBBY_SELECT =
  "id, code, status, age_rating, max_players, voice, pets, room_members(id, user_id, nickname, role, joined_at, left_at, removed_by_host, topic, interests, topic_context, interests_context), room_displays(id, user_id, paired_at), host_lines(id, kind, text, created_at)";

export const MIN_PLAYERS = 3;

export const AGE_LABEL: Record<AgeRating, string> = { family: "Family", teen: "Teen", adult: "18+" };

export function activeMembers(members: LobbyMember[]): LobbyMember[] {
  return members.filter((m) => !m.left_at).sort((a, b) => a.joined_at.localeCompare(b.joined_at));
}

export function initials(nickname: string): string {
  const words = nickname.trim().split(/\s+/);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : nickname.trim().slice(0, 2);
  return letters.toUpperCase();
}

/** The AI host's latest line, if any. */
export function latestHostLine(lines: LobbyHostLine[]): LobbyHostLine | null {
  return lines.reduce<LobbyHostLine | null>((latest, l) => (!latest || l.created_at > latest.created_at ? l : latest), null);
}
