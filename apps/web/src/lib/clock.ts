"use client";

import { useEffect, useState } from "react";

import { serverNow } from "@/lib/server-time";

/**
 * The server's clock, as seen from this device: deadlines come from the database, and a phone's own clock
 * can be seconds off. Measured once per screen (half the round trip is the error bar), then ticks locally.
 */
export function useNow(everyMs = 250): number {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const sent = Date.now();
    void serverNow().then((server) => setOffset(server - (sent + Date.now()) / 2));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);

  return now + offset;
}

/** Seconds left until a deadline (never negative); null when there's no clock running. */
export function secondsLeft(deadline: string | null, now: number): number | null {
  return deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : null;
}

/**
 * The countdown to a deadline: seconds left, and the total it started from (the first time this screen saw
 * that deadline), so a ring can show how much is used. The game master picks phase lengths, so the total
 * isn't fixed.
 */
export function useCountdown(deadline: string | null, now: number): { left: number | null; total: number } {
  const left = secondsLeft(deadline, now);
  const [first, setFirst] = useState({ deadline, total: left ?? 0 });
  if (deadline !== first.deadline) setFirst({ deadline, total: left ?? 0 }); // a new deadline: its total starts now
  return { left, total: deadline === first.deadline ? first.total : (left ?? 0) };
}
