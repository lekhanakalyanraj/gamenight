"use client";

import type { Database } from "@gamenight/db-types";
import { createBrowserClient } from "@supabase/ssr";
import { createContext, type ReactNode, use, useMemo } from "react";

type BrowserConfig = { url: string; publishableKey: string };

const SupabaseConfig = createContext<BrowserConfig | null>(null);

/** Rendered by the root layout with values read on the server at request time (lib/env.ts). */
export function SupabaseProvider({ children, ...config }: BrowserConfig & { children: ReactNode }) {
  return <SupabaseConfig value={config}>{children}</SupabaseConfig>;
}

/** A Supabase client for Client Components (Realtime, the TV's anonymous sign-in). */
export function useSupabase() {
  const config = use(SupabaseConfig);
  if (!config) throw new Error("useSupabase needs <SupabaseProvider> (see app/layout.tsx).");
  return useMemo(() => createBrowserClient<Database>(config.url, config.publishableKey), [config.url, config.publishableKey]);
}
