"use client";

import type { QuizAnswer, QuizQuestion } from "@gamenight/db-types";
import { motion, MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

import { Avatar, PhaseTitle, StageHeading, Timer, TvFrame } from "@/components/game/parts";
import { AnswerTiles, Clues, Leaderboard, OrderList, Podium, QuizPicture, usePlacesWhenAsked } from "@/components/game/quiz-parts";
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
  kindOf,
  nextIsNewRound,
  nextRound,
  ROUND_HOW,
  ROUND_LABEL,
  roundLabel,
  showingFinalReveal,
  sourceLabel,
  standings,
  totalQuestions,
} from "@/lib/quiz";
import type { LiveRoom } from "@/lib/realtime";
import { latestHostLine } from "@/lib/room";
import { topicClass } from "@/lib/topics";
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
  const intro = !question || (game.phase === "reveal" && !game.phase_deadline && nextIsNewRound(game, asked));
  // The stage's key is what it shows, so the game ending under the last reveal doesn't replay it.
  const view = ended ? "ended" : intro ? "intro" : question?.revealed_at ? "reveal" : "question";

  return (
    <MotionConfig reducedMotion="user">
      <TvFrame
        data-testid="quiz-tv"
        data-phase={game.phase}
        data-number={question?.number ?? 0}
        data-kind={question ? kindOf(question) : ""}
        label={question && !ended ? `Quiz Night · ${roundLabel(game, question.number)}` : "Quiz Night"}
        asideLabel="Standings"
        caption={<HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />}
        aside={
          <>
            <Leaderboard scores={scores} names={names} before={question?.revealed_at ? before : undefined} big />
            {!live.connected ? <p role="status" className="caps mt-auto text-lg text-muted">Reconnecting…</p> : null}
          </>
        }
      >
        <StageHeading
          label={ended ? "Game over" : question ? "Question" : "Up next"}
          title={ended ? "Final scores" : question
            ? <><span className="numeral text-[9rem]">{String(question.number).padStart(2, "0")}</span><span className="text-muted"> / {totalQuestions(game)}</span></>
            : "Quiz Night"}
          swap={`${ended}-${question?.number ?? 0}`}
          timer={open && left !== null && !game.paused_at ? <Timer seconds={left} total={total} size={120} /> : null}
        />

        <div className="flex flex-1 flex-col justify-center">
          {game.paused_at ? (
            <Big title="Paused by the host">The quiz will pick up where it left off.</Big>
          ) : (
            <PhaseTitle id={`${view}-${question?.number ?? 0}`}
                        className="flex w-full flex-col">
              {ended ? (
                <FinalScores gameId={game.id} live={live.game} names={names} />
              ) : intro ? (
                <RoundIntro {...nextRound(game, asked)} />
              ) : !question.revealed_at ? (
                <QuestionStage question={question} names={names} open={open} answered={game.moves_in} playing={playing}
                               now={now} />
              ) : (
                <RevealStage question={question} names={names} />
              )}
            </PhaseTitle>
          )}
        </div>
      </TvFrame>
    </MotionConfig>
  );
}

function RoundIntro({ round, name }: ReturnType<typeof nextRound>) {
  return (
    <div data-testid="round-intro" className="flex flex-col gap-6">
      <motion.p initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }} className="flex items-baseline gap-8 text-7xl">
        Round <span className="numeral text-[16rem]">{round}</span>
      </motion.p>
      {name ? <p className="caps border-t border-border pt-6 text-3xl">{ROUND_LABEL[name]}</p> : null}
      {name ? <p className="max-w-3xl text-3xl text-muted">{ROUND_HOW[name]}</p> : null}
    </div>
  );
}

function ForWhom({ question, names }: { question: QuizQuestion; names: Map<string, string> }) {
  const name = question.for_member ? names.get(question.for_member) : null;
  if (!name || !question.for_member) return null;
  return (
    <p className="flex items-center gap-4 self-start text-2xl">
      <Avatar id={question.for_member} name={name} size={44} live />
      <span>This one&apos;s for {name} <span className="caps text-lg">· <span className={topicClass(question.topic)}>{question.topic}</span></span></span>
    </p>
  );
}

function QuestionStage({ question, names, open, answered, playing, now }: {
  question: QuizQuestion;
  names: Map<string, string>;
  open: boolean;
  answered: number;
  playing: number;
  now: number;
}) {
  const kind = kindOf(question);
  return (
    <div data-testid="tv-question" className="flex flex-col gap-6">
      <ForWhom question={question} names={names} />
      <h2 className={`${kind === "lightning" ? "text-7xl" : "text-6xl"} leading-[1.1] tracking-tight`}>{question.prompt}</h2>
      {question.image_path ? <QuizPicture question={question} big /> : null}
      {kind === "connect" ? <Clues question={question} now={now} big /> : null}
      {kind === "estimate" ? (
        <p className="text-4xl text-muted">Type your best guess{question.unit ? ` (${question.unit})` : ""} on your phone.</p>
      ) : kind === "order" ? (
        <OrderList question={question} big />
      ) : (
        <AnswerTiles question={question} big />
      )}
      {open ? (
        <div data-testid="answered" className="caps flex items-center gap-5 text-2xl text-muted">
          <span>{answered} of {playing} answered</span>
          <span className="flex gap-2">
            {Array.from({ length: playing }, (_, i) => (
              <span key={i} className={`size-5 border border-ink transition-colors ${i < answered ? "bg-ink" : ""}`} />
            ))}
          </span>
        </div>
      ) : (
        <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}
                  className="caps text-4xl text-accent">
          {answered >= playing ? "Everyone's in" : "Time's up"}
        </motion.p>
      )}
    </div>
  );
}

function RevealStage({ question, names }: { question: QuizQuestion; names: Map<string, string> }) {
  const results = question.results as ({ answered: number; right?: number } & Partial<EstimateResults>) | null;
  const kind = kindOf(question);
  const source = sourceLabel(question);
  return (
    <div data-testid="tv-reveal" className="flex flex-col gap-6">
      <h2 className="text-4xl leading-tight text-muted">{question.prompt}</h2>
      {kind === "connect" ? <Clues question={question} now={0} big /> : null}
      {kind === "estimate" ? (
        <div className="flex flex-col gap-6">
          <motion.p data-testid="quiz-answer" data-answer={answerText(question) ?? ""}
                    initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }} className="numeral text-[12rem] text-ok">
            {answerText(question)}
          </motion.p>
          {results?.closest?.length ? (
            <p className="border-t border-border pt-6 text-4xl">
              <span className="caps text-2xl text-muted">Closest · </span>{results.closest.map((c) => `${names.get(c.member_id) ?? "?"} (${formatValue(Number(c.value), question.unit)})`).join(", ")}
            </p>
          ) : <p className="text-4xl text-muted">Nobody guessed.</p>}
        </div>
      ) : kind === "order" ? (
        <>
          <span data-testid="quiz-answer" data-answer={answerText(question) ?? ""} className="sr-only">{answerText(question)}</span>
          <OrderList question={question} big />
          {results ? (
            <p className="caps text-2xl text-muted">{results.right ?? 0} of {results.answered} got the whole order</p>
          ) : null}
        </>
      ) : (
        <>
          <p className="flex items-baseline gap-6 text-7xl tracking-tight">
            <span className="caps text-2xl text-muted">Answer</span>
            <span data-testid="quiz-answer" data-answer={answerText(question) ?? ""} className="text-ok">{answerText(question)}</span>
          </p>
          <AnswerTiles question={question} big />
          {results ? (
            <p className="caps text-2xl text-muted">{results.right ?? 0} of {results.answered} got it right</p>
          ) : null}
        </>
      )}
      {question.hook ? (
        <motion.p data-testid="quiz-hook" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6, duration: 0.3 }}
                  className="max-w-5xl border-l-2 border-accent pl-6 text-3xl leading-snug">{question.hook}</motion.p>
      ) : null}
      {source ? <p className="caps text-lg text-muted">{source}</p> : null}
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
      <ul className="grid grid-cols-2 gap-x-12 border-t border-border text-2xl">
        {ranked.map((s) => (
          <li key={s.member_id} data-testid="final-player" className="flex items-baseline gap-4 border-b border-border py-3">
            <span className="w-8 font-mono text-muted">{s.place}</span>
            <span className="flex-1 truncate">{names.get(s.member_id) ?? "?"}</span>
            <span className="font-mono">{formatNumber(s.points)}</span>
            <span className="caps w-48 text-right text-base text-muted">
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
    <div data-testid="tv-status" className="flex flex-col gap-5">
      <p className="text-7xl leading-[1.05] tracking-tight">{title}</p>
      {children ? <p className="max-w-4xl text-3xl text-muted">{children}</p> : null}
    </div>
  );
}
