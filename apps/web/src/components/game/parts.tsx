"use client";

import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { type Card, ROLE_LABEL } from "@/lib/game";
import { initials, tileColour } from "@/lib/room";

/** A player's round initials tile, the same colour on every screen. */
export function Avatar({ id, name, size = 40, dim = false }: { id: string; name: string; size?: number; dim?: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white ${tileColour(id)} ${dim ? "opacity-35 grayscale" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials(name)}
    </span>
  );
}

/** A ring that drains as the clock runs down, with the seconds in the middle. */
export function TimerRing({ seconds, total, size = 56, label }: { seconds: number; total: number; size?: number; label?: string }) {
  const r = size / 2 - 4;
  const circumference = 2 * Math.PI * r;
  const left = Math.max(0, Math.min(1, seconds / Math.max(total, 1)));
  const urgent = seconds <= 5;
  return (
    <span className="relative inline-grid place-items-center" style={{ width: size, height: size }} role="timer" aria-label={label ?? `${seconds} seconds left`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={4} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={urgent ? "var(--danger)" : "var(--accent)"}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference * (1 - left) }}
          animate={{ strokeDashoffset: circumference * (1 - left) }}
          transition={{ duration: 0.3, ease: "linear" }}
        />
      </svg>
      <motion.span
        key={urgent ? "urgent" : "calm"}
        className={`absolute font-mono font-semibold ${urgent ? "text-danger" : ""}`}
        style={{ fontSize: size * 0.34 }}
        animate={urgent ? { scale: [1, 1.18, 1] } : { scale: 1 }}
        transition={urgent ? { repeat: Infinity, duration: 1 } : undefined}
      >
        {seconds}
      </motion.span>
    </span>
  );
}

/**
 * The player's card, face down until held (touch, mouse, or holding Space). It turns face down again the
 * moment it's let go, or when the phone is locked or the tab hidden, so it's never left showing.
 */
export function HoldCard({ card }: { card: Card | null }) {
  const [showing, setShowing] = useState(false);
  const holdingKey = useRef(false);

  useEffect(() => {
    const hide = () => setShowing(false);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  const face = !card ? "Dealing…" : card.role === "mr_white" ? "You're Mr. White" : card.word;
  const hint = !card ? "" : card.role === "mr_white" ? "No word: listen, blend in, and bluff." : "Your word. Keep it to yourself.";

  return (
    <button
      type="button"
      data-testid="card"
      data-showing={showing}
      aria-label={showing ? `Your card: ${face}` : "Your card. Hold to see it."}
      className="relative h-28 w-full touch-none select-none [perspective:800px]"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setShowing(true);
      }}
      onPointerUp={() => setShowing(false)}
      onPointerCancel={() => setShowing(false)}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !holdingKey.current) {
          e.preventDefault();
          holdingKey.current = true;
          setShowing(true);
        }
      }}
      onKeyUp={() => {
        holdingKey.current = false;
        setShowing(false);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <motion.span
        className="absolute inset-0 [transform-style:preserve-3d]"
        animate={{ rotateY: showing ? 180 : 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 22 }}
      >
        <span className="absolute inset-0 grid place-items-center rounded-2xl border border-dashed border-border bg-surface-2 text-muted [backface-visibility:hidden]">
          Hold to see your card
        </span>
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-2xl border border-accent bg-surface text-center [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <span data-testid="card-face" className="text-3xl font-semibold text-accent">{showing ? face : ""}</span>
          <span className="px-4 text-xs text-muted">{showing ? hint : ""}</span>
        </span>
      </motion.span>
    </button>
  );
}

/** A big phase title that swaps with a slide, so every screen changes phase with a beat. */
export function PhaseTitle({ id, children, className = "" }: { id: string; children: ReactNode; className?: string }) {
  // Each phase animates in, and the last one goes at once: no exit animation. With an exit and mode="wait", a key
  // that changed again mid-exit (the quiz reveals its last question and ends in the same moment) could leave the
  // old phase on screen for good.
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 24, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.35 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** "Ben is out · they were undercover": a card that stamps down and flips to show the role. */
export function Elimination({ name, id, role, big = false }: { name: string; id: string; role: keyof typeof ROLE_LABEL; big?: boolean }) {
  return (
    <motion.div
      data-testid="elimination"
      initial={{ scale: 1.6, opacity: 0, rotate: -6 }}
      animate={{ scale: 1, opacity: 1, rotate: 0 }}
      transition={{ type: "spring", stiffness: 320, damping: 18 }}
      className={`flex items-center gap-4 rounded-2xl border border-danger/60 bg-surface ${big ? "p-8" : "p-4"}`}
    >
      <Avatar id={id} name={name} size={big ? 96 : 48} />
      <div className="flex flex-col">
        <span className={`font-semibold ${big ? "text-5xl" : "text-xl"}`}>{name} is out</span>
        <motion.span
          initial={{ rotateX: 90, opacity: 0 }}
          animate={{ rotateX: 0, opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.5 }}
          className={`text-danger ${big ? "text-3xl" : "text-base"}`}
        >
          They were {ROLE_LABEL[role]}
        </motion.span>
      </div>
    </motion.div>
  );
}
