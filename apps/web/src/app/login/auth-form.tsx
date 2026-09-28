"use client";

import { useActionState, useState } from "react";

import { Button, Field, Notice } from "@/components/ui";
import type { FormState } from "@/lib/validate";

import { signIn, signUp } from "./actions";

export function AuthForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [inState, signInAction, signingIn] = useActionState<FormState, FormData>(signIn, {});
  const [upState, signUpAction, signingUp] = useActionState<FormState, FormData>(signUp, {});
  const state = mode === "in" ? inState : upState;

  return (
    <form action={mode === "in" ? signInAction : signUpAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      {mode === "up" ? <Field label="Your name" name="display_name" defaultValue={state.values?.display_name} autoComplete="name" required /> : null}
      <Field label="Email" name="email" type="email" defaultValue={state.values?.email} autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={mode === "in" ? "current-password" : "new-password"}
        minLength={mode === "up" ? 8 : undefined}
        required
      />
      <Notice>{state.error}</Notice>
      <Button type="submit" disabled={signingIn || signingUp}>
        {mode === "in" ? "Sign in" : "Create host account"}
      </Button>
      <button
        type="button"
        className="text-sm text-muted underline-offset-4 hover:underline"
        onClick={() => setMode(mode === "in" ? "up" : "in")}
      >
        {mode === "in" ? "New here? Create a host account" : "Already hosting? Sign in"}
      </button>
    </form>
  );
}
