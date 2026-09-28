"use server";

import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { type FormState, nickname, roomCode, text } from "@/lib/validate";

export async function joinRoom(_: FormState, form: FormData): Promise<FormState> {
  const values = { code: text(form, "code").toUpperCase(), nickname: text(form, "nickname") };
  const code = roomCode(form);
  if (!code) return { error: "Room codes are 6 letters and numbers.", values };
  const name = nickname(form);
  if (!name) return { error: "Pick a nickname of 1 to 20 characters.", values };

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) {
    // Players don't need an account: an anonymous Supabase user is enough, and RLS treats it like any user.
    const { error } = await supabase.auth.signInAnonymously();
    if (error) return { error: "Couldn't start a guest session. Please try again.", values };
  }

  const { error } = await supabase.rpc("join_room", {
    p_code: code,
    p_nickname: name,
    p_confirm_adult: form.get("confirm_adult") === "on",
  });
  if (error) return { error: friendlyError(error), values };
  redirect(`/play/${code}`);
}
