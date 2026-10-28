"use client";

import { useActionState, useState } from "react";

import { Button, Field, Notice } from "@/components/ui";
import type { FormState } from "@/lib/validate";

import { createRoom } from "./actions";

const RATINGS = [
  { value: "family", label: "Family", hint: "Everyone" },
  { value: "teen", label: "Teen", hint: "13+" },
  { value: "adult", label: "Adult", hint: "18+ only" },
] as const;

export function CreateRoomForm({ defaultNickname }: { defaultNickname: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createRoom, {});
  const [rating, setRating] = useState<(typeof RATINGS)[number]["value"]>("family");

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label="Your nickname in the game" name="nickname" defaultValue={state.values?.nickname ?? defaultNickname} maxLength={20} required />
      <fieldset className="flex flex-col gap-2">
        <legend className="caps mb-2 text-xs text-muted">Age rating</legend>
        <div className="grid grid-cols-3 border border-ink">
          {RATINGS.map((r) => (
            <label
              key={r.value}
              className={`flex cursor-pointer flex-col gap-1 border-ink px-3 py-3 [&:not(:last-child)]:border-r ${
                rating === r.value ? "bg-ink text-background" : ""
              }`}
            >
              <input
                type="radio"
                name="age_rating"
                value={r.value}
                checked={rating === r.value}
                onChange={() => setRating(r.value)}
                className="sr-only"
              />
              <span>{r.label}</span>
              <span className="caps text-[11px] opacity-60">{r.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {rating === "adult" ? (
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" name="confirm_adult" required className="size-4 accent-[var(--ink)]" />
          I&apos;m 18 or over, and every player must confirm the same when they join.
        </label>
      ) : null}
      <Notice>{state.error}</Notice>
      <Button type="submit" disabled={pending}>{pending ? "Creating..." : "Create room"}</Button>
    </form>
  );
}
