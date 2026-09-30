/**
 * Security headers for every page, following Next.js 16's CSP guide: a fresh nonce per request,
 * 'strict-dynamic' for scripts, and nothing inline without that nonce.
 */
export function securityHeaders({ nonce, supabaseUrl, dev, https }: {
  nonce: string;
  /** The Supabase URL browsers use (REST, auth and the Realtime websocket). */
  supabaseUrl: string;
  dev: boolean;
  https: boolean;
}): Record<string, string> {
  const supabase = new URL(supabaseUrl);
  const realtime = `${supabase.protocol === "https:" ? "wss:" : "ws:"}//${supabase.host}`;

  const csp = [
    "default-src 'self'",
    // React needs eval in development only, for its debugging stacks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // The dev server's own overlay injects inline styles, and browsers ignore 'unsafe-inline' when a
    // nonce is present, so development relaxes styles only. Production is nonce-only (tested in e2e).
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    // data: is for the join QR code, which is rendered on the server as a data URL.
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // blob: is for the narrator's voice: the TV downloads each clip with its own login, then plays it.
    "media-src 'self' blob:",
    `connect-src 'self' ${supabase.origin} ${realtime}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only over https: on a home network the app runs over plain http (make lan).
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    // Cross-origin isolation without breaking anything: we embed no third-party resources.
    "Cross-Origin-Embedder-Policy": "credentialless",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(https ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" } : {}),
  };
}
