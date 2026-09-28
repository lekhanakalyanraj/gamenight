import type { NextRequest } from "next/server";

import { allowedThread, sanitizeRunRequest } from "@/lib/agents-proxy";
import { agentsEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * The only way browsers reach the Agent Server, which stays private. Checks the caller is the signed-in
 * host of the room whose thread they want (thread id = room id), then forwards with the internal service
 * token and the host's own login, which the Agent Server verifies again (services/agents auth.py).
 */
async function proxy(request: NextRequest, { params }: RouteContext<"/api/agents/[...path]">) {
  const path = (await params).path.join("/");
  const roomId = allowedThread(path);
  if (!roomId) return Response.json({ error: "not found" }, { status: 404 });

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims || claims.is_anonymous) return Response.json({ error: "sign in as the host" }, { status: 401 });

  const { data: room } = await supabase
    .from("rooms")
    .select("id")
    .eq("id", roomId)
    .eq("host_id", claims.sub)
    .neq("status", "closed")
    .maybeSingle();
  if (!room) return Response.json({ error: "only the room's host can chat with its AI host" }, { status: 403 });

  let body: string | undefined;
  if (path.endsWith("/runs/stream")) {
    const run = sanitizeRunRequest(await request.json().catch(() => null));
    if (!run) return Response.json({ error: "send one message of up to 1000 characters" }, { status: 400 });
    body = JSON.stringify(run);
  } else if (request.method !== "GET") {
    body = await request.text();
  }

  const { data: session } = await supabase.auth.getSession();
  const agents = agentsEnv();
  const headers = {
    "content-type": "application/json",
    "x-gamenight-service-token": agents.serviceToken,
    authorization: `Bearer ${session.session?.access_token ?? ""}`,
  };

  // The room's thread may not exist yet (no one has joined); creating it is idempotent.
  await fetch(`${agents.url}/threads`, {
    method: "POST",
    headers,
    body: JSON.stringify({ thread_id: roomId, if_exists: "do_nothing", metadata: { room_id: roomId } }),
  });

  const upstream = await fetch(`${agents.url}/${path}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });
  // Pass the stream straight through: no buffering, so tokens reach the phone as they're generated.
  const passthrough = new Headers({ "cache-control": "no-store", "x-accel-buffering": "no" });
  for (const name of ["content-type", "content-location"]) {
    const value = upstream.headers.get(name);
    if (value) passthrough.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: passthrough });
}

export { proxy as DELETE, proxy as GET, proxy as POST };
