import type { ReactNode } from "react";

import { AGE_LABEL, initials, type LobbyMember, type LobbyRoom, MIN_PLAYERS, tileColour } from "@/lib/room";

export function AgeBadge({ rating }: { rating: LobbyRoom["age_rating"] }) {
  const tone = rating === "adult" ? "border-danger/60 text-danger" : "border-border text-muted";
  return <span className={`rounded-full border px-3 py-1 text-sm font-medium ${tone}`}>{AGE_LABEL[rating]}</span>;
}

/** "4 / 16 players · 3 needed to start" */
export function PlayerCount({ count, max }: { count: number; max: number }) {
  const short = Math.max(0, MIN_PLAYERS - count);
  return (
    <span>
      {count} / {max} players
      {short > 0 ? <span className="text-muted"> · {short} more needed to start</span> : null}
    </span>
  );
}

export function PlayerTile({ member, online, size = "phone", isMe = false, children }: {
  member: LobbyMember;
  online: boolean;
  size?: "phone" | "tv";
  isMe?: boolean;
  children?: ReactNode;
}) {
  const big = size === "tv";
  return (
    <li
      data-testid="player"
      data-nickname={member.nickname}
      data-online={online}
      className={`flex items-center gap-3 rounded-2xl border border-border bg-surface transition-opacity ${
        big ? "p-4" : "p-3"
      } ${online ? "" : "opacity-45"}`}
    >
      <span
        aria-hidden
        className={`relative grid shrink-0 place-items-center rounded-full font-semibold text-white ${tileColour(member.id)} ${
          big ? "size-16 text-2xl" : "size-10 text-sm"
        }`}
      >
        {initials(member.nickname)}
        <span
          className={`absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-surface ${big ? "size-5" : "size-3.5"} ${
            online ? "bg-[#2bb673]" : "bg-muted/60"
          }`}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate font-medium ${big ? "text-2xl" : ""}`}>
          {member.nickname}
          {isMe ? <span className="text-muted"> (you)</span> : null}
        </span>
        <span className={`text-muted ${big ? "text-base" : "text-xs"}`}>
          {member.role === "host" ? "Host" : online ? "Here" : "Phone disconnected"}
          {member.topic ? <span data-testid="player-topic"> · quiz topic: {member.topic}</span> : null}
        </span>
      </span>
      {children}
    </li>
  );
}

/** A full-screen message for rooms that have ended for this device. */
export function RoomEnded({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-5 py-10 text-center">
      <h1 role="status" className="text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

/** What the AI host last said. Labelled as AI, always (EU AI Act Article 50 transparency). */
export function HostCaption({ text, size = "phone" }: { text: string | null; size?: "phone" | "tv" }) {
  if (!text) return null;
  const big = size === "tv";
  return (
    <p
      data-testid="host-line"
      aria-live="polite"
      className={`flex items-baseline gap-3 rounded-2xl border border-accent/40 bg-surface-2 ${big ? "px-6 py-4 text-3xl" : "px-3 py-2 text-sm"}`}
    >
      <span className={`shrink-0 rounded-full bg-accent font-medium text-accent-ink ${big ? "px-3 py-1 text-lg" : "px-2 text-xs"}`}>
        AI host
      </span>
      <span>{text}</span>
    </p>
  );
}
