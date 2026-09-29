"use client";

import dynamic from "next/dynamic";
import { useActionState, useState, useTransition } from "react";

import { StartGame } from "@/components/game/start-game";
import { useNow } from "@/lib/clock";
import { AgeBadge, HostCaption, PlayerCount, PlayerTile, RoomEnded } from "@/components/lobby";
import { Button, ButtonLink, Card, Field, Notice, Page } from "@/components/ui";
import { type Lobby, useLiveRoom } from "@/lib/realtime";
import { activeMembers, latestHostLine, type LobbyDisplay, type LobbyMember } from "@/lib/room";
import type { FormState } from "@/lib/validate";

import { kickMember, leaveRoom, pairDisplay, removeDisplay } from "./actions";
import { HostChat } from "./host-chat";

// The game screens animate with Motion, which sets inline styles; rendered only in the browser, those go
// through the CSSOM, which the nonce-only style CSP allows (server-rendered style attributes it would not).
const PhoneGame = dynamic(() => import("@/components/game/phone-game"), {
  ssr: false,
  loading: () => <p className="p-10 text-center text-muted">Loading the game…</p>,
});

/** An ended game stays on screen until you leave its reveal, or for 10 minutes after a reload. */
const REVEAL_MINUTES = 10;

export function PhoneLobby({ lobby, meId, isHost }: { lobby: Lobby; meId: string; isHost: boolean }) {
  const live = useLiveRoom(lobby, { member_id: meId });
  const me = live.members.find((m) => m.id === meId);
  const [leftReveal, setLeftReveal] = useState<string | null>(null);
  const now = useNow(10_000);

  if (me?.removed_by_host) {
    return (
      <RoomEnded title="The host removed you from this room">
        <ButtonLink href="/">Back to the start</ButtonLink>
      </RoomEnded>
    );
  }
  if (live.room.status === "closed") {
    return (
      <RoomEnded title="The host closed this room">
        <ButtonLink href={isHost ? "/host" : "/"}>{isHost ? "Back to your rooms" : "Back to the start"}</ButtonLink>
      </RoomEnded>
    );
  }
  if (live.gone || me?.left_at) {
    return (
      <RoomEnded title="You're no longer in this room">
        <ButtonLink href="/">Back to the start</ButtonLink>
      </RoomEnded>
    );
  }

  const game = live.game;
  const showGame = game && (game.game.phase !== "ended"
    || (leftReveal !== game.game.id && Date.parse(game.game.ended_at ?? "") > now - REVEAL_MINUTES * 60_000));
  if (game && showGame) {
    return <PhoneGame live={{ ...live, game }} meId={meId} isHost={isHost} onBackToLobby={() => setLeftReveal(game.game.id)} />;
  }

  const players = activeMembers(live.members);

  return (
    <Page>
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted">Room</p>
          <h1 className="font-mono text-4xl tracking-[0.3em] text-accent">{live.room.code}</h1>
          <p className="text-sm text-muted">
            You&apos;re in as <span className="text-foreground">{me?.nickname}</span>
          </p>
        </div>
        <AgeBadge rating={live.room.age_rating} />
      </header>

      <HostCaption text={latestHostLine(live.hostLines)?.text ?? null} />

      {isHost ? <HostChat roomId={live.room.id} /> : null}

      {isHost ? <TvPanel roomId={live.room.id} displays={live.displays} tvOnline={live.tvOnline} /> : null}

      <Card>
        <h2 className="mb-3 flex items-baseline justify-between gap-3 text-lg font-medium">
          Players
          <span className="text-sm font-normal"><PlayerCount count={players.length} max={live.room.max_players} /></span>
        </h2>
        <ul className="flex flex-col gap-2">
          {players.map((m) => (
            <PlayerTile key={m.id} member={m} online={live.online.has(m.id)} isMe={m.id === meId}>
              {isHost && m.id !== meId ? <RemovePlayer member={m} /> : null}
            </PlayerTile>
          ))}
        </ul>
      </Card>

      {isHost ? <StartGame roomId={live.room.id} players={players.length} /> : null}

      <p className="text-center text-sm text-muted">
        {isHost ? null : "Waiting for the host to start."}
        {!live.connected ? <span role="status"> Reconnecting…</span> : null}
      </p>

      <LeaveRoom roomId={live.room.id} isHost={isHost} />
    </Page>
  );
}

function TvPanel({ roomId, displays, tvOnline }: { roomId: string; displays: LobbyDisplay[]; tvOnline: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(pairDisplay.bind(null, roomId), {});
  const [error, setError] = useState<string>();
  const [removing, startRemoving] = useTransition();

  return (
    <Card>
      <h2 className="mb-1 text-lg font-medium">Connect a TV</h2>
      <p className="mb-4 text-sm text-muted">Open this site&apos;s /tv page on the TV, then enter the code it shows.</p>
      <form action={action} className="flex items-end gap-2">
        <div className="flex-1">
          <Field
            label="TV code"
            name="tv_code"
            defaultValue={state.values?.tv_code}
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={6}
            className="h-11 w-full rounded-xl border border-border bg-background px-3 font-mono text-lg tracking-[0.3em] uppercase outline-none focus:border-accent"
            required
          />
        </div>
        <Button type="submit" disabled={pending}>{pending ? "Connecting..." : "Connect"}</Button>
      </form>
      <div className="mt-3 flex flex-col gap-2">
        <Notice>{state.error ?? error}</Notice>
        <Notice tone="info">{state.notice}</Notice>
      </div>
      {displays.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          {displays.map((d) => (
            <li key={d.id} data-testid="display" className="flex items-center justify-between gap-3 text-sm">
              <span>
                TV connected {tvOnline ? <span className="text-[#2bb673]">· on screen</span> : <span className="text-muted">· offline</span>}
              </span>
              <Button
                variant="secondary"
                className="h-9 text-sm"
                disabled={removing}
                onClick={() => startRemoving(async () => setError((await removeDisplay(d.id)).error))}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function RemovePlayer({ member }: { member: LobbyMember }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <Button variant="secondary" className="h-9 text-sm" onClick={() => setConfirming(true)} aria-label={`Remove ${member.nickname}`}>
        Remove
      </Button>
    );
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex gap-2">
        <Button
          className="h-9 text-sm"
          disabled={pending}
          onClick={() => startTransition(async () => setError((await kickMember(member.id)).error))}
          aria-label={`Confirm removing ${member.nickname}`}
        >
          Remove
        </Button>
        <Button variant="secondary" className="h-9 text-sm" onClick={() => setConfirming(false)}>Cancel</Button>
      </span>
      {error ? <span role="alert" className="text-xs text-danger">{error}</span> : null}
    </span>
  );
}

function LeaveRoom({ roomId, isHost }: { roomId: string; isHost: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const label = isHost ? "Close room" : "Leave room";

  if (!confirming) {
    return <Button variant="secondary" onClick={() => setConfirming(true)}>{label}</Button>;
  }
  return (
    <Card className="flex flex-col gap-3">
      <p>{isHost ? "Close the room for everyone?" : "Leave this room?"}</p>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={pending}
          onClick={() => startTransition(async () => setError((await leaveRoom(roomId)).error))}
        >
          {pending ? "..." : label}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={() => setConfirming(false)}>Cancel</Button>
      </div>
      <Notice>{error}</Notice>
    </Card>
  );
}
