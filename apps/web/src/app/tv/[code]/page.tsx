import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";

import { fromRow, GAME_SELECT } from "@/lib/game";
import { publicOrigin } from "@/lib/origin";
import { LOBBY_SELECT } from "@/lib/room";
import { createClient, getIdentity } from "@/lib/supabase/server";

import { TvLobby } from "./tv-lobby";

export const metadata: Metadata = { title: "gamenight · TV" };

export default async function TvRoomPage({ params }: PageProps<"/tv/[code]">) {
  const { code } = await params;
  const identity = await getIdentity();
  if (!identity) redirect("/tv");

  // RLS shows a room only to its members and paired TVs, so "not found" means "not paired here".
  const supabase = await createClient();
  const { data } = await supabase.from("rooms").select(LOBBY_SELECT).eq("code", code.toUpperCase()).maybeSingle();
  if (!data) redirect("/tv");

  const { data: game } = await supabase.from("games").select(GAME_SELECT).eq("room_id", data.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { room_members, room_displays, host_lines, ...room } = data;
  const joinUrl = `${await publicOrigin()}/join?code=${room.code}`;
  const qr = await QRCode.toDataURL(joinUrl, {
    margin: 1,
    width: 560,
    errorCorrectionLevel: "M",
    color: { dark: "#12121f", light: "#f4f1ea" },
  });

  return (
    <TvLobby
      lobby={{ room, members: room_members, displays: room_displays, hostLines: host_lines, game: game ? fromRow(game) : null }}
      userId={identity.userId}
      joinUrl={joinUrl}
      qr={qr}
    />
  );
}
