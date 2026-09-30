"use client";

import { useEffect, useState } from "react";

import { useServerOffset } from "@/lib/clock";
import { NarrationPlayer, type NarratorSnapshot } from "@/lib/narration";
import type { LobbyClip, LobbyHostLine } from "@/lib/room";
import { useSupabase } from "@/lib/supabase/client";

/**
 * The AI host's voice on the TV. Captions are always on screen; this plays each line's clip as it arrives,
 * once someone has tapped "Start the show" (browsers block sound until then). The badge says the voice is
 * AI-generated whenever it's on.
 */
export function Narrator({ lines, clips, voiceOn }: { lines: LobbyHostLine[]; clips: LobbyClip[]; voiceOn: boolean }) {
  const supabase = useSupabase();
  const offset = useServerOffset();
  const [snapshot, setSnapshot] = useState<NarratorSnapshot>({ state: "locked", played: 0, skipped: 0 });
  const [player] = useState(() => new NarrationPlayer(
    async (path) => (await supabase.storage.from("narration").download(path)).data ?? null,
    setSnapshot,
  ));

  useEffect(() => player.setClockOffset(offset), [player, offset]);
  useEffect(() => player.setEnabled(voiceOn), [player, voiceOn]);
  useEffect(() => () => player.stop(), [player]);
  useEffect(() => {
    const shownAt = new Map(lines.map((l) => [l.id, Date.parse(l.created_at)]));
    for (const clip of clips) player.offer(clip.line_id, clip.path, shownAt.get(clip.line_id) ?? Date.parse(clip.created_at));
  }, [player, lines, clips]);

  const state = voiceOn ? snapshot.state : "off";
  const common = { "data-testid": "narrator", "data-state": state, "data-played": snapshot.played };
  const place = "fixed bottom-6 right-6 z-30";

  if (state === "off") {
    return <p {...common} role="status" className={`${place} rounded-full bg-surface-2 px-4 py-2 text-lg text-muted`}>Voice off</p>;
  }
  if (state === "locked") {
    return (
      <button {...common} type="button" onClick={() => void player.unlock()}
              className={`${place} flex flex-col items-start rounded-3xl bg-accent px-8 py-5 text-left text-accent-ink shadow-lg`}>
        <span className="text-3xl font-semibold">Start the show</span>
        <span className="text-lg">Turns on the AI host&apos;s voice</span>
      </button>
    );
  }
  return (
    <p {...common} role="status" className={`${place} flex items-center gap-2 rounded-full bg-surface-2 px-4 py-2 text-lg`}>
      <span aria-hidden className={`size-3 rounded-full bg-accent ${state === "speaking" ? "animate-pulse" : "opacity-40"}`} />
      AI voice
    </p>
  );
}
