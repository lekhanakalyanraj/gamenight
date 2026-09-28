import { type Browser, devices, expect, type Page, test } from "@playwright/test";

// Slice 1's "done when": a TV and five phones share one live lobby, from pairing to closing.

async function newPhone(browser: Browser) {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  return { context, page: await context.newPage() };
}

/** The lobby on `page` lists exactly `names`, and (if given) exactly `online` are marked online. */
async function expectPlayers(page: Page, names: string[], online?: string[]) {
  const tiles = page.getByTestId("player");
  const nicknames = (onlineOnly: boolean) =>
    tiles.evaluateAll(
      (els, onlyOnline) =>
        els
          .filter((el) => !onlyOnline || el.getAttribute("data-online") === "true")
          .map((el) => el.getAttribute("data-nickname"))
          .sort(),
      onlineOnly,
    );
  await expect.poll(() => nicknames(false)).toEqual([...names].sort());
  if (online) await expect.poll(() => nicknames(true)).toEqual([...online].sort());
}

test("a TV and five phones share one live lobby", async ({ browser }) => {
  // The TV shows a pairing code. It never signs in; it gets an anonymous identity.
  const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvContext.newPage();
  await tv.goto("/tv");
  const pairingCode = tv.getByTestId("pairing-code");
  await expect(pairingCode).toHaveText(/^[A-HJ-NP-Z2-9]{6}$/);
  const tvCode = (await pairingCode.textContent()) ?? "";

  // The host signs up on their phone (a fresh account per run keeps runs independent) and opens a room.
  const host = await newPhone(browser);
  const runId = crypto.randomUUID();
  await host.page.goto("/login?next=/host");
  await host.page.getByRole("button", { name: "New here? Create a host account" }).click();
  await host.page.getByLabel("Your name").fill("Priya");
  await host.page.getByLabel("Email").fill(`e2e-${runId.slice(0, 8)}@gamenight.test`);
  await host.page.getByLabel("Password").fill(`e2e-${runId}`);
  await host.page.getByRole("button", { name: "Create host account" }).click();
  await expect(host.page).toHaveURL(/\/host$/);
  await host.page.getByLabel("Your nickname in the game").fill("Priya");
  await host.page.getByRole("button", { name: "Create room" }).click();
  await expect(host.page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);

  // The host enters the TV's code; the TV switches to the room's lobby by itself.
  await host.page.getByLabel("TV code").fill(tvCode);
  await host.page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(host.page.getByText("TV connected.")).toBeVisible();
  await expect(tv).toHaveURL(/\/tv\/[A-Z0-9]{6}$/);
  const roomCode = (await tv.getByTestId("room-code").textContent()) ?? "";
  const joinUrl = (await tv.getByTestId("join-qr").getAttribute("data-join-url")) ?? "";
  expect(joinUrl).toMatch(new RegExp(`/join\\?code=${roomCode}$`));

  // Four guests follow the address in the TV's QR code.
  const names = ["Asha", "Ben", "Chen", "Dara"];
  const guests: Array<Awaited<ReturnType<typeof newPhone>> & { name: string }> = [];
  for (const name of names) {
    const guest = await newPhone(browser);
    await guest.page.goto(joinUrl);
    await guest.page.getByLabel("Your nickname").fill(name);
    await guest.page.getByRole("button", { name: "Join the room" }).click();
    await expect(guest.page).toHaveURL(new RegExp(`/play/${roomCode}$`));
    guests.push({ name, ...guest });
  }
  const [asha, , chen, dara] = guests;

  // Every screen shows the same five players, all online.
  const everyone = ["Priya", ...names];
  for (const page of [tv, host.page, ...guests.map((g) => g.page)]) {
    await expectPlayers(page, everyone, everyone);
  }

  // The joins went through the outbox, the dispatcher and the agents: the AI host welcomes them on the TV,
  // labelled as AI, and phones see the same line.
  const hostLine = tv.getByTestId("host-line");
  await expect(hostLine).toBeVisible({ timeout: 30_000 });
  await expect(hostLine).toContainText("AI host");
  await expect(asha.page.getByTestId("host-line")).toHaveText(((await hostLine.textContent()) ?? "").trim());

  // Dara's phone drops off: she stays in the room, and the TV dims her tile.
  await dara.context.close();
  await expectPlayers(tv, everyone, ["Priya", "Asha", "Ben", "Chen"]);

  // The host removes Chen: Chen is told, every lobby shrinks, and Chen can't get back in.
  await host.page.getByRole("button", { name: "Remove Chen" }).click();
  await host.page.getByRole("button", { name: "Confirm removing Chen" }).click();
  await expect(chen.page.getByText("The host removed you from this room")).toBeVisible();
  await expectPlayers(tv, ["Priya", "Asha", "Ben", "Dara"]);
  await expectPlayers(asha.page, ["Priya", "Asha", "Ben", "Dara"]);
  await chen.page.goto(joinUrl);
  await chen.page.getByLabel("Your nickname").fill("Chen again");
  await chen.page.getByRole("button", { name: "Join the room" }).click();
  // (Next.js adds its own empty role="alert" route announcer, so match on our message.)
  await expect(chen.page.getByRole("alert").filter({ hasText: "The host removed you from this room." })).toBeVisible();

  // The host closes the room (with a confirm step); the TV and phones all say so.
  await host.page.getByRole("button", { name: "Close room" }).click();
  await host.page.getByRole("button", { name: "Close room" }).click();
  await expect(tv.getByText("The host closed this room")).toBeVisible();
  await expect(asha.page.getByText("The host closed this room")).toBeVisible();
});
