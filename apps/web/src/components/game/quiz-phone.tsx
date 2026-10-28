"use client";

import type { QuizAnswer, QuizQuestion, QuizScore } from "@gamenight/db-types";
import { motion, MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState, useTransition } from "react";

import { HostDrawer } from "@/components/game/host-drawer";
import { Banner, HowTo, PhaseTitle, PhoneHeading, Status, Timer } from "@/components/game/parts";
import {
  AnswerTiles,
  Clues,
  Leaderboard,
  OrderList,
  OrderPicker,
  Podium,
  QuizPicture,
  usePlacesWhenAsked,
} from "@/components/game/quiz-parts";
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
  kindOf,
  nextIsNewRound,
  nextRound,
  pickText,
  placeOf,
  ROUND_HOW,
  ROUND_LABEL,
  roundLabel,
  showingFinalReveal,
  slotOf,
  totalQuestions,
} from "@/lib/quiz";
import { type LiveRoom, usePrivateGame } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";
import { topicClass } from "@/lib/topics";

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

  function answer(value: { option: number } | { value: boolean | number } | { order: number[] }) {
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
  const roundName = question ? slotOf(game, question.number).name : null;
  const ended = game.phase === "ended" && !showingFinalReveal(game, question, now);
  const intro = !question || (game.phase === "reveal" && !game.phase_deadline && nextIsNewRound(game, asked));
  // The screen's key is what it shows, so the game ending under the last reveal doesn't replay it.
  const view = ended ? "ended" : intro ? "intro" : open ? "open" : question?.revealed_at ? "reveal" : "waiting";
  const heading = ended ? "Final scores"
    : question ? `Question ${question.number} of ${totalQuestions(game)}` : "Quiz Night";

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="quiz-phone" data-phase={game.phase} data-number={question?.number ?? 0}
            className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-5 py-6 pb-28">
        <PhoneHeading
          label={question && !ended ? roundLabel(game, question.number) : "Quiz Night"}
          title={heading}
          timer={open && left !== null && !game.paused_at ? <Timer seconds={left} total={total} /> : null}
        />

        <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} />

        {game.paused_at ? <Banner>Paused by the host</Banner> : null}

        <PhaseTitle id={`${view}-${question?.number ?? 0}`}
                    className="flex flex-col gap-4">
          {ended ? (
            <FinalScores scores={scores} names={names} meId={meId}>
              <Button onClick={onBackToLobby}>{isHost ? "Play again" : "Back to the lobby"}</Button>
            </FinalScores>
          ) : intro ? (
            <RoundIntro {...nextRound(game, asked)} />
          ) : open ? (
            <QuestionView question={question} names={names} mine={mine} pending={pending} onAnswer={answer} now={now}
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
          <HowTo>
            <p>{roundName ? ROUND_HOW[roundName] : HOW_TO_PLAY.question}</p>
            <p>{HOW_TO_PLAY.reveal}</p>
          </HowTo>
        ) : null}

        {!live.connected ? <p role="status" className="caps text-xs text-muted">Reconnecting…</p> : null}
      </main>
      {isHost && game.phase !== "ended" ? <HostDrawer game={game} roomId={live.room.id} voice={live.room.voice} /> : null}
    </MotionConfig>
  );
}

function RoundIntro({ round, name }: ReturnType<typeof nextRound>) {
  return (
    <div data-testid="round-intro" className="flex flex-col gap-3 bg-ink px-5 py-6 text-background">
      <p className="caps text-xs opacity-60">Get ready</p>
      <motion.p initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.22 }}
                className="flex items-baseline gap-3 text-3xl">
        Round <span className="numeral text-8xl">{round}</span>
      </motion.p>
      {name ? <p className="caps text-sm">{ROUND_LABEL[name]}</p> : null}
      {name ? <p className="opacity-70">{ROUND_HOW[name]}</p> : null}
    </div>
  );
}

function QuestionView({ question, names, mine, pending, onAnswer, joker, jokerOn, now }: {
  question: QuizQuestion;
  names: Map<string, string>;
  mine: QuizAnswer | undefined;
  pending: boolean;
  onAnswer: (value: { option: number } | { value: boolean | number } | { order: number[] }) => void;
  now: number;
  joker?: () => void;
  jokerOn: boolean;
}) {
  const kind = kindOf(question);
  const forName = question.for_member ? names.get(question.for_member) : null;
  return (
    <div data-testid="question" className="flex flex-col gap-4">
      {forName ? (
        <p className="caps self-start border border-ink px-2 py-1 text-[11px]">
          For {forName} · <span className={topicClass(question.topic)}>{question.topic}</span>
        </p>
      ) : null}
      <h2 className="text-2xl leading-snug">{question.prompt}</h2>
      {question.image_path ? <QuizPicture question={question} /> : null}
      {kind === "connect" ? <Clues question={question} now={now} /> : null}
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
          {jokerOn ? <p className="caps bg-accent px-3 py-2 text-xs text-accent-ink">Joker on: this one counts double</p> : null}
          {kind === "estimate"
            ? <EstimateBox unit={question.unit} pending={pending} onAnswer={(value) => onAnswer({ value })} />
            : kind === "order"
              ? <OrderPicker question={question} pending={pending} onAnswer={(order) => onAnswer({ order })} />
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
               className="numeral h-16 min-w-0 flex-1 border border-ink bg-surface px-3 text-4xl outline-none" />
        {unit ? <span className="caps text-sm text-muted">{unit}</span> : null}
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
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
                  data-testid="my-result" data-correct={mine?.correct ?? undefined}
                  className={`flex flex-col gap-2 px-5 py-6 ${mine?.correct ? "bg-ok text-background" : "border border-ink"}`}>
        <p className="text-5xl tracking-tight">{title}</p>
        {scored && mine.points ? (
          <p className="caps text-sm">+{formatNumber(mine.points)} points{mine.joker ? " · joker doubled" : ""}</p>
        ) : null}
      </motion.div>
      <p className="text-lg">
        <span className="caps text-xs text-muted">The answer: </span>
        <span data-testid="the-answer">{answerText(question)}</span>
      </p>
      {kindOf(question) === "order" ? <OrderList question={question} />
        : kindOf(question) !== "estimate" ? <AnswerTiles question={question} picked={pickedOf(mine)} /> : null}
      {question.hook ? <p data-testid="quiz-hook" className="border-l-2 border-accent pl-3 text-muted">{question.hook}</p> : null}
      {place ? (
        <p className="text-muted">
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
    <div data-testid="final-scores" className="flex flex-col gap-6">
      <Podium scores={scores} names={names} />
      {place && mine ? (
        <p className="text-xl">You finished {ordinal(place)} with {formatNumber(mine.points)} points.</p>
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
