"use server";

/** The server's time, so screens can correct for their own clock when counting down to a deadline. */
export async function serverNow(): Promise<number> {
  return Date.now();
}
