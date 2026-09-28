import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import type { GameFilters, GameStore } from "./games.ts";
import { withRequestSpan } from "./telemetry.ts";

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Constant-time comparison, so response timing can't reveal how much of a token was right. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A positive whole number up to max, or undefined when absent; null when present but invalid. */
function count(value: string | null, max: number): number | undefined | null {
  if (value === null || value === "") return undefined;
  return /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= max ? Number(value) : null;
}

/**
 * The catalog's HTTP server. /healthz is open; /v1/games needs the internal service token (the agents
 * call it to suggest games). The MCP server for outside agents arrives in slice 9.
 */
export function createCatalogServer(deps?: { games: GameStore; serviceToken: string }): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://catalog");
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { status: "ok", service: "catalog" });
    }
    if (request.method === "GET" && url.pathname === "/v1/games" && deps) {
      return withRequestSpan(request, "/v1/games", async (span) => {
        if (!tokenMatches(request.headers.authorization, deps.serviceToken)) {
          return json(response, 401, { error: "unauthorized" });
        }
        const filters: GameFilters = {};
        const players = count(url.searchParams.get("players"), 16);
        const minutes = count(url.searchParams.get("minutes"), 600);
        if (players === null || minutes === null) {
          return json(response, 400, { error: "players must be 1-16 and minutes 1-600" });
        }
        if (players) filters.players = players;
        if (minutes) filters.minutes = minutes;
        try {
          const games = await deps.games.list(filters);
          span.setAttribute("gamenight.games", games.length);
          return json(response, 200, { games });
        } catch (error) {
          console.error("catalog: listing games failed", error);
          return json(response, 503, { error: "catalogue unavailable" });
        }
      });
    }
    return json(response, 404, { error: "not found" });
  });
}
