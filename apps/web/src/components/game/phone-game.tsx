"use client";

import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState, useTransition } from "react";

import { HostDrawer } from "@/components/game/host-drawer";
import { Avatar, Elimination, HoldCard, PhaseTitle, TimerRing } from "@/components/game/parts";
import { FinalReveal } from "@/components/game/reveal";
import { HostCaption } from "@/components/lobby";
import { Button, Notice } from "@/components/ui";
import { makeMove, settleVerdict } from "@/app/play/[code]/game-actions";
import { useCountdown, useNow } from "@/lib/clock";
import {
  alive,
  HOW_TO_PLAY,
  judgementOf,
  lastResult,
  type LiveGame,
  PHASE_LABEL,
  type Role,
  ROLE_LABEL,
  speaker,
  voteCandidates,
} from "@/lib/game";
import { newId } from "@/lib/ids";
import { type LiveRoom, usePrivateGame } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";

/** How long a vote result stays up on a phone before the next phase takes over. */
const RESULT_SECONDS = 8;

export default function PhoneGame({ live, meId, isHost, onBackToLobby }: {
  live: LiveRoom & { game: LiveGame };
  meId: string;
  isHost: boolean;
  onBackToLobby: () => void;
}) {
  const { game, players, results } = live.game;
  const { card, moves, refetch, addMove } = usePrivateGame(meId, game.id);
  const now = useNow();
  const names = new Map(live.members.map((m) => [m.id, m.nickname]));
  const me = players.find((p) => p.member_id === meId);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  // The card arrives on this phone's private topic; if that broadcast was missed, read it.
  useEffect(() => {
    if (game.phase !== "setup" && game.phase !== "ended" && !card) void refetch();
  }, [game.phase, game.step, card, refetch]);

  function move(kind: "done" | "vote" | "guess", payload: { target?: string; text?: string } = {}) {
    setError(undefined);
    const id = newId(); // made here, so a retried tap is the same move
    startTransition(async () => {
      const result = await makeMove(game.id, kind, payload, id);
      if (result.error) setError(result.error);
      else if (result.move) addMove(result.move);
    });
  }

  const { left, total } = useCountdown(game.turn_deadline ?? game.phase_deadline, now);
  const recent = lastResult(results);
  const showResult = recent && now - Date.parse(recent.created_at) < RESULT_SECONDS * 1000 && recent.kind === "vote";

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="phone-game" data-phase={game.phase} className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-5 py-6 pb-28">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted">{game.phase === "ended" ? "Undercover" : `Round ${Math.max(game.round, 1)}`}</p>
            <h1 className="text-2xl font-semibold">{PHASE_LABEL[game.phase]}</h1>
          </div>
          {left !== null && !game.paused_at ? (
            <TimerRing seconds={left} total={total} />
          ) : null}
        </header>

        <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} />

        {game.paused_at ? <Banner>Paused by the host</Banner> : null}

        <AnimatePresence>
          {showResult && recent.eliminated && recent.revealed_role ? (
            <motion.div key={recent.id} exit={{ opacity: 0, height: 0 }}>
              <Elimination id={recent.eliminated} name={names.get(recent.eliminated) ?? "?"} role={recent.revealed_role as Role} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <PhaseTitle id={`${game.phase}-${game.step}-${game.turn_index ?? ""}-${game.resolved}`} className="flex flex-col gap-4">
          {game.phase === "ended" ? (
            <>
              <FinalReveal live={live.game} names={names} />
              <Button onClick={onBackToLobby}>{isHost ? "Play again" : "Back to the lobby"}</Button>
            </>
          ) : me && !me.alive && game.guesser !== meId ? (
            <Status title="You're out" tone="danger">
              You were {me.revealed_role ? ROLE_LABEL[me.revealed_role as Role] : "?"}. Keep watching, and no hints.
            </Status>
          ) : (
            <PhaseBody
              live={live.game}
              meId={meId}
              names={names}
              moves={moves}
              pending={pending}
              isHost={isHost}
              onMove={move}
              onSettle={(overrule) =>
                startTransition(async () => setError((await settleVerdict(game.id, overrule)).error))
              }
            />
          )}
        </PhaseTitle>

        <Notice>{error}</Notice>

        {game.phase !== "ended" && me ? <HoldCard card={card} /> : null}

        {game.phase !== "ended" ? (
          <details className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">How to play</summary>
            <p className="mt-2 text-muted">{HOW_TO_PLAY[game.phase]}</p>
          </details>
        ) : null}

        {!live.connected ? <p role="status" className="text-center text-sm text-muted">Reconnecting…</p> : null}
      </main>
      {isHost && game.phase !== "ended" ? <HostDrawer game={game} roomId={live.room.id} voice={live.room.voice} /> : null}
    </MotionConfig>
  );
}

function PhaseBody({ live, meId, names, moves, pending, isHost, onMove, onSettle }: {
  live: LiveGame;
  meId: string;
  names: Map<string, string>;
  moves: { kind: string; step: number; payload: unknown }[];
  pending: boolean;
  isHost: boolean;
  onMove: (kind: "done" | "vote" | "guess", payload?: { target?: string; text?: string }) => void;
  onSettle: (overrule: boolean) => void;
}) {
  const { game, players } = live;
  const name = (id: string | null) => (id ? (names.get(id) ?? "?") : "?");

  switch (game.phase) {
    case "setup":
      return <Status title="The detective is dealing…">Your card is on its way. Hold the card below to peek.</Status>;

    case "clues": {
      const current = speaker(game);
      if (!current) return <Status title="Every clue is in">The detective is thinking…</Status>;
      if (current === meId) {
        return (
          <div data-testid="your-turn" className="flex flex-col gap-4">
            <motion.div
              initial={{ scale: 0.8 }}
              animate={{ scale: [0.8, 1.06, 1] }}
              transition={{ duration: 0.5 }}
              className="rounded-3xl bg-accent px-5 py-6 text-center text-accent-ink"
            >
              <p className="text-3xl font-semibold">You&apos;re up</p>
              <p className="mt-1">Say your clue out loud</p>
            </motion.div>
            <Button className="h-14 text-lg" disabled={pending} onClick={() => onMove("done")}>Done</Button>
          </div>
        );
      }
      const next = game.turn_index !== null ? game.turn_order[game.turn_index + 1] : null;
      return (
        <Status title={`${name(current)} is speaking`}>
          {next ? (next === meId ? "You're next. Get your clue ready." : `Next: ${name(next)}`) : "Last clue of the round."}
        </Status>
      );
    }

    case "discussion":
      return <Status title="Talk it out">Whose clue didn&apos;t quite fit? The vote opens soon.</Status>;

    case "vote": {
      if (game.resolved) return <Status title="The votes are counted">The detective is thinking…</Status>;
      const mine = moves.find((m) => m.kind === "vote" && m.step === game.step);
      const voters = alive(players).length;
      if (mine) {
        return (
          <Status title={`You voted for ${name((mine.payload as { target: string }).target)}`}>
            {game.moves_in} of {voters} voted
          </Status>
        );
      }
      return <VoteList candidates={voteCandidates(game, players, meId).map((p) => p.member_id)} names={names}
                       progress={`${game.moves_in} of ${voters} voted`} pending={pending} onVote={(t) => onMove("vote", { target: t })} />;
    }

    case "guess": {
      const judgement = judgementOf(game);
      if (judgement) {
        return (
          <div className="flex flex-col gap-4">
            <motion.p
              initial={{ scale: 2, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 15 }}
              className={`text-center text-5xl font-semibold ${judgement.verdict ? "text-accent" : "text-danger"}`}
            >
              {judgement.verdict ? "Right!" : "Wrong!"}
            </motion.p>
            <p className="text-center text-muted">
              {judgement.settled ? "" : "The detective has ruled. The host can overrule."}
            </p>
            {isHost && !judgement.settled ? (
              <div className="flex gap-3">
                <Button className="flex-1" disabled={pending} onClick={() => onSettle(false)}>Agree</Button>
                <Button variant="secondary" className="flex-1" disabled={pending} onClick={() => onSettle(true)}>Overrule</Button>
              </div>
            ) : null}
          </div>
        );
      }
      if (game.guesser === meId) return <GuessBox pending={pending} onGuess={(text) => onMove("guess", { text })} />;
      return <Status title={`${name(game.guesser)} was Mr. White`}>One guess at the civilians&apos; word…</Status>;
    }

    default:
      return null;
  }
}

function VoteList({ candidates, names, progress, pending, onVote }: {
  candidates: string[];
  names: Map<string, string>;
  progress: string;
  pending: boolean;
  onVote: (target: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div data-testid="vote" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Who&apos;s hiding something?</h2>
        <span className="text-sm text-muted">{progress}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {candidates.map((id) => (
          <li key={id}>
            <button
              type="button"
              aria-pressed={picked === id}
              onClick={() => setPicked(id)}
              className={`flex h-14 w-full items-center gap-3 rounded-2xl border px-3 text-left transition ${
                picked === id ? "border-accent bg-surface-2" : "border-border bg-surface"
              }`}
            >
              <Avatar id={id} name={names.get(id) ?? "?"} size={36} />
              <span className="flex-1 font-medium">{names.get(id)}</span>
            </button>
          </li>
        ))}
      </ul>
      <Button className="h-14 text-lg" disabled={!picked || pending} onClick={() => picked && onVote(picked)}>
        {picked ? `Vote for ${names.get(picked)}` : "Pick a player"}
      </Button>
    </div>
  );
}

function GuessBox({ pending, onGuess }: { pending: boolean; onGuess: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      data-testid="guess"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onGuess(text);
      }}
    >
      <h2 className="text-2xl font-semibold">You were caught, Mr. White</h2>
      <p className="text-muted">One guess at the civilians&apos; word. Guess right and you win.</p>
      <input
        aria-label="Your guess"
        value={text}
        maxLength={40}
        onChange={(e) => setText(e.target.value)}
        className="h-12 rounded-xl border border-border bg-background px-3 text-lg outline-none focus:border-accent"
        autoComplete="off"
      />
      <Button type="submit" className="h-14 text-lg" disabled={pending || !text.trim()}>Guess</Button>
    </form>
  );
}

function Status({ title, children, tone }: { title: string; children?: ReactNode; tone?: "danger" }) {
  return (
    <div data-testid="status" className="flex flex-col gap-1 rounded-2xl border border-border bg-surface px-5 py-6 text-center">
      <p className={`text-2xl font-semibold ${tone === "danger" ? "text-danger" : ""}`}>{title}</p>
      {children ? <p className="text-muted">{children}</p> : null}
    </div>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-xl border border-accent/50 px-3 py-2 text-center text-accent">{children}</p>;
}
