"use server";

import type { AgeRating } from "@gamenight/db-types";
import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/errors";
import { createClient, getIdentity } from "@/lib/supabase/server";
import { type FormState, nickname, text } from "@/lib/validate";

const RATINGS: AgeRating[] = ["family", "teen", "adult"];

export async function createRoom(_: FormState, form: FormData): Promise<FormState> {
  const identity = await getIdentity();
  if (!identity || identity.isGuest) return { error: "Sign in as a host to create a room." };

  const values = { nickname: text(form, "nickname") };
  const name = nickname(form);
  if (!name) return { error: "Pick a nickname of 1 to 20 characters.", values };
  const rating = text(form, "age_rating") as AgeRating;
  if (!RATINGS.includes(rating)) return { error: "Pick an age rating.", values };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_room", {
    p_nickname: name,
    p_age_rating: rating,
    p_confirm_adult: form.get("confirm_adult") === "on",
  });
  if (error || !data) return { error: friendlyError(error), values };
  redirect(`/play/${data.code}`);
}
