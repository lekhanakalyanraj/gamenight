"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { AgeBadge, HostCaption, PlayerCount, PlayerTile, RoomEnded } from "@/components/lobby";
import { ButtonLink } from "@/components/ui";
import { useDisplayEvents, useLiveRoom } from "@/lib/realtime";
import {
  activeMembers,
  latestHostLine,
  type LobbyDisplay,
  type LobbyHostLine,
  type LobbyMember,
  type LobbyRoom,
  MIN_PLAYERS,
} from "@/lib/room";

export function TvLobby({ lobby, userId, joinUrl, qr }: {
  lobby: { room: LobbyRoom; members: LobbyMember[]; displays: LobbyDisplay[]; hostLines: LobbyHostLine[] };
  userId: string;
  joinUrl: string;
  qr: string;
}) {
  const router = useRouter();
  const live = useLiveRoom(lobby, { kind: "tv" });
  useDisplayEvents(userId, { onUnpaired: () => router.replace("/tv") });

  // Disconnected by the host, or the room is otherwise out of reach: go back to showing a pairing code.
  useEffect(() => {
    if (live.gone) router.replace("/tv");
  }, [live.gone, router]);

  if (live.room.status === "closed") {
    return (
      <RoomEnded title="The host closed this room">
        <ButtonLink href="/tv">Show a new TV code</ButtonLink>
      </RoomEnded>
    );
  }

  const players = activeMembers(live.members);
  const joinAddress = joinUrl.replace(/^https?:\/\//, "").replace(/\?.*$/, "");

  return (
    <main className="grid min-h-dvh grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-10 p-10">
      <section className="flex flex-col items-center justify-center gap-6 rounded-3xl bg-surface p-8 text-center">
        <p className="font-mono text-lg tracking-[0.4em] text-accent">GAMENIGHT</p>
        <Image
          src={qr}
          alt={`QR code to join room ${live.room.code}`}
          width={320}
          height={320}
          unoptimized
          className="size-[min(22vw,320px)] rounded-2xl"
          data-testid="join-qr"
          data-join-url={joinUrl}
        />
        <p className="text-xl text-muted">
          Scan to join, or go to <span className="font-mono text-foreground">{joinAddress}</span>
        </p>
        <p data-testid="room-code" className="font-mono text-[8vw] leading-none tracking-[0.15em] text-accent">
          {live.room.code}
        </p>
        <AgeBadge rating={live.room.age_rating} />
      </section>

      <section className="flex flex-col gap-6">
        <header className="flex items-baseline justify-between gap-4">
          <h1 className="text-4xl font-semibold">Players</h1>
          <p className="text-2xl">
            <PlayerCount count={players.length} max={live.room.max_players} />
          </p>
        </header>
        <ul className="grid grid-cols-2 content-start gap-4 xl:grid-cols-3">
          {players.map((m) => (
            <PlayerTile key={m.id} member={m} online={live.online.has(m.id)} size="tv" />
          ))}
        </ul>
        <div className="mt-auto">
          <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />
        </div>
        <footer className="flex items-center justify-between text-2xl text-muted">
          <span>{players.length >= MIN_PLAYERS ? "Waiting for the host to start" : "Waiting for players to join"}</span>
          {!live.connected ? <span role="status">Reconnecting…</span> : null}
        </footer>
      </section>
    </main>
  );
}
