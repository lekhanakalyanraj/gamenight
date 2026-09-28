import { ButtonLink, Card, Page } from "@/components/ui";
import { createClient, getIdentity } from "@/lib/supabase/server";

export default async function PlayPage({ params }: PageProps<"/play/[code]">) {
  const { code } = await params;
  const identity = await getIdentity();
  const supabase = await createClient();

  // RLS returns the room only to its members, so "not found" also covers "not yours".
  const { data: room } = identity
    ? await supabase
        .from("rooms")
        .select("id, code, status, age_rating, room_members(id, nickname, role, user_id, left_at)")
        .eq("code", code.toUpperCase())
        .maybeSingle()
    : { data: null };

  if (!room) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">You&apos;re not in room {code.toUpperCase()}</h1>
        <p className="text-muted">Join with the code to see this room.</p>
        <ButtonLink href={`/join?code=${encodeURIComponent(code)}`}>Join room {code.toUpperCase()}</ButtonLink>
      </Page>
    );
  }

  const members = room.room_members.filter((m) => !m.left_at);
  const me = members.find((m) => m.user_id === identity?.userId);

  return (
    <Page>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted">Room</p>
        <h1 className="font-mono text-5xl tracking-[0.3em] text-accent">{room.code}</h1>
        <p className="text-muted">
          You&apos;re in as <span className="text-foreground">{me?.nickname}</span> · {room.age_rating} · {room.status}
        </p>
      </header>
      <Card>
        <h2 className="mb-3 text-lg font-medium">Players ({members.length}/16)</h2>
        <ul className="flex flex-col gap-2">
          {members.map((m) => (
            <li key={m.id} className="flex items-center justify-between">
              <span>{m.nickname}</span>
              {m.role === "host" ? <span className="text-xs text-accent">host</span> : null}
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-sm text-muted">The live lobby, TV view and games arrive in the next slices.</p>
    </Page>
  );
}
