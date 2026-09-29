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

/** The host starts Undercover: a theme (or the AI's choice) and a region for word pairs everyone knows. */
export function StartGame({ roomId, players }: { roomId: string; players: number }) {
  const [theme, setTheme] = useState(THEMES[0]);
  const detected = useLocaleRegion();
  const [chosen, setRegion] = useState<string | null>(null);
  const region = chosen ?? detected;
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();


  const short = MIN_PLAYERS - players;
  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">Play Undercover</h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm text-muted">Theme for the secret words</legend>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((t) => (
            <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}
                    className={`h-10 rounded-full border px-4 text-sm transition ${theme === t ? "border-accent bg-accent text-accent-ink" : "border-border bg-surface-2"}`}>
              {t}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted">Words everyone knows in</span>
        <select value={region} onChange={(e) => setRegion(e.target.value)}
                className="h-10 rounded-xl border border-border bg-background px-3 text-foreground">
          {REGIONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      <Button
        className="h-12 text-lg"
        disabled={pending || short > 0}
        onClick={() => startTransition(async () => {
          const result = await startGame(roomId, theme === THEMES[0] ? null : theme.toLowerCase(), region || null);
          setError(result.error);
        })}
      >
        {pending ? "Starting…" : short > 0 ? `${short} more player${short === 1 ? "" : "s"} needed` : "Start Undercover"}
      </Button>
      <Notice>{error}</Notice>
    </Card>
  );
}
