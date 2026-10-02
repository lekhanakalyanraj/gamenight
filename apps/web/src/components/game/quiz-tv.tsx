"use client";

import type { QuizAnswer, QuizQuestion } from "@gamenight/db-types";
import { motion, MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

import { Avatar, PhaseTitle, TimerRing } from "@/components/game/parts";
import { AnswerTiles, Leaderboard, Podium, QuizPicture, usePlacesWhenAsked } from "@/components/game/quiz-parts";
import { HostCaption } from "@/components/lobby";
import { useCountdown, useNow } from "@/lib/clock";
import type { LiveGame } from "@/lib/game";
import {
  answerText,
  bestStreaks,
  currentQuestion,
  type EstimateResults,
  formatNumber,
  formatValue,
  isOpen,
  KIND_HOW,
  KIND_LABEL,
  kindOf,
  nextIsNewRound,
  nextRound,
  showingFinalReveal,
  sourceTitle,
  standings,
  totalQuestions,
} from "@/lib/quiz";
import type { LiveRoom } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";
import { useSupabase } from "@/lib/supabase/client";

/**
 * The TV during Quiz Night. It reads only public rows: a question's answer and how the room answered arrive with
 * its reveal, so the TV can't show an answer early, even by mistake.
 */
export default function TvQuiz({ live }: { live: LiveRoom & { game: LiveGame } }) {
  const { game, questions, scores, players } = live.game;
  const now = useNow();
  const names = new Map(live.members.map((m) => [m.id, m.nickname]));
  const question = currentQuestion(questions);
  const before = usePlacesWhenAsked(question, scores);
  const { left, total } = useCountdown(game.phase_deadline, now);
  const open = isOpen(game, question);
  const asked = questions.length;
  const inRoom = new Set(live.members.filter((m) => !m.left_at).map((m) => m.id));
  const playing = players.filter((p) => inRoom.has(p.member_id)).length;
  const lastReveal = showingFinalReveal(game, question, now);
  const ended = game.phase === "ended" && !lastReveal;

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="quiz-tv" data-phase={game.phase} data-number={question?.number ?? 0}
            className="grid min-h-dvh grid-cols-[minmax(0,3fr)_minmax(0,1fr)] gap-8 p-10">
        <section className="flex min-w-0 flex-col gap-6">
          <header className="flex items-center justify-between gap-6">
            <div>
              <p className="text-2xl text-muted">
                {question && !ended ? `Round ${question.round} · ${KIND_LABEL[kindOf(question)]}` : "Quiz Night"}
              </p>
              <h1 className="text-6xl font-semibold">
                {ended ? "Final scores" : question ? `Question ${question.number} of ${totalQuestions(game)}` : "Quiz Night"}
              </h1>
            </div>
            {open && left !== null && !game.paused_at ? <TimerRing seconds={left} total={total} size={120} /> : null}
          </header>

          <div className="flex flex-1 flex-col justify-center">
            {game.paused_at ? (
              <Big title="Paused by the host">The quiz will pick up where it left off.</Big>
            ) : (
              <PhaseTitle id={`${ended ? "ended" : "playing"}-${question?.number ?? 0}-${Boolean(question?.revealed_at)}-${game.phase_deadline === null}`}
                          className="flex w-full flex-col">
                {ended ? (
                  <FinalScores gameId={game.id} live={live.game} names={names} />
                ) : !question || (game.phase === "reveal" && !game.phase_deadline && nextIsNewRound(game, asked)) ? (
                  <RoundIntro {...nextRound(game, asked)} />
                ) : !question.revealed_at ? (
                  <QuestionStage question={question} names={names} open={open} answered={game.moves_in} playing={playing} />
                ) : (
                  <RevealStage question={question} names={names} />
                )}
              </PhaseTitle>
            )}
          </div>

          <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />
        </section>

        <aside className="flex flex-col gap-3">
          <h2 className="text-2xl text-muted">Leaderboard</h2>
          <Leaderboard scores={scores} names={names} before={question?.revealed_at ? before : undefined} big />
          {!live.connected ? <p role="status" className="mt-auto text-xl text-muted">Reconnecting…</p> : null}
        </aside>
      </main>
    </MotionConfig>
  );
}

function RoundIntro({ round, kind }: ReturnType<typeof nextRound>) {
  return (
    <div data-testid="round-intro" className="flex flex-col items-center gap-5 text-center">
      <motion.p initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 220, damping: 16 }} className="text-9xl font-semibold">
        Round {round}
      </motion.p>
      {kind ? <p className="text-5xl text-accent">{KIND_LABEL[kind]}</p> : null}
      {kind ? <p className="max-w-3xl text-3xl text-muted">{KIND_HOW[kind]}</p> : null}
    </div>
  );
}

function ForWhom({ question, names }: { question: QuizQuestion; names: Map<string, string> }) {
  const name = question.for_member ? names.get(question.for_member) : null;
  if (!name || !question.for_member) return null;
  return (
    <p className="flex items-center gap-3 self-start rounded-full bg-surface-2 py-2 pr-5 pl-2 text-2xl">
      <Avatar id={question.for_member} name={name} size={40} />
      This one&apos;s for {name}: {question.topic}
    </p>
  );
}

function QuestionStage({ question, names, open, answered, playing }: {
  question: QuizQuestion;
  names: Map<string, string>;
  open: boolean;
  answered: number;
  playing: number;
}) {
  const estimate = kindOf(question) === "estimate";
  return (
    <div data-testid="tv-question" className="flex flex-col gap-6">
      <ForWhom question={question} names={names} />
      <h2 className="text-5xl leading-tight font-semibold">{question.prompt}</h2>
      {question.image_path ? <QuizPicture question={question} big /> : null}
      {estimate ? (
        <p className="text-4xl text-muted">Type your best guess{question.unit ? ` (${question.unit})` : ""} on your phone.</p>
      ) : (
        <AnswerTiles question={question} big />
      )}
      {open ? (
        <div data-testid="answered" className="flex items-center gap-4 text-3xl">
          <span>{answered} of {playing} answered</span>
          <span className="flex gap-2">
            {Array.from({ length: playing }, (_, i) => (
              <motion.span key={i} animate={{ scale: i < answered ? 1 : 0.6, opacity: i < answered ? 1 : 0.3 }}
                           className="size-5 rounded-full bg-accent" />
            ))}
          </span>
        </div>
      ) : (
        <motion.p initial={{ scale: 1.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-6xl font-semibold text-accent">
          {answered >= playing ? "Everyone's in!" : "Time's up!"}
        </motion.p>
      )}
    </div>
  );
}

function RevealStage({ question, names }: { question: QuizQuestion; names: Map<string, string> }) {
  const results = question.results as ({ answered: number; right?: number } & Partial<EstimateResults>) | null;
  const estimate = kindOf(question) === "estimate";
  const source = sourceTitle(question.source_url);
  return (
    <div data-testid="tv-reveal" className="flex flex-col gap-6">
      <h2 className="text-4xl leading-tight text-muted">{question.prompt}</h2>
      {estimate ? (
        <div className="flex flex-col items-center gap-4">
          <motion.p data-testid="quiz-answer" data-answer={answerText(question) ?? ""}
                    initial={{ scale: 2.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 240, damping: 14 }} className="text-9xl font-semibold text-accent">
            {answerText(question)}
          </motion.p>
          {results?.closest?.length ? (
            <p className="text-4xl">
              Closest: {results.closest.map((c) => `${names.get(c.member_id) ?? "?"} (${formatValue(Number(c.value), question.unit)})`).join(", ")}
            </p>
          ) : <p className="text-4xl text-muted">Nobody guessed.</p>}
        </div>
      ) : (
        <>
          <p className="text-5xl font-semibold">
            <span data-testid="quiz-answer" data-answer={answerText(question) ?? ""} className="text-accent">{answerText(question)}</span>
          </p>
          <AnswerTiles question={question} big />
          {results ? (
            <p className="text-3xl text-muted">{results.right ?? 0} of {results.answered} got it right</p>
          ) : null}
        </>
      )}
      {source ? <p className="text-xl text-muted">Source: Wikipedia, {source}</p> : null}
    </div>
  );
}

/** The podium, everyone's total, and their best run of right answers (all answers are public once revealed). */
function FinalScores({ gameId, live, names }: { gameId: string; live: LiveGame; names: Map<string, string> }) {
  const supabase = useSupabase();
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  useEffect(() => {
    void supabase.from("quiz_answers").select("*").eq("game_id", gameId).then(({ data }) => setAnswers(data ?? []));
  }, [gameId, supabase]);
  const streaks = bestStreaks(answers);
  const ranked = standings(live.scores);
  return (
    <div data-testid="final-scores" className="flex flex-col gap-10">
      <Podium scores={live.scores} names={names} big />
      <ul className="grid grid-cols-2 gap-x-10 gap-y-2 text-2xl">
        {ranked.map((s) => (
          <li key={s.member_id} data-testid="final-player" className="flex items-baseline gap-3">
            <span className="w-8 font-mono text-muted">{s.place}</span>
            <span className="flex-1 truncate">{names.get(s.member_id) ?? "?"}</span>
            <span className="font-mono">{formatNumber(s.points)}</span>
            <span className="w-40 text-right text-lg text-muted">
              {(streaks.get(s.member_id) ?? 0) > 1 ? `best run: ${streaks.get(s.member_id)} right` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Big({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-testid="tv-status" className="flex flex-col items-center gap-4 text-center">
      <p className="text-7xl font-semibold">{title}</p>
      {children ? <p className="text-3xl text-muted">{children}</p> : null}
    </div>
  );
}
