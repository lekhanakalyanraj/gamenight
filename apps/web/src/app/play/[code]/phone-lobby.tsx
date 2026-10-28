"use client";

import dynamic from "next/dynamic";
import { useActionState, useState, useTransition } from "react";

import { StartGame } from "@/components/game/start-game";
import { useNow } from "@/lib/clock";
import { AgeBadge, HostCaption, PlayerCount, PlayerTile, RoomEnded } from "@/components/lobby";
import { Button, ButtonLink, Card, Field, Label, Notice, Page } from "@/components/ui";
import { VoiceSwitch } from "@/components/voice-switch";
import { type Lobby, useLiveRoom } from "@/lib/realtime";
import { activeMembers, latestHostLine, type LobbyDisplay, type LobbyMember } from "@/lib/room";
import { CONTEXT_MAX, INTEREST_SUGGESTIONS, SUGGESTIONS, topicClass } from "@/lib/topics";
import type { FormState } from "@/lib/validate";

import { kickMember, leaveRoom, pairDisplay, removeDisplay } from "./actions";
import { setInterests, setTopic } from "./game-actions";
import { HostChat } from "./host-chat";

// The game screens animate with Motion, which sets inline styles; rendered only in the browser, those go
// through the CSSOM, which the nonce-only style CSP allows (server-rendered style attributes it would not).
const PhoneGame = dynamic(() => import("@/components/game/phone-game"), {
  ssr: false,
  loading: () => <p className="caps p-10 text-xs text-muted">Loading the game…</p>,
});
const PhoneHeadsUp = dynamic(() => import("@/components/game/headsup-phone"), {
  ssr: false,
  loading: () => <p className="caps p-10 text-xs text-muted">Loading Heads Up…</p>,
});
const PhoneQuiz = dynamic(() => import("@/components/game/quiz-phone"), {
  ssr: false,
  loading: () => <p className="caps p-10 text-xs text-muted">Loading the quiz…</p>,
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
    <Page wide>
      <header className="flex flex-col gap-4 md:col-span-2">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-3">
          <span className="text-lg tracking-tight">gamenight</span>
          <AgeBadge rating={live.room.age_rating} />
        </div>
        <Label>Room</Label>
        <h1 className="numeral -mt-2 font-mono text-6xl tracking-[0.12em]">{live.room.code}</h1>
        <p className="text-sm text-muted">
          You&apos;re in as <span className="text-foreground">{me?.nickname}</span>
        </p>
      </header>

      <div className="md:col-span-2"><HostCaption text={latestHostLine(live.hostLines)?.text ?? null} /></div>

      {isHost ? <HostChat roomId={live.room.id} /> : null}

      {isHost ? <TvPanel roomId={live.room.id} displays={live.displays} tvOnline={live.tvOnline} /> : null}

      {isHost ? <VoiceSwitch roomId={live.room.id} on={live.room.voice} /> : null}

      <Card label={<span className="flex justify-between gap-3"><span>Players</span><span className="normal-case tracking-normal"><PlayerCount count={players.length} max={live.room.max_players} /></span></span>}>
        <ul className="-mt-2 flex flex-col">
          {players.map((m) => (
            <PlayerTile key={m.id} member={m} online={live.online.has(m.id)} isMe={m.id === meId}>
              {isHost && m.id !== meId ? <RemovePlayer member={m} /> : null}
            </PlayerTile>
          ))}
        </ul>
      </Card>

      <TopicPicker roomId={live.room.id} topic={me?.topic ?? null} context={me?.topic_context ?? null} />

      <InterestsPicker roomId={live.room.id} interests={me?.interests ?? []} context={me?.interests_context ?? null} />

      {isHost ? (
        <div className="md:col-span-2">
          <StartGame roomId={live.room.id} players={players.length} topics={players.filter((m) => m.topic).length}
                     interests={players.filter((m) => m.interests?.length).length} />
        </div>
      ) : null}

      <p className="caps text-xs text-muted md:col-span-2">
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
    <Card label="Connect a TV">
      <p className="-mt-2 text-sm text-muted">Open this site&apos;s /tv page on the TV, then enter the code it shows.</p>
      <form action={action} className="flex items-end gap-2">
        <div className="flex-1">
          <Field
            label="TV code"
            name="tv_code"
            defaultValue={state.values?.tv_code}
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={6}
            className="h-12 w-full border border-ink bg-surface px-3 font-mono text-lg tracking-[0.3em] uppercase outline-none"
            required
          />
        </div>
        <Button type="submit" disabled={pending}>{pending ? "Connecting..." : "Connect"}</Button>
      </form>
      <div className="flex flex-col gap-2">
        <Notice>{state.error ?? error}</Notice>
        <Notice tone="info">{state.notice}</Notice>
      </div>
      {displays.length > 0 ? (
        <ul className="flex flex-col border-t border-border">
          {displays.map((d) => (
            <li key={d.id} data-testid="display" className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm">
              <span>
                TV connected {tvOnline ? <span className="text-ok">· on screen</span> : <span className="text-muted">· offline</span>}
              </span>
              <Button
                variant="secondary"
                className="h-10 px-3 text-sm"
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
      <Button variant="secondary" className="h-10 px-3 text-sm" onClick={() => setConfirming(true)} aria-label={`Remove ${member.nickname}`}>
        Remove
      </Button>
    );
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex gap-2">
        <Button
          className="h-10 px-3 text-sm"
          disabled={pending}
          onClick={() => startTransition(async () => setError((await kickMember(member.id)).error))}
          aria-label={`Confirm removing ${member.nickname}`}
        >
          Remove
        </Button>
        <Button variant="secondary" className="h-10 px-3 text-sm" onClick={() => setConfirming(false)}>Cancel</Button>
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
    <Card>
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

/**
 * A suggestion to tap. Picked, its name shows in its theme's colour with a filled mark: colour is the cue for what
 * you picked, the mark and aria-pressed say it without colour.
 */
function Chip({ name, picked, disabled, onClick }: { name: string; picked: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={picked} disabled={disabled} onClick={onClick}
            className={`flex h-10 items-center gap-2 border px-3 text-sm transition disabled:opacity-30 ${picked ? `border-ink bg-surface ${topicClass(name)}` : "border-border hover:border-ink"}`}>
      <span aria-hidden className={`size-2 ${picked ? "bg-current" : "border border-current opacity-40"}`} />
      {name}
    </button>
  );
}

/** How many suggestions show before "More": the rest are a tap away, so the lobby isn't a wall of chips. */
const FIRST_CHIPS = 8;

/** The suggestions as chips: the first few, any you've picked, and the rest behind "More". */
function Chips({ label, names, picked, disabled, onPick }: {
  label: string;
  names: readonly string[];
  picked: (name: string) => boolean;
  disabled: (name: string) => boolean;
  onPick: (name: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? names : names.filter((n, i) => i < FIRST_CHIPS || picked(n));
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {shown.map((n) => <Chip key={n} name={n} picked={picked(n)} disabled={disabled(n)} onClick={() => onPick(n)} />)}
      {shown.length < names.length ? (
        <button type="button" onClick={() => setAll(true)} className="caps h-10 px-2 text-xs text-muted underline-offset-4 hover:underline">
          More ({names.length - shown.length})
        </button>
      ) : null}
    </div>
  );
}

/**
 * "Say more": a line on what you're into, for the writer of your questions or cards ("One Piece and Jujutsu
 * Kaisen"). Saved with your pick; saved again on its own once you've picked.
 */
function Describe({ label, placeholder, saved, value, onChange, onSave, canSave, pending }: {
  label: string;
  placeholder: string;
  saved: string | null;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  canSave: boolean;
  pending: boolean;
}) {
  const changed = value.trim() !== (saved ?? "");
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (canSave && changed) onSave(); }}>
      <label className="flex flex-col gap-2">
        <span className="caps text-xs text-muted">{label}</span>
        <textarea value={value} maxLength={CONTEXT_MAX} rows={2} placeholder={placeholder}
                  onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))}
                  className="min-h-16 resize-none border border-ink bg-surface px-3 py-2 outline-none" />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-muted">{value.length}/{CONTEXT_MAX}</span>
        {canSave ? (
          <Button type="submit" variant="secondary" className="h-10 px-3 text-sm" disabled={pending || !changed}>
            {saved && !changed ? "Saved" : "Save"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Your topic for Quiz Night, in a word and, if you like, a line: some questions will be about it, credited to you. */
function TopicPicker({ roomId, topic, context }: { roomId: string; topic: string | null; context: string | null }) {
  const [text, setText] = useState("");
  const [about, setAbout] = useState(context ?? "");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const pick = (value: string | null) => startTransition(async () => {
    const result = await setTopic(roomId, value, about);
    setError(result.error);
    if (!result.error) setText("");
  });

  return (
    <Card label="Your Quiz Night topic">
      <p className="-mt-2 text-sm text-muted">
        {topic
          ? <>You picked <span data-testid="my-topic" className={topicClass(topic)}>{topic}</span>. Some questions will be about it.</>
          : "Pick something you know, or describe it: some questions will be about it."}
      </p>
      <Chips label="Quiz topics" names={SUGGESTIONS.map((t) => t.name)} onPick={pick} disabled={() => pending}
             picked={(n) => topic?.toLowerCase() === n.toLowerCase()} />
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) pick(text); }}>
        <input aria-label="Your own topic" value={text} maxLength={30} onChange={(e) => setText(e.target.value)}
               placeholder="Or type your own" autoComplete="off"
               className="h-12 min-w-0 flex-1 border border-ink bg-surface px-3 outline-none" />
        <Button type="submit" variant="secondary" disabled={pending || !text.trim()}>Pick</Button>
      </form>
      <Describe label="Say more about your topic (optional)" placeholder="90s Bollywood songs and SRK films" saved={context}
                value={about} onChange={setAbout} canSave={Boolean(topic)} pending={pending}
                onSave={() => topic && pick(topic)} />
      <Notice>{error}</Notice>
    </Card>
  );
}

/** Your Heads Up interests, up to three, and a line about them: the deck leans toward them. */
function InterestsPicker({ roomId, interests, context }: { roomId: string; interests: string[]; context: string | null }) {
  const [text, setText] = useState("");
  const [about, setAbout] = useState(context ?? "");
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const has = (i: string) => interests.some((x) => x.toLowerCase() === i.toLowerCase());
  const save = (next: string[]) => startTransition(async () => {
    const result = await setInterests(roomId, next, about);
    setError(result.error);
    if (!result.error) setText("");
  });
  const toggle = (i: string) => save(has(i) ? interests.filter((x) => x.toLowerCase() !== i.toLowerCase()) : [...interests, i]);
  const full = interests.length >= 3;

  return (
    <Card label="Your Heads Up interests">
      <p className="-mt-2 text-sm text-muted">
        {interests.length
          ? <>You picked <span data-testid="my-interests">{interests.map((i, n) => (
              <span key={i}>{n > 0 ? ", " : ""}<span className={topicClass(i)}>{i}</span></span>
            ))}</span>{full ? "." : ". Pick up to three."}</>
          : "Pick up to three: the cards will lean toward them."}
      </p>
      <Chips label="Heads Up interests" names={INTEREST_SUGGESTIONS.map((i) => i.name)} onPick={toggle} picked={has}
             disabled={(n) => pending || (full && !has(n))} />
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !full) save([...interests, text]); }}>
        <input aria-label="Your own interest" value={text} maxLength={30} onChange={(e) => setText(e.target.value)}
               placeholder={full ? "Three picked" : "Or type your own"} autoComplete="off" disabled={full}
               className="h-12 min-w-0 flex-1 border border-ink bg-surface px-3 outline-none disabled:opacity-40" />
        <Button type="submit" variant="secondary" disabled={pending || full || !text.trim()}>Add</Button>
      </form>
      <Describe label="Say more about your interests (optional)" placeholder="One Piece, and F1 in the Verstappen era"
                saved={context}
                value={about} onChange={setAbout} canSave={interests.length > 0} pending={pending}
                onSave={() => save(interests)} />
      <Notice>{error}</Notice>
    </Card>
  );
}
