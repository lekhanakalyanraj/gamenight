"use server";

import { redirect } from "next/navigation";

import { friendlyError } from "@/lib/errors";
import { createClient, getIdentity } from "@/lib/supabase/server";
import { type FormState, isUuid, roomCode, text } from "@/lib/validate";

// Every rule (host only, lobby only, rate limits) is enforced by the RPCs; these only validate input shape.

export async function pairDisplay(roomId: string, _: FormState, form: FormData): Promise<FormState> {
  const values = { tv_code: text(form, "tv_code").toUpperCase() };
  const code = roomCode(form, "tv_code");
  if (!isUuid(roomId)) return { error: "Something went wrong. Please try again.", values };
  if (!code) return { error: "TV codes are 6 letters and numbers.", values };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pair_display", { p_room_id: roomId, p_code: code });
  if (error) return { error: friendlyError(error), values };
  if (!data?.id) {
    return { error: "No TV is showing that code. Check the TV: its code changes every 10 minutes.", values };
  }
  return { notice: "TV connected." };
}

export async function removeDisplay(displayId: string): Promise<{ error?: string }> {
  if (!isUuid(displayId)) return { error: "Something went wrong. Please try again." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_display", { p_display_id: displayId });
  return error ? { error: friendlyError(error) } : {};
}

export async function kickMember(memberId: string): Promise<{ error?: string }> {
  if (!isUuid(memberId)) return { error: "Something went wrong. Please try again." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("kick_member", { p_member_id: memberId });
  return error ? { error: friendlyError(error) } : {};
}

/** Guests leave; when the host leaves, the room closes (leave_room decides). */
export async function leaveRoom(roomId: string): Promise<{ error?: string }> {
  if (!isUuid(roomId)) return { error: "Something went wrong. Please try again." };
  const identity = await getIdentity();
  const supabase = await createClient();
  const { error } = await supabase.rpc("leave_room", { p_room_id: roomId });
  if (error) return { error: friendlyError(error) };
  redirect(identity && !identity.isGuest ? "/host" : "/");
}
