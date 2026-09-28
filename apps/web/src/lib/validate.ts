/** error: what to show; values: what the user typed, so a failed submit doesn't wipe the form. */
export type FormState = { error?: string; values?: Record<string, string> };

export function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function nickname(form: FormData): string | null {
  const value = text(form, "nickname");
  return value.length >= 1 && value.length <= 20 ? value : null;
}

const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
export function roomCode(form: FormData): string | null {
  const value = text(form, "code").toUpperCase();
  return ROOM_CODE.test(value) ? value : null;
}
export const isRoomCode = (value: string) => ROOM_CODE.test(value.toUpperCase());

/** Only allow same-site relative redirects, so ?next= can't send people elsewhere. */
export function safeNext(value: string | null | undefined, fallback = "/host"): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}
