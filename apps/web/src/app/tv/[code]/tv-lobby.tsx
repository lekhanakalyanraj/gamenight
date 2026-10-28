"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AgeBadge, HostCaption, PlayerCount, PlayerTile, RoomEnded } from "@/components/lobby";
import { Narrator } from "@/components/narrator";
import { ButtonLink } from "@/components/ui";
import { useNow } from "@/lib/clock";
import { type Lobby, type TvCard, useDisplayEvents, useLiveRoom } from "@/lib/realtime";
import { activeMembers, latestHostLine, MIN_PLAYERS } from "@/lib/room";

// Client-only, like the phone's game screen: Motion's inline styles must not be server-rendered (strict CSP).
const TvGame = dynamic(() => import("@/components/game/tv-game"), {
  ssr: false,
  loading: () => <p className="caps p-12 text-2xl text-muted">Loading the game…</p>,
});
const TvHeadsUp = dynamic(() => import("@/components/game/headsup-tv"), {
  ssr: false,
  loading: () => <p className="caps p-12 text-2xl text-muted">Loading Heads Up…</p>,
});
const TvQuiz = dynamic(() => import("@/components/game/quiz-tv"), {
  ssr: false,
  loading: () => <p className="caps p-12 text-2xl text-muted">Loading the quiz…</p>,
});

/** How long the TV shows a finished game's reveal before going back to the lobby and its QR code. */
const REVEAL_SECONDS = 60;

export function TvLobby({ lobby, userId, joinUrl, qr }: {
  lobby: Lobby;
  userId: string;
  joinUrl: string;
  qr: string;
}) {
  const router = useRouter();
  const live = useLiveRoom(lobby, { kind: "tv" });
  const now = useNow(1000);
  // Heads Up's live card comes on this TV's own topic: the only screen in the room that ever gets it.
  const [card, setCard] = useState<TvCard | null>(null);
  useDisplayEvents(userId, { onUnpaired: () => router.replace("/tv"), onCard: setCard });

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

  // Above the lobby and the game alike, so the voice carries on as the TV switches between them.
  const narrator = <Narrator lines={live.hostLines} clips={live.clips} voiceOn={live.room.voice} />;
  const game = live.game;
  if (game && (game.game.phase !== "ended" || Date.parse(game.game.ended_at ?? "") > now - REVEAL_SECONDS * 1000)) {
    if (game.game.kind === "heads_up") return <>{narrator}<TvHeadsUp live={{ ...live, game }} pushed={card} /></>;
    const Screen = game.game.kind === "quiz" ? TvQuiz : TvGame;
    return <>{narrator}<Screen live={{ ...live, game }} /></>;
  }

  const players = activeMembers(live.members);
  const joinAddress = joinUrl.replace(/^https?:\/\//, "").replace(/\?.*$/, "");

  return (
    <>
    {narrator}
    <main className="flex min-h-dvh flex-col p-12">
    <header className="flex items-baseline justify-between border-b border-border pb-4">
      <span className="text-3xl tracking-tight">gamenight</span>
      <span className="flex items-center gap-6">
        <span className="caps text-lg text-muted">Lobby</span>
        <AgeBadge rating={live.room.age_rating} />
      </span>
    </header>
    <div className="grid flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-16 pt-10">
      <section className="flex flex-col justify-center gap-8 border-r border-border pr-16">
        <p className="caps text-xl text-muted">Room code</p>
        <p data-testid="room-code" className="numeral font-mono text-[6.5vw] tracking-[0.06em]">
          {live.room.code}
        </p>
        <div className="flex items-end gap-8">
          <Image
            src={qr}
            alt={`QR code to join room ${live.room.code}`}
            width={320}
            height={320}
            unoptimized
            className="size-[min(16vw,260px)]"
            data-testid="join-qr"
            data-join-url={joinUrl}
          />
          <p className="text-2xl text-muted">
            Scan to join, or go to <span className="block font-mono text-foreground">{joinAddress}</span>
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <header className="flex items-baseline justify-between gap-4 border-b border-ink pb-3">
          <h1 className="text-4xl">Players</h1>
          <p className="text-2xl">
            <PlayerCount count={players.length} max={live.room.max_players} />
          </p>
        </header>
        <ul className="grid grid-cols-2 content-start gap-x-10">
          {players.map((m) => (
            <PlayerTile key={m.id} member={m} online={live.online.has(m.id)} size="tv" />
          ))}
        </ul>
        <div className="mt-auto">
          <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} size="tv" />
        </div>
        <footer className="caps flex items-center justify-between border-t border-border pt-4 text-lg text-muted">
          <span>{players.length >= MIN_PLAYERS ? "Waiting for the host to start" : "Waiting for players to join"}</span>
          {!live.connected ? <span role="status">Reconnecting…</span> : null}
        </footer>
      </section>
    </div>
    </main>
    </>
  );
}
