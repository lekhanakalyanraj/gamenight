import Link from "next/link";

import { Card, Page, Wordmark } from "@/components/ui";
import { createClient, getIdentity } from "@/lib/supabase/server";

import { signOut } from "../auth/actions";
import { CreateRoomForm } from "./create-room-form";

export default async function HostPage() {
  const identity = await getIdentity(); // proxy.ts guarantees a signed-in host here
  const supabase = await createClient();
  const [{ data: profile }, { data: rooms }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", identity!.userId).maybeSingle(),
    supabase
      .from("rooms")
      .select("code, status, age_rating, created_at")
      .eq("host_id", identity!.userId)
      .neq("status", "closed")
      .order("created_at", { ascending: false }),
  ]);
  const name = profile?.display_name ?? "Host";

  return (
    <Page>
      <Wordmark right={
        <form action={signOut}>
          <button className="caps text-xs text-muted hover:text-foreground">Sign out</button>
        </form>
      } />
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl tracking-tight">Hi, {name}</h1>
        <p className="text-muted">Create a room, put it on the TV, and everyone joins from their phone.</p>
      </header>

      <Card label="New room">
        <CreateRoomForm defaultNickname={name.slice(0, 20)} />
      </Card>

      {rooms && rooms.length > 0 ? (
        <Card label="Your open rooms">
          <ul className="flex flex-col">
            {rooms.map((room) => (
              <li key={room.code} className="border-b border-border last:border-b-0">
                <Link href={`/play/${room.code}`} className="flex items-center justify-between py-3 hover:bg-surface-2">
                  <span className="font-mono text-xl tracking-[0.3em]">{room.code}</span>
                  <span className="caps text-xs text-muted">{room.age_rating} · {room.status} →</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Page>
  );
}
