import postgres from "postgres";

export type Game = {
  slug: string;
  name: string;
  min_players: number;
  max_players: number;
  minutes: number;
  summary: string;
};

export type GameFilters = { players?: number; minutes?: number };

export type GameStore = { list(filters: GameFilters): Promise<Game[]>; close(): Promise<void> };

/** Reads catalog.games as catalog_svc, which can read nothing else (see the service-isolation pgTAP test). */
export function postgresGames(databaseUrl: string): GameStore {
  const sql = postgres(databaseUrl, { max: 5, idle_timeout: 30 });
  return {
    async list({ players, minutes }) {
      return sql<Game[]>`
        select slug, name, min_players, max_players, minutes, summary
        from catalog.games
        where (${players ?? null}::int is null or ${players ?? null}::int between min_players and max_players)
          and (${minutes ?? null}::int is null or minutes <= ${minutes ?? null}::int)
        order by name`;
    },
    async close() {
      await sql.end();
    },
  };
}
