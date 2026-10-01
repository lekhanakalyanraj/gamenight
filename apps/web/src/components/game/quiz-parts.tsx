"use client";

import type { QuizQuestion, QuizScore } from "@gamenight/db-types";
import { LayoutGroup, motion } from "motion/react";
import { useEffect, useState } from "react";

import { Avatar } from "@/components/game/parts";
import {
  type ChoiceResults,
  formatNumber,
  keyOf,
  kindOf,
  optionsOf,
  standings,
  TILES,
  TRUE_FALSE,
  type TrueFalseResults,
} from "@/lib/quiz";
import { useSupabase } from "@/lib/supabase/client";

/** The shape on an answer tile, so tiles differ by more than colour. */
export function Shape({ shape, size = 22 }: { shape: (typeof TILES)[number]["shape"]; size?: number }) {
  const common = { fill: "currentColor" };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      {shape === "triangle" ? <polygon points="12,3 22,21 2,21" {...common} /> : null}
      {shape === "diamond" ? <polygon points="12,2 22,12 12,22 2,12" {...common} /> : null}
      {shape === "circle" ? <circle cx="12" cy="12" r="10" {...common} /> : null}
      {shape === "square" ? <rect x="3" y="3" width="18" height="18" rx="2" {...common} /> : null}
    </svg>
  );
}

type TileState = "open" | "picked" | "dim" | "right" | "wrong";

/**
 * The answer tiles for a choice, picture or true-or-false question. On a phone they're buttons; on the TV they
 * show the options and, after the reveal, which was right and how many picked each.
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
  const tiles = kindOf(question) === "true_false"
    ? TRUE_FALSE.map((t) => ({
        id: String(t.value), label: t.label, className: t.className, shape: null,
        answer: { value: t.value } as const, isPicked: picked === t.value,
        isRight: key ? key.value === t.value : null,
        count: results ? (results as TrueFalseResults).picks?.[t.value ? "true" : "false"] ?? 0 : null,
      }))
    : optionsOf(question).map((label, i) => ({
        id: String(i), label, className: TILES[i].className, shape: TILES[i].shape,
        answer: { option: i } as const, isPicked: picked === i,
        isRight: key ? key.option === i : null,
        count: results ? (results as ChoiceResults).picks?.[i] ?? 0 : null,
      }));

  return (
    <ul className={`grid grid-cols-2 ${big ? "gap-5" : "gap-3"}`}>
      {tiles.map((t) => {
        const state: TileState = t.isRight === true ? "right" : t.isRight === false ? (t.isPicked ? "wrong" : "dim")
          : picked !== undefined && picked !== null ? (t.isPicked ? "picked" : "dim") : "open";
        const body = (
          <>
            {results && answered > 0 && t.count !== null ? (
              <motion.span aria-hidden initial={{ scaleX: 0 }} animate={{ scaleX: t.count / answered }}
                           transition={{ duration: 0.8, delay: 0.3 }}
                           className="pointer-events-none absolute inset-y-0 left-0 w-full origin-left bg-white/20" />
            ) : null}
            {t.shape ? <Shape shape={t.shape} size={big ? 40 : 22} /> : null}
            <span className={`flex-1 text-left font-semibold ${big ? "text-4xl" : "text-lg"}`}>{t.label}</span>
            {t.count !== null ? (
              <span className={`font-mono ${big ? "text-3xl" : "text-base"}`} data-testid="tile-count">{t.count}</span>
            ) : null}
          </>
        );
        const look = `relative flex w-full items-center gap-3 overflow-hidden rounded-2xl ${big ? "min-h-28 px-6 py-5" : "min-h-16 px-4 py-3"} ${t.className} transition ${
          state === "dim" ? "opacity-35" : ""} ${state === "right" ? "ring-4 ring-white" : ""} ${state === "picked" ? "ring-4 ring-accent" : ""} ${
          state === "wrong" ? "opacity-60 ring-4 ring-danger" : ""}`;
        return (
          <motion.li key={t.id} layout animate={state === "right" ? { scale: [1, 1.06, 1] } : { scale: 1 }}
                     transition={{ duration: 0.5 }}>
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
    <figure className="flex flex-col items-center gap-2">
      <div className={`grid w-full place-items-center overflow-hidden rounded-2xl bg-surface-2 ${big ? "h-[38vh]" : "h-48"}`}>
        {src ? (
          // A blob URL from Storage (next/image can't optimise it); the CSP allows blob: images.
          // eslint-disable-next-line @next/next/no-img-element
          <img data-testid="quiz-picture" src={src} alt="The picture for this question"
               className="h-full w-full object-contain" />
        ) : (
          <p className="text-muted">Loading the picture…</p>
        )}
      </div>
      {big && credit ? (
        <figcaption className="text-base text-muted">
          Picture: {credit.author ?? "unknown"}{credit.licence ? `, ${credit.licence}` : ""} (Wikimedia Commons)
        </figcaption>
      ) : null}
    </figure>
  );
}

/**
 * Everyone's points in order, reordering with movement as scores change. `before`: places when the question was
 * asked, so each row can show how far it moved at the reveal.
 */
export function Leaderboard({ scores, names, before, big = false, meId, limit }: {
  scores: QuizScore[];
  names: Map<string, string>;
  before?: Map<string, number>;
  big?: boolean;
  meId?: string;
  limit?: number;
}) {
  const rows = standings(scores).slice(0, limit ?? scores.length);
  return (
    <LayoutGroup>
      <ol data-testid="leaderboard" className={`flex flex-col ${big ? "gap-2" : "gap-1.5"}`}>
        {rows.map((s) => {
          const was = before?.get(s.member_id);
          const moved = was ? was - s.place : 0;
          return (
            <motion.li layout key={s.member_id} data-testid="leader" data-member={s.member_id}
                       transition={{ type: "spring", stiffness: 300, damping: 30 }}
                       className={`flex items-center gap-3 rounded-2xl border bg-surface ${big ? "p-3" : "px-3 py-2"} ${
                         s.member_id === meId ? "border-accent" : "border-border"}`}>
              <span className={`w-7 text-center font-mono text-muted ${big ? "text-2xl" : ""}`}>{s.place}</span>
              <Avatar id={s.member_id} name={names.get(s.member_id) ?? "?"} size={big ? 44 : 30} />
              <span className={`min-w-0 flex-1 truncate font-medium ${big ? "text-xl" : ""}`}>
                {names.get(s.member_id) ?? "?"}
                {s.jokers > 0 ? <span className="ml-2 text-sm text-accent">joker</span> : null}
              </span>
              {moved !== 0 ? (
                <motion.span initial={{ opacity: 0, y: moved > 0 ? 6 : -6 }} animate={{ opacity: 1, y: 0 }}
                             className={`text-sm font-semibold ${moved > 0 ? "text-[#2bb673]" : "text-danger"}`}
                             aria-label={moved > 0 ? `up ${moved}` : `down ${-moved}`}>
                  {moved > 0 ? `▲${moved}` : `▼${-moved}`}
                </motion.span>
              ) : null}
              <span className={`font-mono font-semibold tabular-nums ${big ? "text-2xl" : ""}`}>{formatNumber(s.points)}</span>
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

/** The top three, rising in from the bottom: third, then second, then the winner. */
export function Podium({ scores, names, big = false }: { scores: QuizScore[]; names: Map<string, string>; big?: boolean }) {
  const top = standings(scores).slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  const height = (place: number) => (place === 1 ? (big ? "h-56" : "h-28") : place === 2 ? (big ? "h-40" : "h-20") : big ? "h-28" : "h-14");
  return (
    <div data-testid="podium" className="flex items-end justify-center gap-4">
      {order.map((s) => (
        <motion.div key={s.member_id} data-testid="podium-place" data-place={s.place}
                    initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: s.place === 1 ? 1.2 : s.place === 2 ? 0.7 : 0.2, type: "spring", stiffness: 200, damping: 18 }}
                    className="flex flex-col items-center gap-2">
          <Avatar id={s.member_id} name={names.get(s.member_id) ?? "?"} size={big ? 96 : 48} />
          <span className={`font-semibold ${big ? "text-3xl" : ""}`}>{names.get(s.member_id) ?? "?"}</span>
          <span className={`font-mono text-muted ${big ? "text-2xl" : "text-sm"}`}>{formatNumber(s.points)}</span>
          <div className={`grid w-24 place-items-center rounded-t-2xl bg-accent text-accent-ink ${big ? "w-40" : ""} ${height(s.place)}`}>
            <span className={`font-semibold ${big ? "text-6xl" : "text-2xl"}`}>{s.place}</span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
