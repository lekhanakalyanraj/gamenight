/** error or notice: what to show; values: what the user typed, so a failed submit doesn't wipe the form. */
export type FormState = { error?: string; notice?: string; values?: Record<string, string> };

export function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function nickname(form: FormData): string | null {
  const value = text(form, "nickname");
  return value.length >= 1 && value.length <= 20 ? value : null;
}

// Room codes and TV pairing codes share one format: 6 characters with no I, O, 0 or 1.
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
export function roomCode(form: FormData, key = "code"): string | null {
  const value = text(form, key).toUpperCase();
  return ROOM_CODE.test(value) ? value : null;
}
export const isRoomCode = (value: string) => ROOM_CODE.test(value.toUpperCase());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Only allow same-site relative redirects, so ?next= can't send people elsewhere. */
export function safeNext(value: string | null | undefined, fallback = "/host"): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}
