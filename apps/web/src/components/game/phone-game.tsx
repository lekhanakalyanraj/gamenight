"use client";

import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useEffect, useState, useTransition } from "react";

import { HostDrawer } from "@/components/game/host-drawer";
import { Avatar, Banner, Elimination, HoldCard, HowTo, PhaseTitle, PhoneHeading, Status, Timer } from "@/components/game/parts";
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
      <main data-testid="phone-game" data-phase={game.phase} className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 py-6 pb-28">
        <PhoneHeading
          label={game.phase === "ended" ? "Undercover" : `Undercover · round ${Math.max(game.round, 1)}`}
          title={PHASE_LABEL[game.phase]}
          timer={left !== null && !game.paused_at ? <Timer seconds={left} total={total} /> : null}
        />

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
          <HowTo><p>{HOW_TO_PLAY[game.phase]}</p></HowTo>
        ) : null}

        {!live.connected ? <p role="status" className="caps text-xs text-muted">Reconnecting…</p> : null}
      </main>
      {isHost && game.phase !== "ended" ? <HostDrawer game={game} roomId={live.room.id} voice={live.room.voice} pets={live.room.pets} /> : null}
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
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
              className="flex flex-col gap-6 bg-accent px-5 py-6 text-accent-ink"
            >
              <p className="caps text-xs">Your turn</p>
              <div>
                <p className="text-5xl tracking-tight">You&apos;re up</p>
                <p className="mt-2">Say your clue out loud</p>
              </div>
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
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
              className={`text-6xl tracking-tight ${judgement.verdict ? "text-ok" : "text-danger"}`}
            >
              {judgement.verdict ? "Right!" : "Wrong!"}
            </motion.p>
            <p className="text-muted">
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
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xl">Who&apos;s hiding something?</h2>
        <span className="caps text-xs text-muted">{progress}</span>
      </div>
      <ul className="flex flex-col border-t border-ink">
        {candidates.map((id) => (
          <li key={id}>
            <button
              type="button"
              aria-pressed={picked === id}
              onClick={() => setPicked(id)}
              className={`flex h-16 w-full items-center gap-4 border-b border-ink px-3 text-left transition ${
                picked === id ? "bg-ink text-background" : "hover:bg-surface-2"
              }`}
            >
              <Avatar id={id} name={names.get(id) ?? "?"} size={36} />
              <span className="flex-1 text-lg">{names.get(id)}</span>
              <span aria-hidden className={`size-4 border ${picked === id ? "border-background bg-background" : "border-ink"}`} />
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
      <h2 className="text-3xl tracking-tight">You were caught, Mr. White</h2>
      <p className="text-muted">One guess at the civilians&apos; word. Guess right and you win.</p>
      <input
        aria-label="Your guess"
        value={text}
        maxLength={40}
        onChange={(e) => setText(e.target.value)}
        className="h-14 border border-ink bg-surface px-3 text-xl outline-none"
        autoComplete="off"
      />
      <Button type="submit" className="h-14 text-lg" disabled={pending || !text.trim()}>Guess</Button>
    </form>
  );
}
