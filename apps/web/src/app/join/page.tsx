import { redirect } from "next/navigation";

import { Card, Page } from "@/components/ui";
import { createClient, getIdentity } from "@/lib/supabase/server";
import { isRoomCode } from "@/lib/validate";

import { JoinForm } from "./join-form";

export default async function JoinPage({ searchParams }: PageProps<"/join">) {
  const { code } = await searchParams;
  const prefill = typeof code === "string" && isRoomCode(code) ? code.toUpperCase() : "";

  // Scanning the QR again (or refreshing) shouldn't ask a player who's already in to join twice.
  const identity = prefill ? await getIdentity() : null;
  if (identity) {
    const supabase = await createClient();
    const { data: member } = await supabase
      .from("room_members")
      .select("id, rooms!inner(code)")
      .eq("rooms.code", prefill)
      .eq("user_id", identity.userId)
      .is("left_at", null)
      .maybeSingle();
    if (member) redirect(`/play/${prefill}`);
  }
  return (
    <Page>
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Join a game</h1>
        <p className="text-muted">Enter the code on the TV. No account needed.</p>
      </header>
      <Card>
        <JoinForm code={prefill} />
      </Card>
    </Page>
  );
}
