"use client";

import { motion } from "motion/react";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";

import { type Card, ROLE_LABEL } from "@/lib/game";
import { initials } from "@/lib/room";

/**
 * A player's square initials tile: no colours, so the palette stays neutral. Amber marks the live one (you, or whoever's
 * turn it is); a player who's out is dimmed.
 */
export function Avatar({ name, size = 40, dim = false, live = false }: {
  id?: string; name: string; size?: number; dim?: boolean; live?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center border font-mono ${live ? "border-accent bg-accent text-accent-ink" : "border-current"} ${dim ? "opacity-30" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials(name)}
    </span>
  );
}

/** The clock: the seconds as a thin numeral over a hairline bar that drains. Red for the last five seconds. */
export function Timer({ seconds, total, size = 56, label }: { seconds: number; total: number; size?: number; label?: string }) {
  const left = Math.max(0, Math.min(1, seconds / Math.max(total, 1)));
  const urgent = seconds <= 5;
  return (
    <span className="inline-flex flex-col items-end gap-2" role="timer" aria-label={label ?? `${seconds} seconds left`}>
      <span className={`numeral ${urgent ? "text-danger" : ""}`} style={{ fontSize: size * 0.72 }}>
        {String(seconds).padStart(2, "0")}
      </span>
      <span className="block h-[3px] bg-border" style={{ width: size * 1.3 }} aria-hidden>
        <motion.span
          className={`block h-full ${urgent ? "bg-danger" : "bg-accent"}`}
          initial={{ width: `${left * 100}%` }}
          animate={{ width: `${left * 100}%` }}
          transition={{ duration: 0.3, ease: "linear" }}
        />
      </span>
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
      className="relative h-32 w-full touch-none select-none [perspective:800px]"
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
        transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      >
        <span className="absolute inset-0 flex flex-col items-start justify-between border border-dashed border-ink p-4 text-left [backface-visibility:hidden]">
          <span className="caps text-xs text-muted">Your card</span>
          <span className="text-lg">Hold to see it</span>
        </span>
        <span className="absolute inset-0 flex flex-col items-start justify-between bg-ink p-4 text-left text-background [backface-visibility:hidden] [transform:rotateY(180deg)]">
          <span className="caps text-xs opacity-60">{showing ? hint : ""}</span>
          <span data-testid="card-face" className="text-4xl">{showing ? face : ""}</span>
        </span>
      </motion.span>
    </button>
  );
}

/** A phase's content, sliding in short and straight, so every screen changes phase with a beat. */
export function PhaseTitle({ id, children, className = "" }: { id: string; children: ReactNode; className?: string }) {
  // Each phase animates in, and the last one goes at once: no exit animation. With an exit and mode="wait", a key
  // that changed again mid-exit (the quiz reveals its last question and ends in the same moment) could leave the
  // old phase on screen for good.
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** "Ben is out · they were undercover": a ruled band that drops in, then the role underneath. */
export function Elimination({ name, id, role, big = false }: { name: string; id: string; role: keyof typeof ROLE_LABEL; big?: boolean }) {
  return (
    <motion.div
      data-testid="elimination"
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
      className={`flex items-center gap-5 border-y border-danger ${big ? "py-8" : "py-4"}`}
    >
      <Avatar id={id} name={name} size={big ? 96 : 48} />
      <div className="flex flex-col gap-1">
        <span className={big ? "text-6xl" : "text-2xl"}>{name} is out</span>
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.3 }}
          className={`caps text-danger ${big ? "text-2xl" : "text-sm"}`}
        >
          They were {ROLE_LABEL[role]}
        </motion.span>
      </div>
    </motion.div>
  );
}

/**
 * The TV's frame for every game: the wordmark bar, the stage (the one live thing) ruled off from the standings,
 * and the AI host's line in a band along the bottom.
 */
export function TvFrame({ label, aside, asideLabel, caption, children, ...main }: {
  label: string;
  aside?: ReactNode;
  asideLabel?: ReactNode;
  caption?: ReactNode;
  children: ReactNode;
} & Omit<ComponentProps<"main">, "children">) {
  return (
    <main {...main} className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 border-b border-border px-6 py-5 md:px-12">
        <span className="text-3xl tracking-tight">gamenight</span>
        <span className="caps text-xl text-muted">{label}</span>
      </header>
      {/* Side by side on a TV; on a narrow window (a TV page opened on a phone) the aside goes underneath. */}
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-8 border-border px-6 py-10 md:border-r md:px-12">{children}</section>
        <aside className="flex min-w-0 flex-col gap-4 border-t border-border px-6 py-10 md:border-t-0 md:px-8">
          {asideLabel ? <p className="caps text-lg text-muted">{asideLabel}</p> : null}
          {aside}
        </aside>
      </div>
      {caption ? <footer className="border-t border-border px-6 py-6 md:px-12">{caption}</footer> : null}
    </main>
  );
}

/**
 * A TV stage's heading: a small label over the phase in big light type, the clock on the right. The title slides in
 * again whenever `swap` changes.
 */
export function StageHeading({ label, title, timer, swap }: { label: ReactNode; title: ReactNode; timer?: ReactNode; swap?: string }) {
  return (
    <header className="flex items-start justify-between gap-8">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="caps text-xl text-muted">{label}</p>
        <PhaseTitle id={swap ?? "title"}>
          <h1 className="text-7xl leading-[1.05] tracking-tight">{title}</h1>
        </PhaseTitle>
      </div>
      {timer}
    </header>
  );
}

/** A phone game's heading: a mono label (game · round), the phase in light type, the clock on the right. */
export function PhoneHeading({ label, title, timer }: { label: ReactNode; title: ReactNode; timer?: ReactNode }) {
  return (
    <header className="flex items-end justify-between gap-3 border-b border-ink pb-3">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="caps text-xs text-muted">{label}</p>
        <h1 className="text-3xl leading-tight tracking-tight">{title}</h1>
      </div>
      {timer}
    </header>
  );
}

/** Where a phone stands when there's nothing to tap: a title and a line under it, ruled on the left. */
export function Status({ title, children, tone }: { title: string; children?: ReactNode; tone?: "danger" }) {
  return (
    <div data-testid="status" className={`flex flex-col gap-2 border-l-2 py-2 pl-4 ${tone === "danger" ? "border-danger" : "border-ink"}`}>
      <p className={`text-2xl leading-tight ${tone === "danger" ? "text-danger" : ""}`}>{title}</p>
      {children ? <p className="text-muted">{children}</p> : null}
    </div>
  );
}

/** A full-width notice band (paused by the host). */
export function Banner({ children }: { children: ReactNode }) {
  return <p role="status" className="caps bg-accent px-3 py-2 text-xs text-accent-ink">{children}</p>;
}

/** The rules for the current moment, folded away until asked for. */
export function HowTo({ children }: { children: ReactNode }) {
  return (
    <details className="border-y border-border py-3 text-sm">
      <summary className="caps cursor-pointer text-xs text-muted">How to play</summary>
      <div className="mt-2 flex flex-col gap-2 text-muted">{children}</div>
    </details>
  );
}
