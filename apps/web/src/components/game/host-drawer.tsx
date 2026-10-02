"use client";

import type { Game } from "@gamenight/db-types";
import { AnimatePresence, motion } from "motion/react";
import { useState, useTransition } from "react";

import { Button, Notice } from "@/components/ui";
import { hostControl } from "@/app/play/[code]/game-actions";
import { HostChat } from "@/app/play/[code]/host-chat";
import { VoiceSwitch } from "@/components/voice-switch";

/**
 * The host's controls, in a drawer at the bottom of their screen: the host plays like everyone else, and
 * steers the game when they need to. The database decides what's allowed right now; a refusal is shown.
 */
export function HostDrawer({ game, roomId, voice }: { game: Game; roomId: string; voice: boolean }) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const control = (action: Parameters<typeof hostControl>[1]) =>
    startTransition(async () => {
      const result = await hostControl(game.id, action);
      setError(result.error);
      if (!result.error && action === "end") setOpen(false);
    });

  const paused = Boolean(game.paused_at);
  const hasClock = Boolean(game.phase_deadline || game.paused_phase_left);
  const quiz = game.kind === "quiz";
  const headsUp = game.kind === "heads_up";
  const speaking = game.phase === "clues" && game.turn_index !== null;
  // A quiz: close the open question early, or cut the reveal's pause short (the database checks both).
  const canSkipPhase = quiz
    ? (game.phase === "question" || game.phase === "reveal") && Boolean(game.phase_deadline)
    : headsUp
      ? ["ready", "guessing", "recap"].includes(game.phase) && Boolean(game.phase_deadline)
      : ["clues", "discussion", "vote", "guess"].includes(game.phase) && !game.resolved;
  const skipLabel = headsUp
    ? ({ ready: "Start now", guessing: "End the turn", recap: "Next turn" } as Record<string, string>)[game.phase] ?? "Skip"
    : !quiz ? "Skip phase" : game.phase === "reveal" ? "Skip the wait" : "Close the question";

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md px-3 pb-3">
      <AnimatePresence initial={false}>
        {open ? (
          <motion.section
            key="drawer"
            data-testid="host-drawer"
            initial={{ y: "100%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "100%", opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="mb-2 flex max-h-[70dvh] flex-col gap-3 overflow-y-auto rounded-3xl border border-border bg-surface-2 p-4"
          >
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" disabled={pending} onClick={() => control(paused ? "resume" : "pause")}>
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button variant="secondary" disabled={pending || !hasClock} onClick={() => control("extend")}>+30 seconds</Button>
              {quiz || headsUp ? null : (
                <Button variant="secondary" disabled={pending || paused || !speaking} onClick={() => control("skip_turn")}>
                  Skip speaker
                </Button>
              )}
              <Button variant="secondary" disabled={pending || paused || !canSkipPhase} onClick={() => control("skip_phase")}>
                {skipLabel}
              </Button>
            </div>
            {confirmEnd ? (
              <div className="flex gap-2">
                <Button className="flex-1" disabled={pending} onClick={() => control("end")}>End the game</Button>
                <Button variant="secondary" className="flex-1" onClick={() => setConfirmEnd(false)}>Keep playing</Button>
              </div>
            ) : (
              <Button variant="secondary" onClick={() => setConfirmEnd(true)}>End game…</Button>
            )}
            <Notice>{error}</Notice>
            <VoiceSwitch roomId={roomId} on={voice} />
            <Button variant="secondary" onClick={() => setChat((c) => !c)}>{chat ? "Hide chat" : "Chat with the AI host"}</Button>
            {chat ? <HostChat roomId={roomId} /> : null}
          </motion.section>
        ) : null}
      </AnimatePresence>
      <Button className="w-full" variant={open ? "secondary" : "primary"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Close host controls" : "Host controls"}
      </Button>
    </div>
  );
}
