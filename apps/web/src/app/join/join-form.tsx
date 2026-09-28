"use client";

import { useActionState } from "react";

import { Button, Field, Notice } from "@/components/ui";
import type { FormState } from "@/lib/validate";

import { joinRoom } from "./actions";

export function JoinForm({ code }: { code: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(joinRoom, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label="Room code"
        name="code"
        defaultValue={state.values?.code ?? code}
        autoCapitalize="characters"
        autoComplete="off"
        maxLength={6}
        className="h-14 rounded-xl border border-border bg-background px-3 text-center font-mono text-2xl tracking-[0.4em] uppercase outline-none focus:border-accent"
        required
      />
      <Field
        label="Your nickname"
        name="nickname"
        defaultValue={state.values?.nickname}
        maxLength={20}
        autoComplete="nickname"
        required
      />
      <label className="flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" name="confirm_adult" className="size-4 accent-accent" />
        I&apos;m 18 or over (needed for adult rooms)
      </label>
      <Notice>{state.error}</Notice>
      <Button type="submit" disabled={pending}>{pending ? "Joining..." : "Join the room"}</Button>
    </form>
  );
}
