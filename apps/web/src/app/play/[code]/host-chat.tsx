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
  // While a reply streams in, the last message is the host's, growing; before its first token, it's still yours.
  const last = messages.at(-1);
  const streaming = stream.isLoading && last?.type === "ai";
  const thinking = stream.isLoading && last?.type !== "ai";

  function send(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || stream.isLoading) return;
    setDraft("");
    void stream.submit({ messages: [{ type: "human", content: message }] });
  }

  return (
    <Card label="Ask the AI host">
      {messages.length === 0 && !thinking ? (
        <p className="-mt-2 text-sm text-muted">Ask what to play, how a game works, or have it announce something on the TV.</p>
      ) : (
        <ol data-testid="host-chat" className="flex max-h-72 flex-col overflow-y-auto border-t border-border" aria-live="polite">
          {messages.map((m, i) => (
            <li key={m.id ?? i} className="grid grid-cols-[4.5rem_1fr] gap-2 border-b border-border py-2 text-sm">
              <span className={`caps pt-0.5 text-[11px] ${m.type === "human" ? "text-muted" : "text-foreground"}`}>
                {m.type === "human" ? "You" : "AI host"}
              </span>
              <span data-from={m.type}>
                {text(m.content)}
                {streaming && i === messages.length - 1 ? <span aria-hidden className="chat-cursor" /> : null}
              </span>
            </li>
          ))}
          {thinking ? (
            <li data-testid="host-thinking" className="grid grid-cols-[4.5rem_1fr] gap-2 border-b border-border py-2 text-sm">
              <span className="caps pt-0.5 text-[11px]">AI host</span>
              <span className="text-muted">Thinking<span aria-hidden className="chat-cursor" /></span>
            </li>
          ) : null}
        </ol>
      )}
      <form onSubmit={send} className="flex gap-2">
        <input
          aria-label="Message to the AI host"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_MESSAGE}
          placeholder="What should we play?"
          className="h-12 min-w-0 flex-1 border border-ink bg-surface px-3 text-base outline-none placeholder:text-muted/60"
        />
        <Button type="submit" disabled={stream.isLoading || !draft.trim()}>
          {stream.isLoading ? "…" : "Send"}
        </Button>
      </form>
      <Notice>{stream.error ? "The AI host couldn't answer. Try again in a moment." : null}</Notice>
    </Card>
  );
}
