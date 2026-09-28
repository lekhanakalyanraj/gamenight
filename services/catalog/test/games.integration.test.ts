import assert from "node:assert/strict";
import { test } from "node:test";

import { postgresGames } from "../src/games.ts";

// Against the local Supabase database as catalog_svc (skipped when it isn't running).
const url = process.env.CATALOG_DATABASE_URL ?? "postgresql://catalog_svc:local-dev-catalog@127.0.0.1:55422/postgres";

test("the catalogue reads real games as catalog_svc", async (t) => {
  const games = postgresGames(url);
  t.after(() => games.close());
  let all;
  try {
    all = await games.list({});
  } catch {
    t.skip("local Supabase database not running");
    return;
  }
  assert.deepEqual(all.map((g) => g.slug).sort(), ["heads-up", "mafia", "quiz-night", "undercover"]);
  const fourPlayers = await games.list({ players: 4 });
  assert.ok(!fourPlayers.some((g) => g.slug === "mafia"), "Mafia needs at least 5 players");
});
