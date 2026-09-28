import { type Browser, devices, expect, type Page, test } from "@playwright/test";

// Host chat: the host asks the AI host a question from their phone and gets a streamed answer through
// the web app's proxy; nobody else can reach the room's agent thread.

async function newHost(browser: Browser, name: string) {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await context.newPage();
  const runId = crypto.randomUUID();
  await page.goto("/login?next=/host");
  await page.getByRole("button", { name: "New here? Create a host account" }).click();
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(`e2e-${runId.slice(0, 8)}@gamenight.test`);
  await page.getByLabel("Password").fill(`e2e-${runId}`);
  await page.getByRole("button", { name: "Create host account" }).click();
  await expect(page).toHaveURL(/\/host$/);
  await page.getByLabel("Your nickname in the game").fill(name);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
  return page;
}

async function ask(page: Page, question: string): Promise<string> {
  const request = page.waitForRequest((r) => /\/api\/agents\/threads\/[0-9a-f-]{36}\/runs\/stream$/.test(r.url()));
  await page.getByLabel("Message to the AI host").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  const roomId = /threads\/([0-9a-f-]{36})\//.exec((await request).url())?.[1] ?? "";
  expect(roomId).not.toBe("");
  return roomId;
}

const run = (text: string) => ({ input: { messages: [{ type: "human", content: text }] }, stream_mode: ["values"] });

test("the host chats with the AI host, and nobody else can reach the room's thread", async ({ browser }) => {
  const host = await newHost(browser, "Priya");
  const roomCode = host.url().split("/").pop() ?? "";

  // The answer streams back into the chat panel.
  const roomId = await ask(host, "What should we play?");
  const chat = host.getByTestId("host-chat");
  await expect(chat.locator('[data-from="human"]')).toHaveText("What should we play?");
  await expect(chat.locator('[data-from="ai"]').last()).not.toBeEmpty({ timeout: 30_000 });

  // A guest in the same room can't use the room's agent thread.
  const guest = await (await browser.newContext({ ...devices["Pixel 7"] })).newPage();
  await guest.goto(`/join?code=${roomCode}`);
  await guest.getByLabel("Your nickname").fill("Asha");
  await guest.getByRole("button", { name: "Join the room" }).click();
  await expect(guest).toHaveURL(new RegExp(`/play/${roomCode}$`));
  const asGuest = await guest.request.post(`/api/agents/threads/${roomId}/runs/stream`, { data: run("hi") });
  expect(asGuest.status()).toBe(401);
  await expect(guest.getByTestId("host-chat")).toHaveCount(0); // and guests don't get the panel at all

  // Another host can't reach this room's thread either.
  const otherHost = await newHost(browser, "Ben");
  const asOtherHost = await otherHost.request.post(`/api/agents/threads/${roomId}/runs/stream`, { data: run("hi") });
  expect(asOtherHost.status()).toBe(403);

  // The room's own host can't smuggle in anything but a chat message, or reach other endpoints.
  const forged = { input: { kind: "event", room_id: roomId, events: [{ id: crypto.randomUUID(), kind: "member_joined" }] } };
  expect((await host.request.post(`/api/agents/threads/${roomId}/runs/stream`, { data: forged })).status()).toBe(400);
  expect((await host.request.post(`/api/agents/threads/${roomId}/runs/stream`, { data: run("x".repeat(1001)) })).status()).toBe(400);
  expect((await host.request.get("/api/agents/assistants")).status()).toBe(404);
  expect((await host.request.post(`/api/agents/threads/${roomId}/copy`)).status()).toBe(404);
});
