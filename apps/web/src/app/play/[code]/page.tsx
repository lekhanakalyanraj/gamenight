import { ButtonLink, Page } from "@/components/ui";
import { fromRow, GAME_SELECT } from "@/lib/game";
import { LOBBY_SELECT } from "@/lib/room";
import { createClient, getIdentity } from "@/lib/supabase/server";

import { PhoneLobby } from "./phone-lobby";

export default async function PlayPage({ params }: PageProps<"/play/[code]">) {
  const { code } = await params;
  const identity = await getIdentity();
  const supabase = await createClient();

  // RLS returns the room only to its members (and TVs), so "not found" also covers "not yours".
  const { data } = identity
    ? await supabase.from("rooms").select(LOBBY_SELECT).eq("code", code.toUpperCase()).maybeSingle()
    : { data: null };
  const me = data?.room_members.find((m) => m.user_id === identity?.userId && !m.left_at);

  if (!data || !me) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">You&apos;re not in room {code.toUpperCase()}</h1>
        <p className="text-muted">Join with the code to see this room.</p>
        <ButtonLink href={`/join?code=${encodeURIComponent(code)}`}>Join room {code.toUpperCase()}</ButtonLink>
      </Page>
    );
  }

  const { data: game } = await supabase.from("games").select(GAME_SELECT).eq("room_id", data.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { room_members, room_displays, host_lines, ...room } = data;
  return (
    <PhoneLobby
      lobby={{ room, members: room_members, displays: room_displays, hostLines: host_lines, clips: [], game: game ? fromRow(game) : null }}
      meId={me.id}
      isHost={me.role === "host"}
    />
  );
}
