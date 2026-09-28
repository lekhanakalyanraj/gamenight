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
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="mb-1.5 text-muted">Age rating</legend>
        <div className="grid grid-cols-3 gap-2">
          {RATINGS.map((r) => (
            <label
              key={r.value}
              className={`flex cursor-pointer flex-col rounded-xl border px-3 py-2 ${
                rating === r.value ? "border-accent bg-surface-2" : "border-border"
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
              <span className="font-medium">{r.label}</span>
              <span className="text-xs text-muted">{r.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {rating === "adult" ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm_adult" required className="size-4 accent-accent" />
          I&apos;m 18 or over, and every player must confirm the same when they join.
        </label>
      ) : null}
      <Notice>{state.error}</Notice>
      <Button type="submit" disabled={pending}>{pending ? "Creating..." : "Create room"}</Button>
    </form>
  );
}
