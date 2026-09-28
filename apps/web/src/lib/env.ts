import "server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy apps/web/.env.example to .env.local and fill it in.`);
  }
  return value;
}

/**
 * Configuration read at request time, never baked in at build time, so one image runs in any
 * environment. The browser gets its values from the root layout (see lib/supabase/client.tsx).
 */
export function serverEnv() {
  const supabaseUrl = required("SUPABASE_URL");
  return {
    /** How this server reaches Supabase. */
    supabaseUrl,
    supabaseKey: required("SUPABASE_PUBLISHABLE_KEY"),
    /** How browsers reach Supabase, when that differs (e.g. phones on the Wi-Fi via `make lan`). */
    browserSupabaseUrl: process.env.SUPABASE_BROWSER_URL || supabaseUrl,
  };
}

/** How the web server reaches the (private) Agent Server, and the internal token it must send. */
export function agentsEnv() {
  return {
    url: (process.env.AGENTS_URL || "http://127.0.0.1:2024").replace(/\/+$/, ""),
    serviceToken: required("AGENTS_SERVICE_TOKEN"),
  };
}
