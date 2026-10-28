"use client";

import { useState, useTransition } from "react";

import { setPets, setVoice } from "@/app/play/[code]/game-actions";
import { Button, Notice } from "@/components/ui";

/** A host's on/off switch for a room setting, saved in the room (so the TV follows it). */
function RoomSwitch({ label, on, testId, save }: {
  label: string;
  on: boolean;
  testId: string;
  save: (on: boolean) => Promise<{ error?: string }>;
}) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <Button variant="secondary" data-testid={testId} aria-pressed={on} disabled={pending}
              onClick={() => startTransition(async () => setError((await save(!on)).error))}>
        {label}: {on ? "on" : "off"}
      </Button>
      <Notice>{error}</Notice>
    </div>
  );
}

/** The host's switch for the narrator's voice. Off: captions only, and nothing is sent to text to speech. */
export function VoiceSwitch({ roomId, on }: { roomId: string; on: boolean }) {
  return <RoomSwitch label="AI voice" on={on} testId="voice-switch" save={(next) => setVoice(roomId, next)} />;
}

/** The host's switch for the TV's pets. */
export function PetsSwitch({ roomId, on }: { roomId: string; on: boolean }) {
  return <RoomSwitch label="TV pets" on={on} testId="pets-switch" save={(next) => setPets(roomId, next)} />;
}
