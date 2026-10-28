"use client";

import type { QuizQuestion, QuizScore } from "@gamenight/db-types";
import { LayoutGroup, motion } from "motion/react";
import { useEffect, useState } from "react";

import { Avatar } from "@/components/game/parts";
import ClickSpark from "@/components/react-bits/ClickSpark";
import CountUp from "@/components/react-bits/CountUp";
import { Button } from "@/components/ui";
import {
  type ChoiceResults,
  cluesOf,
  cluesShown,
  FAKE_REAL,
  formatNumber,
  isTwoWay,
  keyOf,
  kindOf,
  optionsOf,
  standings,
  TILES,
  TRUE_FALSE,
  type TrueFalseResults,
} from "@/lib/quiz";
import { useSupabase } from "@/lib/supabase/client";

type TileState = "open" | "picked" | "dim" | "right" | "wrong";

/**
 * The answer tiles for every kind but estimates and in order: options (choice, picture, teaser, lightning,
 * connections) or two values (true or false, fake or real). On a phone they're buttons; on the TV they show the
 * options and, after the reveal, which was right and how many picked each.
 */
export function AnswerTiles({ question, big = false, picked, disabled, onPick }: {
  question: QuizQuestion;
  big?: boolean;
  picked?: number | boolean | null;
  disabled?: boolean;
  onPick?: (answer: { option: number } | { value: boolean }) => void;
}) {
  const key = keyOf(question);
  const results = question.results as ChoiceResults | TrueFalseResults | null;
  const answered = results?.answered ?? 0;
  const kind = kindOf(question);
  const tiles = isTwoWay(kind)
    ? (kind === "fake_real" ? FAKE_REAL : TRUE_FALSE).map((t) => ({
        id: String(t.value), label: t.label, letter: t.letter,
        answer: { value: t.value } as const, isPicked: picked === t.value,
        isRight: key ? key.value === t.value : null,
        count: results ? (results as TrueFalseResults).picks?.[t.value ? "true" : "false"] ?? 0 : null,
      }))
    : optionsOf(question).map((label, i) => ({
        id: String(i), label, letter: TILES[i].letter,
        answer: { option: i } as const, isPicked: picked === i,
        isRight: key ? key.option === i : null,
        count: results ? (results as ChoiceResults).picks?.[i] ?? 0 : null,
      }));

  const two = tiles.length === 2;
  const list = (
    <ul className={`grid ${big ? "grid-cols-2 gap-x-10 border-t border-border" : two ? "grid-cols-2 gap-2" : "grid-cols-1 gap-2"}`}>
      {tiles.map((t) => {
        const state: TileState = t.isRight === true ? "right" : t.isRight === false ? (t.isPicked ? "wrong" : "dim")
          : picked !== undefined && picked !== null ? (t.isPicked ? "picked" : "dim") : "open";
        const body = (
          <>
            {results && answered > 0 && t.count !== null ? (
              <motion.span aria-hidden initial={{ scaleX: 0 }} animate={{ scaleX: t.count / answered }}
                           transition={{ duration: 0.6, delay: 0.3, ease: [0.2, 0, 0, 1] }}
                           className="pointer-events-none absolute inset-y-0 left-0 w-full origin-left bg-current opacity-10" />
            ) : null}
            <span aria-hidden className={`font-mono opacity-60 ${big ? "w-10 text-2xl" : "w-6 text-sm"}`}>{t.letter}</span>
            <span className={`flex-1 text-left ${big ? "text-5xl leading-tight" : "text-lg"} ${state === "wrong" ? "line-through" : ""}`}>{t.label}</span>
            {t.count !== null ? (
              <span className={`font-mono ${big ? "text-3xl" : "text-base"}`} data-testid="tile-count">{t.count}</span>
            ) : null}
          </>
        );
        const frame = big ? "min-h-28 border-b border-border py-5"
          : two ? "min-h-24 border border-ink px-4 py-3" : "min-h-16 border border-ink px-4 py-3";
        const tone = state === "right" ? (big ? "text-ok" : "border-ok bg-ok text-background")
          : state === "wrong" ? "text-danger"
          : state === "picked" ? (big ? "" : "bg-ink text-background")
          : state === "dim" ? "opacity-30" : "";
        const look = `relative flex w-full items-center gap-4 overflow-hidden transition ${frame} ${tone}`;
        return (
          <motion.li key={t.id} layout transition={{ duration: 0.2 }}>
            {onPick ? (
              <button type="button" data-testid="answer-tile" data-option={t.id} data-correct={t.isRight ?? undefined}
                      aria-pressed={t.isPicked} disabled={disabled} onClick={() => onPick(t.answer)} className={look}>
                {body}
              </button>
            ) : (
              <div data-testid="answer-tile" data-option={t.id} data-correct={t.isRight ?? undefined} className={look}>
                {body}
              </div>
            )}
          </motion.li>
        );
      })}
    </ul>
  );
  // On a phone, a tap sparks (ink on the light canvas).
  return onPick ? <ClickSpark sparkColor="#000000" sparkSize={10} sparkRadius={22} sparkCount={8}>{list}</ClickSpark> : list;
}

/**
 * A connections question's clues, one more every few seconds while it's open, all of them at the reveal. The clues
 * aren't secret (only the link is), so every screen counts them off the same clock: when the question opened.
 */
export function Clues({ question, now, big = false }: { question: QuizQuestion; now: number; big?: boolean }) {
  const clues = cluesOf(question);
  const shown = cluesShown(question, now);
  return (
    <ol data-testid="clues" data-shown={shown} aria-live="polite"
        className={`grid ${big ? "grid-cols-4 gap-6" : "grid-cols-2 gap-2"}`}>
      {clues.map((clue, i) => (
        <li key={i} data-testid="clue" data-visible={i < shown}
            className={`flex flex-col gap-1 border-t-2 ${i < shown ? "border-ink" : "border-border"} ${big ? "pt-4" : "pt-2"}`}>
          <span className={`font-mono text-muted ${big ? "text-xl" : "text-xs"}`}>{String(i + 1).padStart(2, "0")}</span>
          {i < shown ? (
            <motion.span initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
                         className={big ? "text-4xl leading-tight" : "text-lg leading-snug"}>{clue}</motion.span>
          ) : (
            <span className={`text-muted ${big ? "text-4xl" : "text-lg"}`} aria-label="Clue still to come">…</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * In order, on a phone: tap the items first to last; each tap numbers one. Undo takes the last back; once all are
 * numbered, lock it in.
 */
export function OrderPicker({ question, pending, onAnswer }: {
  question: QuizQuestion;
  pending: boolean;
  onAnswer: (order: number[]) => void;
}) {
  const items = optionsOf(question);
  const [order, setOrder] = useState<number[]>([]);
  const done = order.length === items.length;
  return (
    <div data-testid="order-picker" className="flex flex-col gap-3">
      {question.unit ? <p className="caps text-xs text-muted">{question.unit}</p> : null}
      <ul className="flex flex-col gap-2">
        {items.map((item, i) => {
          const place = order.indexOf(i);
          return (
            <li key={i}>
              <button type="button" data-testid="order-item" data-option={i} disabled={pending || place >= 0}
                      onClick={() => setOrder([...order, i])}
                      className={`flex min-h-14 w-full items-center gap-4 border border-ink px-4 text-left text-lg transition ${place >= 0 ? "bg-ink text-background" : ""}`}>
                <span className="numeral w-8 text-2xl">{place >= 0 ? place + 1 : ""}</span>
                <span className="flex-1">{item}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={pending || order.length === 0} onClick={() => setOrder(order.slice(0, -1))}>
          Undo
        </Button>
        <Button disabled={pending || !done} onClick={() => onAnswer(order)}>Lock it in</Button>
      </div>
    </div>
  );
}

/**
 * In order, on the TV: the items while it's open, then at the reveal in their right order, numbered, with how many
 * got all of them right.
 */
export function OrderList({ question, big = false }: { question: QuizQuestion; big?: boolean }) {
  const items = optionsOf(question);
  const key = keyOf(question);
  const shown = key?.order ? key.order : items.map((_, i) => i);
  return (
    <div className="flex flex-col gap-3">
      {question.unit ? <p className={`caps text-muted ${big ? "text-2xl" : "text-xs"}`}>{question.unit}</p> : null}
      <LayoutGroup>
        <ol className="flex flex-col border-t border-border">
          {shown.map((i, place) => (
            <motion.li layout key={i} data-testid="order-row" data-correct={key ? true : undefined}
                       transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
                       className={`flex items-baseline gap-6 border-b border-border ${big ? "py-4 text-5xl" : "py-2 text-lg"}`}>
              <span className={`numeral ${big ? "w-16 text-5xl" : "w-8"} ${key ? "text-ok" : "text-muted"}`}>
                {key ? place + 1 : "·"}
              </span>
              <span>{items[i]}</span>
            </motion.li>
          ))}
        </ol>
      </LayoutGroup>
    </div>
  );
}

/**
 * A question's picture, from the private quiz-images bucket: Storage lets a player or TV read it only once the
 * question has been asked in their room, so it's downloaded with this device's login and shown as a blob URL.
 */
export function QuizPicture({ question, big = false }: { question: QuizQuestion; big?: boolean }) {
  const supabase = useSupabase();
  const path = question.image_path;
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);

  useEffect(() => {
    if (!path) return;
    let url: string | null = null;
    let cancelled = false;
    void supabase.storage.from("quiz-images").download(path).then(({ data }) => {
      if (cancelled || !data) return;
      url = URL.createObjectURL(data);
      setLoaded({ path, url });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, supabase]);

  if (!path) return null;
  const credit = question.image_credit as { author?: string; licence?: string } | null;
  const src = loaded?.path === path ? loaded.url : null;
  return (
    <figure className="flex flex-col gap-2">
      <div className={`grid w-full place-items-center overflow-hidden bg-surface ${big ? "h-[38vh]" : "h-48 border border-border"}`}>
        {src ? (
          // A blob URL from Storage (next/image can't optimise it); the CSP allows blob: images.
          // eslint-disable-next-line @next/next/no-img-element
          <img data-testid="quiz-picture" src={src} alt="The picture for this question"
               className="h-full w-full object-contain" />
        ) : (
          <p className="caps text-xs text-muted">Loading the picture…</p>
        )}
      </div>
      {big && credit ? (
        <figcaption className="caps text-sm text-muted">
          Picture: {credit.author ?? "unknown"}{credit.licence ? `, ${credit.licence}` : ""} (Wikimedia Commons)
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * Everyone's points in order, reordering with movement as scores change. `before`: places when the question was
 * asked, so each row can show how far it moved at the reveal. `count`: points count up to their new total (the TV's
 * live standings); without it they're exact at once, as anyone reading a final table needs.
 */
export function Leaderboard({ scores, names, before, big = false, meId, limit, count = false }: {
  scores: QuizScore[];
  names: Map<string, string>;
  before?: Map<string, number>;
  big?: boolean;
  meId?: string;
  limit?: number;
  count?: boolean;
}) {
  const rows = standings(scores).slice(0, limit ?? scores.length);
  return (
    <LayoutGroup>
      <ol data-testid="leaderboard" className="flex flex-col border-t border-border">
        {rows.map((s) => {
          const was = before?.get(s.member_id);
          const moved = was ? was - s.place : 0;
          return (
            <motion.li layout key={s.member_id} data-testid="leader" data-member={s.member_id}
                       transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
                       className={`flex items-center gap-3 border-b border-border ${big ? "py-3" : "py-2"}`}>
              <span className={`w-8 font-mono text-muted ${big ? "text-xl" : "text-sm"}`}>{String(s.place).padStart(2, "0")}</span>
              <Avatar id={s.member_id} name={names.get(s.member_id) ?? "?"} size={big ? 40 : 28} live={s.member_id === meId} />
              <span className={`min-w-0 flex-1 truncate ${big ? "text-2xl" : ""}`}>
                {names.get(s.member_id) ?? "?"}
                {s.jokers > 0 ? <span className="caps ml-2 text-[11px] text-muted">joker</span> : null}
              </span>
              {moved !== 0 ? (
                <motion.span initial={{ opacity: 0, y: moved > 0 ? 6 : -6 }} animate={{ opacity: 1, y: 0 }}
                             className={`font-mono text-sm ${moved > 0 ? "text-ok" : "text-danger"}`}
                             aria-label={moved > 0 ? `up ${moved}` : `down ${-moved}`}>
                  {moved > 0 ? `▲${moved}` : `▼${-moved}`}
                </motion.span>
              ) : null}
              <span className={`font-mono tabular-nums ${big ? "text-2xl" : ""}`}>
                {count ? <CountUp to={s.points} separator="," duration={0.8} trigger="load" /> : formatNumber(s.points)}
              </span>
            </motion.li>
          );
        })}
      </ol>
    </LayoutGroup>
  );
}

/**
 * Everyone's place when the current question was asked, kept until the next one, so the reveal can show who
 * moved. (A screen that loads mid-reveal has nothing to compare with, and shows no arrows; nor does the first
 * scoring question, when everyone started tied.)
 */
export function usePlacesWhenAsked(question: QuizQuestion | null, scores: QuizScore[]): Map<string, number> | undefined {
  const [snapshot, setSnapshot] = useState<{ number: number; places: Map<string, number> } | null>(null);
  if (question && !question.revealed_at && snapshot?.number !== question.number) {
    // Before anyone has scored, everyone's tied first: falling from that isn't news, so no arrows yet.
    const scored = scores.some((s) => s.points > 0);
    setSnapshot({ number: question.number, places: scored ? new Map(standings(scores).map((s) => [s.member_id, s.place])) : new Map() });
  }
  return snapshot && question && snapshot.number === question.number && snapshot.places.size > 0 ? snapshot.places : undefined;
}

/** The top three as ruled columns rising from a baseline: third, then second, then the winner (the amber one). */
export function Podium({ scores, names, big = false }: { scores: QuizScore[]; names: Map<string, string>; big?: boolean }) {
  const top = standings(scores).slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  const height = (place: number) => (place === 1 ? (big ? "h-56" : "h-28") : place === 2 ? (big ? "h-40" : "h-20") : big ? "h-28" : "h-14");
  return (
    <div data-testid="podium" className="grid grid-cols-3 items-end border-b border-ink">
      {order.map((s) => (
        <motion.div key={s.member_id} data-testid="podium-place" data-place={s.place}
                    initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: s.place === 1 ? 1.2 : s.place === 2 ? 0.7 : 0.2, duration: 0.3, ease: [0.2, 0, 0, 1] }}
                    className={`flex flex-col gap-2 ${big ? "px-4" : "px-1"}`}>
          <Avatar id={s.member_id} name={names.get(s.member_id) ?? "?"} size={big ? 72 : 40} live={s.place === 1} />
          <span className={`truncate ${big ? "text-3xl" : ""}`}>{names.get(s.member_id) ?? "?"}</span>
          <span className={`font-mono text-muted ${big ? "text-2xl" : "text-sm"}`}>
            <CountUp to={s.points} separator="," duration={1.4} delay={s.place === 1 ? 1.2 : s.place === 2 ? 0.7 : 0.2} trigger="load" />
          </span>
          <div className={`flex items-start p-3 ${s.place === 1 ? "bg-accent text-accent-ink" : "bg-ink text-background"} ${height(s.place)}`}>
            <span className={`numeral ${big ? "text-8xl" : "text-4xl"}`}>{s.place}</span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
