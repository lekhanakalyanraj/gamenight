"use client";

import type { QuizAnswer, QuizQuestion, QuizScore } from "@gamenight/db-types";
import { motion, MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState, useTransition } from "react";

import { HostDrawer } from "@/components/game/host-drawer";
import { PhaseTitle, TimerRing } from "@/components/game/parts";
import { AnswerTiles, Leaderboard, Podium, QuizPicture, usePlacesWhenAsked } from "@/components/game/quiz-parts";
import { HostCaption } from "@/components/lobby";
import { Button, Notice } from "@/components/ui";
import { answerQuestion, playJoker } from "@/app/play/[code]/game-actions";
import { useCountdown, useNow } from "@/lib/clock";
import { HOW_TO_PLAY, type LiveGame } from "@/lib/game";
import { newId } from "@/lib/ids";
import {
  answerText,
  currentQuestion,
  formatNumber,
  isOpen,
  type Key,
  KIND_HOW,
  KIND_LABEL,
  kindOf,
  nextIsNewRound,
  nextRound,
  pickText,
  placeOf,
  showingFinalReveal,
  totalQuestions,
} from "@/lib/quiz";
import { type LiveRoom, usePrivateGame } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";

/** A phone during Quiz Night: the question, your answer, your result, and where you stand. */
export default function PhoneQuiz({ live, meId, isHost, onBackToLobby }: {
  live: LiveRoom & { game: LiveGame };
  meId: string;
  isHost: boolean;
  onBackToLobby: () => void;
}) {
  const { game, questions, scores } = live.game;
  const { answers, refetch, addAnswer } = usePrivateGame(meId, game.id);
  const now = useNow();
  const names = new Map(live.members.map((m) => [m.id, m.nickname]));
  const question = currentQuestion(questions);
  const mine = question ? answers.find((a) => a.number === question.number) : undefined;
  const myScore = scores.find((s) => s.member_id === meId);
  const before = usePlacesWhenAsked(question, scores);
  const { left, total } = useCountdown(game.phase_deadline, now);
  const open = isOpen(game, question);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  // Your scored answer arrives on your private topic at the reveal; if that broadcast was missed, read it.
  const revealedAt = question?.revealed_at ?? null;
  const unscored = Boolean(mine && mine.correct === null);
  useEffect(() => {
    if (revealedAt && unscored) void refetch();
  }, [revealedAt, unscored, refetch]);

  function answer(value: { option: number } | { value: boolean | number }) {
    setError(undefined);
    const id = newId(); // made here, so a retried tap is the same answer
    startTransition(async () => {
      const result = await answerQuestion(game.id, value, id);
      if (result.error) setError(result.error);
      else if (result.answer) addAnswer(result.answer);
    });
  }

  function joker() {
    setError(undefined);
    startTransition(async () => setError((await playJoker(game.id)).error));
  }

  const asked = questions.length;
  const ended = game.phase === "ended" && !showingFinalReveal(game, question, now);
  const heading = ended ? "Final scores"
    : question ? `Question ${question.number} of ${totalQuestions(game)}` : "Quiz Night";

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="quiz-phone" data-phase={game.phase} data-number={question?.number ?? 0}
            className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-5 py-6 pb-28">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted">
              {question && !ended ? `Round ${question.round} · ${KIND_LABEL[kindOf(question)]}` : "Quiz Night"}
            </p>
            <h1 className="text-2xl font-semibold">{heading}</h1>
          </div>
          {open && left !== null && !game.paused_at ? <TimerRing seconds={left} total={total} /> : null}
        </header>

        <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} />

        {game.paused_at ? <Banner>Paused by the host</Banner> : null}

        <PhaseTitle id={`${ended ? "ended" : "playing"}-${question?.number ?? 0}-${Boolean(question?.revealed_at)}-${game.phase_deadline === null}`}
                    className="flex flex-col gap-4">
          {ended ? (
            <FinalScores scores={scores} names={names} meId={meId}>
              <Button onClick={onBackToLobby}>{isHost ? "Play again" : "Back to the lobby"}</Button>
            </FinalScores>
          ) : !question || (game.phase === "reveal" && !game.phase_deadline && nextIsNewRound(game, asked)) ? (
            <RoundIntro {...nextRound(game, asked)} />
          ) : open ? (
            <QuestionView question={question} names={names} mine={mine} pending={pending} onAnswer={answer}
                          joker={myScore && myScore.jokers > 0 && myScore.joker_on !== question.number && !mine ? joker : undefined}
                          jokerOn={myScore?.joker_on === question.number} />
          ) : !question.revealed_at ? (
            <Status title={mine ? "Answer in" : "Time's up"}>
              {mine ? `You said ${pickText(question, mine.answer as Key)}. The answer's coming…` : "The answer's coming…"}
            </Status>
          ) : (
            <RevealView question={question} mine={mine} scores={scores} names={names} meId={meId} before={before} />
          )}
        </PhaseTitle>

        <Notice>{error}</Notice>

        {game.phase !== "ended" ? (
          <details className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">How to play</summary>
            <p className="mt-2 text-muted">{question ? KIND_HOW[kindOf(question)] : HOW_TO_PLAY.question}</p>
            <p className="mt-2 text-muted">{HOW_TO_PLAY.reveal}</p>
          </details>
        ) : null}

        {!live.connected ? <p role="status" className="text-center text-sm text-muted">Reconnecting…</p> : null}
      </main>
      {isHost && game.phase !== "ended" ? <HostDrawer game={game} roomId={live.room.id} voice={live.room.voice} /> : null}
    </MotionConfig>
  );
}

function RoundIntro({ round, kind }: { round: number; kind: ReturnType<typeof nextRound>["kind"] }) {
  return (
    <div data-testid="round-intro" className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-surface px-5 py-6 text-center">
      <p className="text-sm text-muted">Get ready</p>
      <motion.p initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-3xl font-semibold">
        Round {round}
      </motion.p>
      {kind ? <p className="text-lg">{KIND_LABEL[kind]}</p> : null}
      {kind ? <p className="text-muted">{KIND_HOW[kind]}</p> : null}
    </div>
  );
}

function QuestionView({ question, names, mine, pending, onAnswer, joker, jokerOn }: {
  question: QuizQuestion;
  names: Map<string, string>;
  mine: QuizAnswer | undefined;
  pending: boolean;
  onAnswer: (value: { option: number } | { value: boolean | number }) => void;
  joker?: () => void;
  jokerOn: boolean;
}) {
  const kind = kindOf(question);
  const forName = question.for_member ? names.get(question.for_member) : null;
  return (
    <div data-testid="question" className="flex flex-col gap-4">
      {forName ? (
        <p className="self-start rounded-full bg-surface-2 px-3 py-1 text-sm">For {forName}: {question.topic}</p>
      ) : null}
      <h2 className="text-xl font-semibold">{question.prompt}</h2>
      {question.image_path ? <QuizPicture question={question} /> : null}
      {mine ? (
        <Status title="Answer in">
          You said {pickText(question, mine.answer as Key)}{mine.joker ? ", with your joker" : ""}. Waiting for the others.
        </Status>
      ) : (
        <>
          {joker ? (
            <Button variant="secondary" data-testid="joker" disabled={pending} onClick={joker}>
              Play your double-points joker on this one
            </Button>
          ) : null}
          {jokerOn ? <p className="text-center text-sm text-accent">Joker on: this one counts double.</p> : null}
          {kind === "estimate"
            ? <EstimateBox unit={question.unit} pending={pending} onAnswer={(value) => onAnswer({ value })} />
            : <AnswerTiles question={question} disabled={pending} onPick={onAnswer} />}
        </>
      )}
    </div>
  );
}

function EstimateBox({ unit, pending, onAnswer }: { unit: string | null; pending: boolean; onAnswer: (value: number) => void }) {
  const [text, setText] = useState("");
  const value = Number(text.replace(/,/g, ""));
  const valid = text.trim() !== "" && Number.isFinite(value);
  return (
    <form data-testid="estimate" className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onAnswer(value);
          }}>
      <label className="flex items-center gap-3">
        <input aria-label="Your estimate" inputMode="decimal" value={text} maxLength={15} autoComplete="off"
               onChange={(e) => setText(e.target.value.replace(/[^\d.,-]/g, ""))}
               className="h-14 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-2xl outline-none focus:border-accent" />
        {unit ? <span className="text-lg text-muted">{unit}</span> : null}
      </label>
      <Button type="submit" className="h-14 text-lg" disabled={pending || !valid}>Lock it in</Button>
    </form>
  );
}

function RevealView({ question, mine, scores, names, meId, before }: {
  question: QuizQuestion;
  mine: QuizAnswer | undefined;
  scores: QuizScore[];
  names: Map<string, string>;
  meId: string;
  before?: Map<string, number>;
}) {
  const place = placeOf(scores, meId);
  const was = before?.get(meId);
  const moved = place && was ? was - place : 0;
  const estimate = kindOf(question) === "estimate";
  const scored = mine && mine.points !== null;
  const title = !mine ? "No answer this time"
    : !scored ? "Scoring…"
    : estimate ? (mine.correct ? "Closest!" : `+${formatNumber(mine.points ?? 0)}`)
    : mine.correct ? "Right!" : "Not this time";
  return (
    <div data-testid="reveal" className="flex flex-col gap-4">
      <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 16 }}
                  data-testid="my-result" data-correct={mine?.correct ?? undefined}
                  className={`rounded-3xl px-5 py-6 text-center ${mine?.correct ? "bg-accent text-accent-ink" : "border border-border bg-surface"}`}>
        <p className="text-4xl font-semibold">{title}</p>
        {scored && mine.points ? (
          <p className="mt-1 text-lg">+{formatNumber(mine.points)} points{mine.joker ? " (joker: doubled)" : ""}</p>
        ) : null}
      </motion.div>
      <p className="text-center text-lg">
        The answer: <span data-testid="the-answer" className="font-semibold">{answerText(question)}</span>
      </p>
      {kindOf(question) !== "estimate" ? <AnswerTiles question={question} picked={pickedOf(mine)} /> : null}
      {place ? (
        <p className="text-center text-muted">
          You&apos;re {ordinal(place)}{moved > 0 ? `, up ${moved}` : moved < 0 ? `, down ${-moved}` : ""}.
        </p>
      ) : null}
      <Leaderboard scores={scores} names={names} before={before} meId={meId} limit={5} />
    </div>
  );
}

function FinalScores({ scores, names, meId, children }: {
  scores: QuizScore[];
  names: Map<string, string>;
  meId: string;
  children: ReactNode;
}) {
  const place = placeOf(scores, meId);
  const mine = scores.find((s) => s.member_id === meId);
  return (
    <div data-testid="final-scores" className="flex flex-col gap-5">
      <Podium scores={scores} names={names} />
      {place && mine ? (
        <p className="text-center text-lg">You finished {ordinal(place)} with {formatNumber(mine.points)} points.</p>
      ) : null}
      <Leaderboard scores={scores} names={names} meId={meId} />
      {children}
    </div>
  );
}

function pickedOf(mine: QuizAnswer | undefined): number | boolean | null {
  const a = mine?.answer as Key | undefined;
  return a?.option ?? (typeof a?.value === "boolean" ? a.value : null);
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function Status({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-testid="status" className="flex flex-col gap-1 rounded-2xl border border-border bg-surface px-5 py-6 text-center">
      <p className="text-2xl font-semibold">{title}</p>
      {children ? <p className="text-muted">{children}</p> : null}
    </div>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-xl border border-accent/50 px-3 py-2 text-center text-accent">{children}</p>;
}
