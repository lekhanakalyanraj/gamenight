"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";

import { LOBBY_SELECT, type LobbyDisplay, type LobbyMember, type LobbyRoom } from "@/lib/room";
import { createClient } from "@/lib/supabase/client";

/** What each device announces on the room's presence channel. Never trusted for names or game logic. */
export type Presence = { member_id: string } | { kind: "tv" };

type Lobby = { room: LobbyRoom; members: LobbyMember[]; displays: LobbyDisplay[] };

export type LiveRoom = Lobby & {
  /** Member ids with a phone connected right now. */
  online: ReadonlySet<string>;
  tvOnline: boolean;
  connected: boolean;
  /** The room is no longer visible to us: removed, disconnected, or the room is gone. */
  gone: boolean;
};

/** The shape of rows broadcast by realtime.broadcast_changes (see the migrations). */
type Change = {
  table: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
};

function upsert<T extends { id: string }>(list: T[], row: T): T[] {
  return list.some((x) => x.id === row.id) ? list.map((x) => (x.id === row.id ? { ...x, ...row } : x)) : [...list, row];
}

function applyChange(lobby: Lobby, change: Change): Lobby {
  const row = change.record;
  const removedId = change.operation === "DELETE" ? (change.old_record?.id as string | undefined) : undefined;
  switch (change.table) {
    case "rooms":
      return row ? { ...lobby, room: { ...lobby.room, ...(row as Partial<LobbyRoom>), id: lobby.room.id } } : lobby;
    case "room_members":
      if (removedId) return { ...lobby, members: lobby.members.filter((m) => m.id !== removedId) };
      return row ? { ...lobby, members: upsert(lobby.members, row as LobbyMember) } : lobby;
    case "room_displays":
      if (removedId) return { ...lobby, displays: lobby.displays.filter((d) => d.id !== removedId) };
      return row ? { ...lobby, displays: upsert(lobby.displays, row as LobbyDisplay) } : lobby;
    default:
      return lobby;
  }
}

/**
 * Keeps a lobby live: database changes arrive as broadcasts on the private `room:{id}` topic, and
 * presence says who's connected. Every (re)subscribe refetches the room, so events missed while a
 * phone was offline are never lost: events are for speed, the refetch is for correctness.
 */
export function useLiveRoom(initial: Lobby, presence: Presence): LiveRoom {
  const [lobby, setLobby] = useState<Lobby>(initial);
  const [gone, setGone] = useState(false);
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());
  const [tvOnline, setTvOnline] = useState(false);
  const [connected, setConnected] = useState(false);
  const presenceRef = useRef(presence);
  const roomId = initial.room.id;

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    async function refetch() {
      const { data } = await supabase.from("rooms").select(LOBBY_SELECT).eq("id", roomId).maybeSingle();
      if (cancelled) return;
      if (!data) {
        setGone(true);
        return;
      }
      const { room_members, room_displays, ...room } = data;
      setLobby({ room, members: room_members, displays: room_displays });
    }

    async function subscribe() {
      await supabase.realtime.setAuth(); // private topics authorise with the signed-in user's JWT
      if (cancelled) return;
      const ch = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { enabled: true } } });
      channel = ch;
      ch.on("broadcast", { event: "*" }, ({ payload }) => setLobby((current) => applyChange(current, payload as Change)))
        .on("presence", { event: "sync" }, () => {
          const everyone = Object.values(ch.presenceState<Presence>()).flat();
          setOnline(new Set(everyone.flatMap((p) => ("member_id" in p ? [p.member_id] : []))));
          setTvOnline(everyone.some((p) => "kind" in p && p.kind === "tv"));
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            setConnected(true);
            await ch.track(presenceRef.current);
            await refetch();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setConnected(false);
          }
        });
    }

    void subscribe();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [roomId]);

  return { ...lobby, online, tvOnline, connected, gone };
}

/** A TV's own private topic: the database tells it when it's been paired to a room or disconnected. */
export function useDisplayEvents(
  userId: string | null,
  handlers: { onPaired?: (roomCode: string) => void; onUnpaired?: () => void },
) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    async function subscribe() {
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channel = supabase
        .channel(`display:${userId}`, { config: { private: true } })
        .on("broadcast", { event: "paired" }, ({ payload }) => handlersRef.current.onPaired?.(String(payload.room_code)))
        .on("broadcast", { event: "unpaired" }, () => handlersRef.current.onUnpaired?.())
        .subscribe();
    }

    void subscribe();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId]);
}
