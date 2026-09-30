"use client";

import { useState, useTransition } from "react";

import { setVoice } from "@/app/play/[code]/game-actions";
import { Button, Notice } from "@/components/ui";

/** The host's switch for the narrator's voice. Off: captions only, and nothing is sent to text to speech. */
export function VoiceSwitch({ roomId, on }: { roomId: string; on: boolean }) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        data-testid="voice-switch"
        aria-pressed={on}
        disabled={pending}
        onClick={() => startTransition(async () => setError((await setVoice(roomId, !on)).error))}
      >
        {on ? "AI voice: on" : "AI voice: off"}
      </Button>
      <Notice>{error}</Notice>
    </div>
  );
}
