"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useDisplayEvents } from "@/lib/realtime";
import { useSupabase } from "@/lib/supabase/client";

const NEW_CODE_EVERY_MS = 9 * 60 * 1000; // codes expire after 10 minutes
const CHECK_PAIRED_EVERY_MS = 4000; // backup for a "paired" broadcast missed while reconnecting

type Supabase = ReturnType<typeof useSupabase>;
type Started = { uid: string; pairedRoom: string | null; code: string | null } | { error: string };

async function pairedRoomCode(supabase: Supabase, uid: string): Promise<string | null> {
  const { data } = await supabase.from("room_displays").select("rooms(code, status)").eq("user_id", uid);
  const open = data?.map((d) => d.rooms).find((room) => room && room.status !== "closed");
  return open?.code ?? null;
}

async function start(supabase: Supabase): Promise<Started> {
  // A TV never has an account: an anonymous user is its identity, and RLS scopes it to its paired room.
  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error || !data.session) return { error: "Couldn't start. Check the connection and reload." };
    session = data.session;
  }
  const uid = session.user.id;
  const pairedRoom = await pairedRoomCode(supabase, uid);
  if (pairedRoom) return { uid, pairedRoom, code: null };
  const { data: code, error } = await supabase.rpc("start_display_pairing");
  if (error || !code) return { error: "Couldn't get a code. Check the connection and reload." };
  return { uid, pairedRoom: null, code };
}

// React may start this page twice (Strict Mode, fast remounts). Two anonymous sign-ins racing each
// other could leave the TV signed in as one user while showing the code issued to another, so any
// start that begins while one is in flight shares its result.
let inFlight: Promise<Started> | null = null;
function startOnce(supabase: Supabase): Promise<Started> {
  inFlight ??= start(supabase).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function TvPairing() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supabase = useSupabase();

  useDisplayEvents(userId, { onPaired: (roomCode) => router.replace(`/tv/${roomCode}`) });

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setInterval>[] = [];

    async function run() {
      const started = await startOnce(supabase);
      if (cancelled) return;
      if ("error" in started) {
        setError(started.error);
        return;
      }
      if (started.pairedRoom) {
        router.replace(`/tv/${started.pairedRoom}`);
        return;
      }
      const uid = started.uid;
      setUserId(uid);
      setCode(started.code);
      timers.push(
        setInterval(async () => {
          const { data } = await supabase.rpc("start_display_pairing");
          if (data && !cancelled) setCode(data);
        }, NEW_CODE_EVERY_MS),
        setInterval(async () => {
          const paired = await pairedRoomCode(supabase, uid);
          if (paired && !cancelled) router.replace(`/tv/${paired}`);
        }, CHECK_PAIRED_EVERY_MS),
      );
    }

    void run();
    return () => {
      cancelled = true;
      timers.forEach(clearInterval);
    };
  }, [router, supabase]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 p-10 text-center">
      <p className="font-mono text-xl tracking-[0.4em] text-accent">GAMENIGHT</p>
      <div className="flex flex-col items-center gap-4">
        <p className="text-2xl text-muted">TV code</p>
        <p data-testid="pairing-code" className="font-mono text-[14vw] leading-none tracking-[0.2em]">
          {code ?? "······"}
        </p>
      </div>
      <p className="max-w-3xl text-2xl text-muted">
        On the host&apos;s phone, open the room and choose <span className="text-foreground">Connect a TV</span>, then
        enter this code.
      </p>
      {error ? <p role="alert" className="text-xl text-danger">{error}</p> : null}
    </main>
  );
}
