/**
 * The login cookie's name, fixed. Supabase otherwise derives it from the Supabase URL's host, and the
 * server and browsers reach Supabase at different hosts (127.0.0.1 vs the Wi-Fi address with make lan;
 * host.docker.internal vs localhost in Docker), so they'd look for different cookies and the browser
 * would act signed out: no live lobby, no TV pairing.
 */
export const AUTH_COOKIE = { name: "sb-gamenight-auth-token" } as const;
