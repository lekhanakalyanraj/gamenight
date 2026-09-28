"use client";

import { useStream } from "@langchain/langgraph-sdk/react";
import { type FormEvent, useState, useSyncExternalStore } from "react";

import { Button, Card, Notice } from "@/components/ui";

const MAX_MESSAGE = 1000;
const noSubscription = () => () => {};

type ChatMessage = { id?: string; type: string; content: unknown };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : "")).join("");
  }
  return "";
}

/** The host's private chat with the AI host. Streams through the web app's proxy (app/api/agents). */
export function HostChat({ roomId }: { roomId: string }) {
  // The SDK needs an absolute URL, which only exists in the browser (null while rendering on the server).
  const origin = useSyncExternalStore(noSubscription, () => window.location.origin, () => null);
  if (!origin) return null;
  return <Chat apiUrl={`${origin}/api/agents`} roomId={roomId} />;
}

function Chat({ apiUrl, roomId }: { apiUrl: string; roomId: string }) {
  const [draft, setDraft] = useState("");
  const stream = useStream<{ messages: ChatMessage[] }>({
    apiUrl,
    assistantId: "supervisor",
    threadId: roomId, // one thread per room, enforced by the proxy and the Agent Server
    messagesKey: "messages",
  });

  const messages = (stream.messages as ChatMessage[]).filter(
    (m) => (m.type === "human" || m.type === "ai") && text(m.content).trim() !== "",
  );

  function send(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || stream.isLoading) return;
    setDraft("");
    void stream.submit({ messages: [{ type: "human", content: message }] });
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Ask the AI host</h2>
      {messages.length === 0 ? (
        <p className="text-sm text-muted">Ask what to play, how a game works, or have it announce something on the TV.</p>
      ) : (
        <ol data-testid="host-chat" className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-live="polite">
          {messages.map((m, i) => (
            <li
              key={m.id ?? i}
              data-from={m.type}
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                m.type === "human" ? "self-end bg-accent text-accent-ink" : "self-start bg-surface-2"
              }`}
            >
              {text(m.content)}
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={send} className="flex gap-2">
        <input
          aria-label="Message to the AI host"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_MESSAGE}
          placeholder="What should we play?"
          className="h-11 flex-1 rounded-xl border border-border bg-background px-3 text-base outline-none placeholder:text-muted/60 focus:border-accent"
        />
        <Button type="submit" disabled={stream.isLoading || !draft.trim()}>
          {stream.isLoading ? "…" : "Send"}
        </Button>
      </form>
      <Notice>{stream.error ? "The AI host couldn't answer. Try again in a moment." : null}</Notice>
    </Card>
  );
}
