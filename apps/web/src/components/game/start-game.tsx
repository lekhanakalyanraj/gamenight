"use client";

import { useState, useSyncExternalStore, useTransition } from "react";

import Magnet from "@/components/react-bits/Magnet";
import ShinyText from "@/components/react-bits/ShinyText";
import { Button, Card, Notice } from "@/components/ui";
import { startGame } from "@/app/play/[code]/game-actions";
import { LENGTHS } from "@/lib/quiz";
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

type Kind = "undercover" | "quiz" | "heads_up";
const GAME_NAMES: Record<Kind, string> = { undercover: "Undercover", quiz: "Quiz Night", heads_up: "Heads Up" };

/** What the picker says about each game: who it's for, how long, and how it plays in three steps. */
const GAMES: { kind: Kind; players: string; minutes: string; steps: [string, string, string] }[] = [
  { kind: "undercover", players: "3–16", minutes: "~20 min",
    steps: ["Everyone gets a secret word; a few get a close one", "Give one clue each, out loud", "Vote out who's undercover"] },
  { kind: "quiz", players: "3–16", minutes: "8–25 min",
    steps: ["Pick your topics in the lobby", "Answer on your phone, fast", "Teasers open it, connections close it"] },
  { kind: "heads_up", players: "3–16", minutes: "~15 min",
    steps: ["The card shows on the TV", "Everyone describes it to the guesser", "Got it or pass, against the clock"] },
];

/** The host's game picker: a card per game, the picked one lifted and filled. */
function GamePicker({ kind, onChange }: { kind: Kind; onChange: (kind: Kind) => void }) {
  return (
    <div role="radiogroup" aria-label="Game" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {GAMES.map((g) => {
        const picked = g.kind === kind;
        return (
          <button key={g.kind} type="button" role="radio" aria-checked={picked} aria-label={GAME_NAMES[g.kind]}
                  aria-describedby={`game-${g.kind}-about`} onClick={() => onChange(g.kind)}
                  className={`flex flex-col gap-3 border p-4 text-left transition duration-200 motion-reduce:transition-none ${picked ? "-translate-y-1 border-ink bg-ink text-background" : "border-border bg-surface hover:border-ink"}`}>
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-xl tracking-tight">
                {picked ? <ShinyText text={GAME_NAMES[g.kind]} color="#d9dbda" shineColor="#ffffff" speed={2.4} delay={1.6} /> : GAME_NAMES[g.kind]}
              </span>
              <span aria-hidden className={`size-3 ${picked ? "bg-background" : "border border-current opacity-40"}`} />
            </span>
            <span id={`game-${g.kind}-about`} className="flex flex-col gap-3">
              <span className={`caps flex gap-3 text-[11px] ${picked ? "opacity-70" : "text-muted"}`}>
                <span>{g.players} players</span><span>{g.minutes}</span>
              </span>
              <ol className="flex flex-col gap-1 text-sm">
                {g.steps.map((step, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={`font-mono ${picked ? "opacity-60" : "text-muted"}`}>{i + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A row of square buttons, one of which is picked (filled ink). */
function Choices<T extends string | number>({ label, options, value, onChange, format = String }: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  format?: (value: T) => string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="caps mb-2 text-xs text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}
                  className={`h-10 border border-ink px-4 text-sm transition ${value === o ? "bg-ink text-background" : "hover:bg-surface-2"}`}>
            {format(o)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The host picks a game and starts it. Undercover: a theme (or the AI's choice) and a region for word pairs
 * everyone knows. Quiz Night: how long a quiz (short, standard or full) and how long a question (players pick their
 * topics in the lobby).
 * Heads Up: how many turns each and how long a turn (players pick their interests in the lobby).
 */
export function StartGame({ roomId, players, topics, interests }: {
  roomId: string;
  players: number;
  topics: number;
  interests: number;
}) {
  const [kind, setKind] = useState<Kind>("undercover");
  const [theme, setTheme] = useState(THEMES[0]);
  const [rounds, setRounds] = useState<number>(5);
  const [seconds, setSeconds] = useState(20);
  const [turns, setTurns] = useState(1);
  const [turnSeconds, setTurnSeconds] = useState(60);
  const detected = useLocaleRegion();
  const [chosen, setRegion] = useState<string | null>(null);
  const region = chosen ?? detected;
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const short = MIN_PLAYERS - players;
  const name = GAME_NAMES[kind];
  return (
    <Card label="Start a game">
      <GamePicker kind={kind} onChange={setKind} />
      {kind === "undercover" ? (
        <Choices label="Theme for the secret words" options={THEMES} value={theme} onChange={setTheme} />
      ) : kind === "heads_up" ? (
        <>
          <Choices label="Turns each" options={[1, 2] as const} value={turns} onChange={setTurns} />
          <Choices label="Time for each turn" options={[45, 60, 90] as const} value={turnSeconds} onChange={setTurnSeconds}
                   format={(s) => `${s} seconds`} />
          <p className="text-sm text-muted">
            {interests} of {players} picked interests. The deck leans toward them.
          </p>
        </>
      ) : (
        <>
          <Choices label="How long a quiz" options={LENGTHS.map((l) => l.rounds)} value={rounds} onChange={setRounds}
                   format={(r) => LENGTHS.find((l) => l.rounds === r)?.label ?? String(r)} />
          <p className="text-sm text-muted">
            {LENGTHS.find((l) => l.rounds === rounds)?.about}. Brain teasers open it, connections close it.
          </p>
          <Choices label="Time for each question" options={[10, 20, 30] as const} value={seconds} onChange={setSeconds}
                   format={(s) => `${s} seconds`} />
          <p className="text-sm text-muted">
            {topics} of {players} picked a topic. The quiz leans toward the topics of whoever is behind.
          </p>
        </>
      )}
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="caps text-xs text-muted">{kind === "quiz" ? "Questions everyone knows in" : kind === "heads_up" ? "Cards everyone knows in" : "Words everyone knows in"}</span>
        <select value={region} onChange={(e) => setRegion(e.target.value)}
                className="h-10 border border-ink bg-surface px-3 text-foreground">
          {REGIONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
      </label>
      {/* A cursor near Start pulls it a little (a host on a laptop; touch screens are left alone). */}
      <Magnet padding={60} magnetStrength={6} maxOffset={8} wrapperClassName="block w-full">
      <Button
        className="h-14 w-full text-lg"
        disabled={pending || short > 0}
        onClick={() => startTransition(async () => {
          const result = await startGame(roomId, kind === "quiz"
            ? { kind, rounds, seconds, region: region || null }
            : kind === "heads_up"
              ? { kind, turns, seconds: turnSeconds, region: region || null }
              : { kind, theme: theme === THEMES[0] ? null : theme.toLowerCase(), region: region || null });
          setError(result.error);
        })}
      >
        {pending ? "Starting…" : short > 0 ? `${short} more player${short === 1 ? "" : "s"} needed` : `Start ${name}`}
      </Button>
      </Magnet>
      <Notice>{error}</Notice>
    </Card>
  );
}
