import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { createCatalogServer } from "../src/server.ts";

const server = createCatalogServer();
let base = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("/healthz reports ok", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "catalog" });
});

test("other paths are not found", async () => {
  assert.equal((await fetch(`${base}/`)).status, 404);
});
