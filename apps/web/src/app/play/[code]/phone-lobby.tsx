"use client";

import dynamic from "next/dynamic";
import { useActionState, useState, useTransition } from "react";

import { StartGame } from "@/components/game/start-game";
import { useNow } from "@/lib/clock";
import { AgeBadge, HostCaption, PlayerCount, PlayerTile, RoomEnded } from "@/components/lobby";
import { Button, ButtonLink, Card, Field, Notice, Page } from "@/components/ui";
import { VoiceSwitch } from "@/components/voice-switch";
import { INTERESTS } from "@/lib/headsup";
import { type Lobby, useLiveRoom } from "@/lib/realtime";
import { activeMembers, latestHostLine, type LobbyDisplay, type LobbyMember } from "@/lib/room";
import type { FormState } from "@/lib/validate";

import { kickMember, leaveRoom, pairDisplay, removeDisplay } from "./actions";
import { setInterests, setTopic } from "./game-actions";
import { HostChat } from "./host-chat";

// The game screens animate with Motion, which sets inline styles; rendered only in the browser, those go
// through the CSSOM, which the nonce-only style CSP allows (server-rendered style attributes it would not).
const PhoneGame = dynamic(() => import("@/components/game/phone-game"), {
  ssr: false,
  loading: () => <p className="p-10 text-center text-muted">Loading the game…</p>,
});
const PhoneHeadsUp = dynamic(() => import("@/components/game/headsup-phone"), {
  ssr: false,
  loading: () => <p className="p-10 text-center text-muted">Loading Heads Up…</p>,
});
const PhoneQuiz = dynamic(() => import("@/components/game/quiz-phone"), {
  ssr: false,
  loading: () => <p className="p-10 text-center text-muted">Loading the quiz…</p>,
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
    const Screen = game.game.kind === "quiz" ? PhoneQuiz : game.game.kind === "heads_up" ? PhoneHeadsUp : PhoneGame;
    return <Screen live={{ ...live, game }} meId={meId} isHost={isHost} onBackToLobby={() => setLeftReveal(game.game.id)} />;
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

      {isHost ? <VoiceSwitch roomId={live.room.id} on={live.room.voice} /> : null}

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

      <TopicPicker roomId={live.room.id} topic={me?.topic ?? null} />

      <InterestsPicker roomId={live.room.id} interests={me?.interests ?? []} />

      {isHost ? (
        <StartGame roomId={live.room.id} players={players.length} topics={players.filter((m) => m.topic).length}
                   interests={players.filter((m) => m.interests?.length).length} />
      ) : null}

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

const TOPICS = ["Cricket", "Bollywood", "Food", "Music", "Science", "Geography"];

/** Your topic for Quiz Night: some questions will be about it, and credited to you on the TV. */
function TopicPicker({ roomId, topic }: { roomId: string; topic: string | null }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const pick = (value: string | null) => startTransition(async () => {
    const result = await setTopic(roomId, value);
    setError(result.error);
    if (!result.error) setText("");
  });

  return (
    <Card>
      <h2 className="mb-1 text-lg font-medium">Your Quiz Night topic</h2>
      <p className="mb-3 text-sm text-muted">
        {topic ? <>You picked <span data-testid="my-topic" className="text-foreground">{topic}</span>. Some questions will be about it.</> : "Pick something you know: some questions will be about it."}
      </p>
      <div role="group" aria-label="Quiz topics" className="mb-3 flex flex-wrap gap-2">
        {TOPICS.map((t) => (
          <button key={t} type="button" aria-pressed={topic?.toLowerCase() === t.toLowerCase()} disabled={pending}
                  onClick={() => pick(t)}
                  className={`h-9 rounded-full border px-3 text-sm transition ${topic?.toLowerCase() === t.toLowerCase() ? "border-accent bg-accent text-accent-ink" : "border-border bg-surface-2"}`}>
            {t}
          </button>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) pick(text); }}>
        <input aria-label="Your own topic" value={text} maxLength={30} onChange={(e) => setText(e.target.value)}
               placeholder="Or type your own" autoComplete="off"
               className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 outline-none focus:border-accent" />
        <Button type="submit" variant="secondary" disabled={pending || !text.trim()}>Pick</Button>
      </form>
      <Notice>{error}</Notice>
    </Card>
  );
}

/** Your Heads Up interests, up to three: the deck leans toward them. */
function InterestsPicker({ roomId, interests }: { roomId: string; interests: string[] }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const has = (i: string) => interests.some((x) => x.toLowerCase() === i.toLowerCase());
  const save = (next: string[]) => startTransition(async () => {
    const result = await setInterests(roomId, next);
    setError(result.error);
    if (!result.error) setText("");
  });
  const toggle = (i: string) => save(has(i) ? interests.filter((x) => x.toLowerCase() !== i.toLowerCase()) : [...interests, i]);
  const full = interests.length >= 3;

  return (
    <Card>
      <h2 className="mb-1 text-lg font-medium">Your Heads Up interests</h2>
      <p className="mb-3 text-sm text-muted">
        {interests.length
          ? <>You picked <span data-testid="my-interests" className="text-foreground">{interests.join(", ")}</span>{full ? "." : ". Pick up to three."}</>
          : "Pick up to three: the cards will lean toward them."}
      </p>
      <div role="group" aria-label="Heads Up interests" className="mb-3 flex flex-wrap gap-2">
        {INTERESTS.map((i) => (
          <button key={i} type="button" aria-pressed={has(i)} disabled={pending || (full && !has(i))}
                  onClick={() => toggle(i)}
                  className={`h-9 rounded-full border px-3 text-sm transition disabled:opacity-40 ${has(i) ? "border-accent bg-accent text-accent-ink" : "border-border bg-surface-2"}`}>
            {i}
          </button>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !full) save([...interests, text]); }}>
        <input aria-label="Your own interest" value={text} maxLength={30} onChange={(e) => setText(e.target.value)}
               placeholder={full ? "Three picked" : "Or type your own"} autoComplete="off" disabled={full}
               className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 outline-none focus:border-accent disabled:opacity-50" />
        <Button type="submit" variant="secondary" disabled={pending || full || !text.trim()}>Add</Button>
      </form>
      <Notice>{error}</Notice>
    </Card>
  );
}
