import type { Metadata } from "next";
import { connection } from "next/server";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

import { serverEnv } from "@/lib/env";
import { SupabaseProvider } from "@/lib/supabase/client";

// Inter at 100 and 300 stands in for teenage engineering's te-20 (the design reference's own suggestion); next/font
// serves both from this origin, so the strict font-src 'self' CSP holds.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], weight: ["100", "300", "400"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["300", "400"] });

export const metadata: Metadata = {
  title: "gamenight",
  description: "A room on the TV, everyone on their phones, and an AI host running the games.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request: the CSP nonce is per request, and config is read at runtime.
  await connection();
  const env = serverEnv();
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <SupabaseProvider url={env.browserSupabaseUrl} publishableKey={env.supabaseKey}>
          {children}
        </SupabaseProvider>
      </body>
    </html>
  );
}
