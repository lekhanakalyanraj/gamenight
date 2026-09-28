import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import type { GameFilters } from "../src/games.ts";
import { createCatalogServer } from "../src/server.ts";

const seen: GameFilters[] = [];
const games = {
  async list(filters: GameFilters) {
    seen.push(filters);
    return [{ slug: "undercover", name: "Undercover", min_players: 3, max_players: 16, minutes: 20, summary: "..." }];
  },
  async close() {},
};
const server = createCatalogServer({ games, serviceToken: "test-token" });
let base = "";
const auth = { headers: { authorization: "Bearer test-token" } };
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("/healthz reports ok without a token", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "catalog" });
});

test("/v1/games needs the service token", async () => {
  assert.equal((await fetch(`${base}/v1/games`)).status, 401);
  assert.equal((await fetch(`${base}/v1/games`, { headers: { authorization: "Bearer wrong-token" } })).status, 401);
  assert.equal((await fetch(`${base}/v1/games`, { headers: { authorization: "Bearer test-toke" } })).status, 401);
});

test("/v1/games filters by players and minutes", async () => {
  const response = await fetch(`${base}/v1/games?players=5&minutes=30`, auth);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).games[0].slug, "undercover");
  assert.deepEqual(seen.at(-1), { players: 5, minutes: 30 });
});

test("/v1/games rejects nonsense filters", async () => {
  for (const query of ["players=0", "players=17", "players=abc", "minutes=-5", "players=1;drop"]) {
    assert.equal((await fetch(`${base}/v1/games?${query}`, auth)).status, 400, query);
  }
});

test("other paths are not found", async () => {
  assert.equal((await fetch(`${base}/`)).status, 404);
});
