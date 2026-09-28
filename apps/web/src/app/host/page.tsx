import Link from "next/link";

import { Button, Card, Page } from "@/components/ui";
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
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Hi, {name}</h1>
          <p className="text-muted">Create a room, put it on the TV, and everyone joins from their phone.</p>
        </div>
        <form action={signOut}>
          <Button variant="secondary" className="h-9 whitespace-nowrap text-sm">Sign out</Button>
        </form>
      </header>

      <Card>
        <h2 className="mb-4 text-lg font-medium">New room</h2>
        <CreateRoomForm defaultNickname={name.slice(0, 20)} />
      </Card>

      {rooms && rooms.length > 0 ? (
        <Card>
          <h2 className="mb-3 text-lg font-medium">Your open rooms</h2>
          <ul className="flex flex-col divide-y divide-border">
            {rooms.map((room) => (
              <li key={room.code} className="flex items-center justify-between py-2">
                <Link href={`/play/${room.code}`} className="font-mono text-lg tracking-widest text-accent">
                  {room.code}
                </Link>
                <span className="text-sm text-muted">{room.age_rating} · {room.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Page>
  );
}
