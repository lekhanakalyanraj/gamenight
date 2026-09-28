import type { Database } from "@gamenight/db-types";
import { createBrowserClient } from "@supabase/ssr";

import { env } from "@/lib/env";

/** A Supabase client for Client Components (used for Realtime from slice 1 on). */
export function createClient() {
  return createBrowserClient<Database>(env.supabaseUrl, env.supabaseKey);
}
