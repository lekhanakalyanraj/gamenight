import "server-only";

import type { Database } from "@gamenight/db-types";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { serverEnv } from "@/lib/env";

/** A Supabase client for Server Components, Server Actions and Route Handlers, acting as the signed-in user. */
export async function createClient() {
  const cookieStore = await cookies();
  const env = serverEnv();
  return createServerClient<Database>(env.supabaseUrl, env.supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components can't set cookies. That's fine: proxy.ts refreshes the session on every request.
        }
      },
    },
  });
}

/** The verified identity of the caller, or null. Uses JWT claims, so it can't be spoofed by a cookie edit. */
export async function getIdentity() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims) return null;
  return {
    userId: claims.sub,
    isGuest: Boolean(claims.is_anonymous),
    email: (claims.email as string | undefined) ?? null,
  };
}
