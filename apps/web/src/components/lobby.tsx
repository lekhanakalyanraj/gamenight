import type { ReactNode } from "react";

import { Avatar } from "@/components/game/parts";
import { AGE_LABEL, type LobbyMember, type LobbyRoom, MIN_PLAYERS } from "@/lib/room";
import { topicClass } from "@/lib/topics";

export function AgeBadge({ rating }: { rating: LobbyRoom["age_rating"] }) {
  const tone = rating === "adult" ? "border-danger text-danger" : "border-ink text-foreground";
  return <span className={`caps border px-2 py-1 text-xs ${tone}`}>{AGE_LABEL[rating]}</span>;
}

/** "4 / 16 players · 3 needed to start" */
export function PlayerCount({ count, max }: { count: number; max: number }) {
  const short = Math.max(0, MIN_PLAYERS - count);
  return (
    <span>
      <span className="font-mono">{count}/{max}</span> players
      {short > 0 ? <span className="text-muted"> · {short} more needed to start</span> : null}
    </span>
  );
}

/** One player as a spec-sheet row: their square, their name, and whether their phone is here. */
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
      className={`flex items-center gap-4 border-b border-border transition-opacity ${big ? "py-4" : "py-3"} ${online ? "" : "opacity-40"}`}
    >
      <Avatar id={member.id} name={member.nickname} size={big ? 64 : 40} live={isMe} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`truncate ${big ? "text-3xl" : "text-lg"}`}>
          {member.nickname}
          {isMe ? <span className="text-muted"> (you)</span> : null}
        </span>
        <span className={`text-muted ${big ? "text-lg" : "text-xs"}`}>
          {member.topic ? (
            <span data-testid="player-topic">quiz topic: <span className={topicClass(member.topic)}>{member.topic}</span></span>
          ) : null}
          {member.topic && member.interests?.length ? " · " : null}
          {member.interests?.length ? (
            <span data-testid="player-interests">into {member.interests.map((i, n) => (
              <span key={i}>{n > 0 ? ", " : ""}<span className={topicClass(i)}>{i}</span></span>
            ))}</span>
          ) : null}
        </span>
      </span>
      <span className={`caps flex items-center gap-2 text-muted ${big ? "text-base" : "text-xs"}`}>
        {member.role === "host" ? "Host" : online ? "Here" : "Phone disconnected"}
        <span aria-hidden className={`inline-block ${big ? "size-3" : "size-2"} ${online ? "bg-ink" : "border border-ink"}`} />
      </span>
      {children}
    </li>
  );
}

/** A full-screen message for rooms that have ended for this device. */
export function RoomEnded({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 py-10">
      <h1 role="status" className="border-t border-ink pt-4 text-3xl">{title}</h1>
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
      className={`flex items-baseline border-l-2 border-accent ${big ? "gap-6 py-2 pr-[20rem] pl-6 text-4xl leading-tight" : "gap-3 py-1 pl-3 text-base"}`}
    >
      <span className={`caps shrink-0 text-muted ${big ? "text-lg" : "text-[11px]"}`}>AI host</span>
      <span>{text}</span>
    </p>
  );
}
