"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { type FormState, safeNext, text } from "@/lib/validate";

export async function signIn(_: FormState, form: FormData): Promise<FormState> {
  const email = text(form, "email");
  const password = text(form, "password");
  const values = { email }; // never echo the password back
  if (!email || !password) return { error: "Enter your email and password.", values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "That email and password don't match.", values };
  redirect(safeNext(text(form, "next")));
}

export async function signUp(_: FormState, form: FormData): Promise<FormState> {
  const email = text(form, "email");
  const password = text(form, "password");
  const displayName = text(form, "display_name");
  const values = { email, display_name: displayName };
  if (!email || !displayName) return { error: "Enter your name and email.", values };
  if (password.length < 8) return { error: "Use a password of at least 8 characters.", values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName.slice(0, 40) } },
  });
  if (error) return { error: error.message, values };
  redirect(safeNext(text(form, "next")));
}
