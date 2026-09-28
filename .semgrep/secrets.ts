// Test cases for secrets.yml. Run with `make semgrep-test`.

// ok: gamenight.no-secret-in-public-env
export const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
// ok: gamenight.no-secret-in-public-env
export const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
// ruleid: gamenight.no-secret-in-public-env
export const leaked = process.env.NEXT_PUBLIC_ELEVENLABS_SECRET;

// ruleid: gamenight.no-rls-bypass-key
export const admin = process.env.SUPABASE_SERVICE_ROLE_KEY;
// ruleid: gamenight.no-rls-bypass-key
export const client = createClient(url, "service_role");

// ok: gamenight.no-rls-bypass-key
// We never use the service_role key; this comment is fine.
export const anonKey = publishable;

declare function createClient(url: string | undefined, key: string): unknown;
