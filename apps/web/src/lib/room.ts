import type { AgeRating, HostLine, Room, RoomDisplay, RoomMember } from "@gamenight/db-types";

/** What the lobby screens need from each table. Realtime events carry full rows, which fit these. */
export type LobbyRoom = Pick<Room, "id" | "code" | "status" | "age_rating" | "max_players">;
export type LobbyMember = Pick<RoomMember, "id" | "user_id" | "nickname" | "role" | "joined_at" | "left_at" | "removed_by_host">;
export type LobbyDisplay = Pick<RoomDisplay, "id" | "user_id" | "paired_at">;
export type LobbyHostLine = Pick<HostLine, "id" | "kind" | "text" | "created_at">;

// One literal string, so the Supabase client can infer the result type from it.
export const LOBBY_SELECT =
  "id, code, status, age_rating, max_players, room_members(id, user_id, nickname, role, joined_at, left_at, removed_by_host), room_displays(id, user_id, paired_at), host_lines(id, kind, text, created_at)";

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

// Tile colours, picked from the member's id so everyone keeps the same colour on every screen.
const TILE_COLOURS = [
  "bg-[#7c5cff]", "bg-[#ff7a59]", "bg-[#2bb673]", "bg-[#e0508b]",
  "bg-[#3aa0ff]", "bg-[#d9a400]", "bg-[#00a6a6]", "bg-[#b35cff]",
];
export function tileColour(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return TILE_COLOURS[Math.abs(hash) % TILE_COLOURS.length];
}

/** The AI host's latest line, if any. */
export function latestHostLine(lines: LobbyHostLine[]): LobbyHostLine | null {
  return lines.reduce<LobbyHostLine | null>((latest, l) => (!latest || l.created_at > latest.created_at ? l : latest), null);
}
