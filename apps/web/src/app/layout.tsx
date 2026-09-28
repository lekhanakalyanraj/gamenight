import type { Metadata } from "next";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { serverEnv } from "@/lib/env";
import { SupabaseProvider } from "@/lib/supabase/client";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "gamenight",
  description: "A room on the TV, everyone on their phones, and an AI host running the games.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request: the CSP nonce is per request, and config is read at runtime.
  await connection();
  const env = serverEnv();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <SupabaseProvider url={env.browserSupabaseUrl} publishableKey={env.supabaseKey}>
          {children}
        </SupabaseProvider>
      </body>
    </html>
  );
}
