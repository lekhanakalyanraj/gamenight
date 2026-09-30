"use client";

import type { Game, GameAction, GamePlayer, GameResult } from "@gamenight/db-types";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

import { type Card, fromRow, GAME_SELECT, type LiveGame } from "@/lib/game";
import {
  LOBBY_SELECT, type LobbyClip, type LobbyDisplay, type LobbyHostLine, type LobbyMember, type LobbyRoom,
} from "@/lib/room";
import { useSupabase } from "@/lib/supabase/client";

/** What each device announces on the room's presence channel. Never trusted for names or game logic. */
export type Presence = { member_id: string } | { kind: "tv" };

export type Lobby = {
  room: LobbyRoom;
  members: LobbyMember[];
  displays: LobbyDisplay[];
  hostLines: LobbyHostLine[];
  /** Audio for recent lines, as it arrives (live only: a clip that's late isn't worth playing, so never re-read). */
  clips: LobbyClip[];
  /** The room's latest game, running or ended. */
  game: LiveGame | null;
};

/** Whether a broadcast shows we missed something (a game we haven't seen, or a skipped step): re-read. */
function showsGap(lobby: Lobby, change: Change): boolean {
  if (change.table !== "games" || !change.record) return false;
  const game = change.record as Game;
  const current = lobby.game?.game;
  if (!current || current.id !== game.id) return !current || game.created_at >= current.created_at;
  return game.step > current.step + 1;
}

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

function applyGameChange(lobby: Lobby, change: Change): Lobby {
  const current = lobby.game;
  const row = change.record;
  if (!row) return lobby;
  if (change.table === "games") {
    const game = row as Game;
    if (!current || current.game.id !== game.id) {
      // A game we haven't seen: its players and results come with the re-read (see showsGap).
      const newer = !current || game.created_at >= current.game.created_at;
      return newer ? { ...lobby, game: { game, players: [], results: [] } } : lobby;
    }
    if (game.step < current.game.step) return lobby; // a late broadcast: never go backwards
    return { ...lobby, game: { ...current, game: { ...current.game, ...game } } };
  }
  if (!current || row.game_id !== current.game.id) return lobby;
  if (change.table === "game_players") {
    const player = row as GamePlayer;
    const players = current.players.some((p) => p.member_id === player.member_id)
      ? current.players.map((p) => (p.member_id === player.member_id ? { ...p, ...player } : p))
      : [...current.players, player];
    return { ...lobby, game: { ...current, players } };
  }
  return { ...lobby, game: { ...current, results: upsert(current.results, row as GameResult) } };
}

const MAX_CLIPS = 30;

function applyChange(lobby: Lobby, change: Change): Lobby {
  if (change.table === "games" || change.table === "game_players" || change.table === "game_results") {
    return applyGameChange(lobby, change);
  }
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
    case "host_lines":
      return row ? { ...lobby, hostLines: upsert(lobby.hostLines, row as LobbyHostLine) } : lobby;
    case "clips": {
      const clip = row as LobbyClip | null;
      if (!clip || lobby.clips.some((c) => c.line_id === clip.line_id)) return lobby;
      return { ...lobby, clips: [...lobby.clips, clip].slice(-MAX_CLIPS) };
    }
    default:
      return lobby;
  }
}

/**
 * Keeps a room live, lobby and game: database changes arrive as broadcasts on the private `room:{id}`
 * topic, and presence says who's connected. Broadcasts can be missed (a phone offline, or Realtime
 * restarting), so the room is re-read on every (re)subscribe, when the tab comes back to the foreground,
 * and when a broadcast shows a gap: events are for speed, the re-read is for correctness.
 */
export function useLiveRoom(initial: Lobby, presence: Presence): LiveRoom {
  const [lobby, setLobby] = useState<Lobby>(initial);
  const lobbyRef = useRef(lobby);
  useEffect(() => {
    lobbyRef.current = lobby;
  });
  const [gone, setGone] = useState(false);
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());
  const [tvOnline, setTvOnline] = useState(false);
  const [connected, setConnected] = useState(false);
  const presenceRef = useRef(presence);
  const roomId = initial.room.id;
  const supabase = useSupabase();

  const refetch = useCallback(async () => {
    const [{ data }, { data: game }] = await Promise.all([
      supabase.from("rooms").select(LOBBY_SELECT).eq("id", roomId).maybeSingle(),
      supabase.from("games").select(GAME_SELECT).eq("room_id", roomId).order("created_at", { ascending: false })
        .limit(1).maybeSingle(),
    ]);
    if (!data) {
      setGone(true);
      return;
    }
    const { room_members, room_displays, host_lines, ...room } = data;
    setLobby((current) => ({
      room, members: room_members, displays: room_displays, hostLines: host_lines, clips: current.clips,
      game: game ? fromRow(game) : null,
    }));
  }, [roomId, supabase]);

  // The tab coming back to the foreground: re-read (a gap in the broadcasts is caught where they arrive).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    async function subscribe() {
      await supabase.realtime.setAuth(); // private topics authorise with the signed-in user's JWT
      if (cancelled) return;
      const ch = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { enabled: true } } });
      channel = ch;
      ch.on("broadcast", { event: "*" }, ({ payload }) => {
          const change = payload as Change;
          const gap = showsGap(lobbyRef.current, change);
          setLobby((current) => applyChange(current, change));
          if (gap) void refetch();
        })
        .on("presence", { event: "sync" }, () => {
          const everyone = Object.values(ch.presenceState<Presence>()).flat();
          setOnline(new Set(everyone.flatMap((p) => ("member_id" in p ? [p.member_id] : []))));
          setTvOnline(everyone.some((p) => "kind" in p && p.kind === "tv"));
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            setConnected(true);
            await ch.track(presenceRef.current);
            if (!cancelled) await refetch();
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
  }, [roomId, supabase, refetch]);

  const { room, members, displays, hostLines, clips, game } = lobby;
  return { room, members, displays, hostLines, clips, game, online, tvOnline, connected, gone };
}

/** A TV's own private topic: the database tells it when it's been paired to a room or disconnected. */
export function useDisplayEvents(
  userId: string | null,
  handlers: { onPaired?: (roomCode: string) => void; onUnpaired?: () => void },
) {
  const handlersRef = useRef(handlers);
  const supabase = useSupabase();
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!userId) return;
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
  }, [userId, supabase]);
}

/**
 * A player's own card and moves, on their private `member:{id}` topic: RLS lets only that player join it
 * or read those rows. Re-read on subscribe, when the tab returns, and on request (a missed card).
 */
export function usePrivateGame(memberId: string, gameId: string | null) {
  const [card, setCard] = useState<Card | null>(null);
  const [moves, setMoves] = useState<GameAction[]>([]);
  const supabase = useSupabase();

  const refetch = useCallback(async () => {
    if (!gameId) {
      setCard(null);
      setMoves([]);
      return;
    }
    const [{ data: secret }, { data: actions }] = await Promise.all([
      supabase.from("secrets").select("payload").eq("game_id", gameId).eq("member_id", memberId).maybeSingle(),
      supabase.from("game_actions").select("*").eq("game_id", gameId).eq("member_id", memberId),
    ]);
    setCard((secret?.payload as Card | undefined) ?? null);
    setMoves(actions ?? []);
  }, [gameId, memberId, supabase]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    async function subscribe() {
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channel = supabase
        .channel(`member:${memberId}`, { config: { private: true } })
        .on("broadcast", { event: "*" }, ({ payload }) => {
          const change = payload as Change;
          const row = change.record;
          if (!row || row.game_id !== gameId) return;
          if (change.table === "secrets") setCard(row.payload as Card);
          if (change.table === "game_actions") setMoves((current) => upsert(current, row as GameAction));
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED" && !cancelled) void refetch();
        });
    }

    void subscribe();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [memberId, gameId, supabase, refetch]);

  const addMove = useCallback((move: GameAction) => setMoves((current) => upsert(current, move)), []);
  return { card, moves, refetch, addMove };
}
