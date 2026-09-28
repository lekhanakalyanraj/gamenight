// Pure helpers for the Agent Server proxy (app/api/agents), kept separate so they're easy to test.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The only Agent Server endpoints a host's chat needs: one room thread, its state, and its runs. */
const ALLOWED = new RegExp(`^threads/(${UUID})(?:/(?:state|history|runs/stream|runs/${UUID}/(?:stream|join|cancel)))?$`);

export function allowedThread(path: string): string | null {
  return ALLOWED.exec(path)?.[1] ?? null;
}

export const MAX_CHAT_MESSAGE = 1000;

/**
 * Rebuilds a run request from scratch: the graph, the queueing and the input are ours, and the only
 * thing taken from the browser is the host's text (as human messages) plus streaming options. So a
 * browser can't start other graphs, pass config, or pose as a database event.
 */
export function sanitizeRunRequest(body: unknown, traceparent?: string): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const request = body as Record<string, unknown>;
  const input = request.input as { messages?: unknown } | null | undefined;
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const texts = messages.map((m) => {
    const message = m as { type?: unknown; role?: unknown; content?: unknown };
    const human = message.type === "human" || message.role === "user";
    return human && typeof message.content === "string" ? message.content.trim() : null;
  });
  if (texts.length === 0 || texts.length > 1 || texts.some((t) => !t || t.length > MAX_CHAT_MESSAGE)) return null;

  const streamMode = [request.stream_mode].flat().filter((m): m is string =>
    typeof m === "string" && ["values", "messages", "messages-tuple", "updates", "events"].includes(m),
  );
  return {
    assistant_id: "supervisor",
    input: { messages: [{ type: "human", content: texts[0] }] },
    stream_mode: streamMode.length > 0 ? streamMode : ["values", "messages-tuple"],
    stream_resumable: request.stream_resumable === true,
    on_disconnect: "continue",
    multitask_strategy: "enqueue", // queue behind lobby events on the same room thread
    // The agents continue this request's trace (services/agents telemetry.py).
    ...(traceparent ? { metadata: { traceparent } } : {}),
  };
}
