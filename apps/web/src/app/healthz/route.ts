// Liveness for containers and load balancers. Deliberately independent of Supabase and config,
// and skipped by proxy.ts, so a database outage doesn't get the web container restarted.
export function GET() {
  return Response.json({ status: "ok", service: "web" });
}
