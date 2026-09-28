import type { Database } from "@gamenight/db-types";
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { serverEnv } from "@/lib/env";
import { securityHeaders } from "@/lib/security-headers";
import { AUTH_COOKIE } from "@/lib/supabase/cookie";

/**
 * Runs before every page: sets security headers with a fresh CSP nonce, refreshes the Supabase
 * session cookie, and keeps guests out of host pages. Authorization for data is enforced by
 * Postgres row-level security; this only handles navigation.
 */
export async function proxy(request: NextRequest) {
  const env = serverEnv();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const headers = securityHeaders({
    nonce,
    supabaseUrl: env.browserSupabaseUrl,
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https",
  });

  // Next.js reads the nonce from the request's CSP header and applies it to its own scripts.
  const forward = () => {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]);
    return NextResponse.next({ request: { headers: requestHeaders } });
  };
  const secure = (response: NextResponse) => {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };

  let response = forward();
  const supabase = createServerClient<Database>(env.supabaseUrl, env.supabaseKey, {
    cookieOptions: AUTH_COOKIE,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = forward();
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims() verifies the JWT and refreshes an expired session. Nothing may run between client creation and this call.
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (request.nextUrl.pathname.startsWith("/host") && (!claims || claims.is_anonymous)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "?next=/host";
    return secure(NextResponse.redirect(login));
  }

  return secure(response);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|healthz$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp3)$).*)"],
};
