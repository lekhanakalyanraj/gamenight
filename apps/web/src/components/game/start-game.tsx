"use client";

import { useState, useSyncExternalStore, useTransition } from "react";

import { Button, Card, Notice } from "@/components/ui";
import { startGame } from "@/app/play/[code]/game-actions";
import { MIN_PLAYERS } from "@/lib/room";

const THEMES = ["Surprise me", "Food", "Movies", "Travel", "Animals", "Sports"];
const REGIONS = [
  { code: "", label: "Anywhere" },
  { code: "IN", label: "India" },
  { code: "GB", label: "UK" },
  { code: "US", label: "US" },
];

const noSubscription = () => () => {};

/** The browser's region (en-IN → India) if it's one we have words for; nothing on the server. */
function useLocaleRegion(): string {
  return useSyncExternalStore(noSubscription, () => {
    const code = new Intl.Locale(navigator.language).maximize().region ?? "";
    return REGIONS.some((r) => r.code === code) ? code : "";
  }, () => "");
}

type Kind = "undercover" | "quiz";

/** Small round buttons, one of which is picked. */
function Choices<T extends string | number>({ label, options, value, onChange, format = String }: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  format?: (value: T) => string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}
                  className={`h-10 rounded-full border px-4 text-sm transition ${value === o ? "border-accent bg-accent text-accent-ink" : "border-border bg-surface-2"}`}>
            {format(o)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The host picks a game and starts it. Undercover: a theme (or the AI's choice) and a region for word pairs
 * everyone knows. Quiz Night: how many rounds and how long a question (players pick their topics in the lobby).
 */
export function StartGame({ roomId, players, topics }: { roomId: string; players: number; topics: number }) {
  const [kind, setKind] = useState<Kind>("undercover");
  const [theme, setTheme] = useState(THEMES[0]);
  const [rounds, setRounds] = useState(4);
  const [seconds, setSeconds] = useState(20);
  const detected = useLocaleRegion();
  const [chosen, setRegion] = useState<string | null>(null);
  const region = chosen ?? detected;
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const short = MIN_PLAYERS - players;
  const name = kind === "quiz" ? "Quiz Night" : "Undercover";
  return (
    <Card className="flex flex-col gap-4">
      <div role="tablist" aria-label="Game" className="grid grid-cols-2 gap-1 rounded-full border border-border bg-surface-2 p-1">
        {(["undercover", "quiz"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                  className={`h-10 rounded-full text-sm font-medium transition ${kind === k ? "bg-accent text-accent-ink" : "text-muted"}`}>
            {k === "quiz" ? "Quiz Night" : "Undercover"}
          </button>
        ))}
      </div>
      {kind === "undercover" ? (
        <Choices label="Theme for the secret words" options={THEMES} value={theme} onChange={setTheme} />
      ) : (
        <>
          <Choices label="Rounds of 5 questions" options={[3, 4, 5] as const} value={rounds} onChange={setRounds} />
          <Choices label="Time for each question" options={[10, 20, 30] as const} value={seconds} onChange={setSeconds}
                   format={(s) => `${s} seconds`} />
          <p className="text-sm text-muted">
            {topics} of {players} picked a topic. The quiz leans toward the topics of whoever is behind.
          </p>
        </>
      )}
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted">{kind === "quiz" ? "Questions everyone knows in" : "Words everyone knows in"}</span>
        <select value={region} onChange={(e) => setRegion(e.target.value)}
                className="h-10 rounded-xl border border-border bg-background px-3 text-foreground">
          {REGIONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      <Button
        className="h-12 text-lg"
        disabled={pending || short > 0}
        onClick={() => startTransition(async () => {
          const result = await startGame(roomId, kind === "quiz"
            ? { kind, rounds, seconds, region: region || null }
            : { kind, theme: theme === THEMES[0] ? null : theme.toLowerCase(), region: region || null });
          setError(result.error);
        })}
      >
        {pending ? "Starting…" : short > 0 ? `${short} more player${short === 1 ? "" : "s"} needed` : `Start ${name}`}
      </Button>
      <Notice>{error}</Notice>
    </Card>
  );
}
