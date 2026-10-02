import { type Browser, type BrowserContext, devices, expect, type Page, test } from "@playwright/test";

// Slice 6a's "done when": a TV and three phones play a whole game of Heads Up on the scripted host, through the real
// pipeline (dispatcher, Agent Server, narrator). The card is a secret from one person, the guesser: so no phone may
// receive a card before its turn's recap, not on screen and not in any Realtime message. Only the TV shows it.

type Phone = { name: string; context: BrowserContext; page: Page; frames: { at: number; text: string }[] };

function watchCsp(page: Page, violations: string[]) {
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(msg.text())) violations.push(msg.text());
  });
}

/** Every Realtime message a phone receives, decoded (broadcasts come in Realtime's binary framing), with when. */
function recordFrames(page: Page, frames: { at: number; text: string }[]) {
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
    let text = typeof payload === "string" ? payload : "";
    if (typeof payload !== "string" && payload[0] === 4) {
      text = payload.subarray(5 + payload[1] + payload[2] + payload[3]).toString("utf8");
    }
    if (text) frames.push({ at: Date.now(), text });
  }));
}

async function newPhone(browser: Browser, name: string, violations: string[]): Promise<Phone> {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await context.newPage();
  watchCsp(page, violations);
  const frames: { at: number; text: string }[] = [];
  recordFrames(page, frames);
  return { name, context, page, frames };
}

/** The host's skip from the drawer, if that button is there right now (the phase may move on by itself). */
async function hostSkip(page: Page, label: string) {
  await page.getByRole("button", { name: "Host controls" }).click();
  const button = page.getByRole("button", { name: label });
  if (await button.isEnabled().catch(() => false)) await button.click({ timeout: 2_000 }).catch(() => {});
  await page.getByRole("button", { name: "Close host controls" }).click();
}

/** Points per player, as a leaderboard shows them. */
async function board(page: Page, names: string[]): Promise<Record<string, string>> {
  const rows: Record<string, string> = {};
  for (const row of await page.getByTestId("leader").all()) {
    const text = await row.innerText();
    const name = names.find((n) => text.includes(n));
    if (name) rows[name] = text.trim().split(/\s+/).pop() ?? "";
  }
  return rows;
}

/** Whether a Realtime message publishes this turn's recap (its headsup_turns row, now with its cards). */
function isRecap(text: string, turn: number): boolean {
  const find = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(find);
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    const record = o.record as Record<string, unknown> | undefined;
    if (o.table === "headsup_turns" && record?.number === turn && record.cards) return true;
    return Object.values(o).some(find);
  };
  try {
    return find(JSON.parse(text));
  } catch {
    return false;
  }
}

function mentions(text: string, card: string): boolean {
  const escaped = card.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

test("a TV and three phones play Heads Up, and no phone ever gets a live card", async ({ browser }) => {
  test.setTimeout(300_000);
  const cspViolations: string[] = [];

  const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvContext.newPage();
  watchCsp(tv, cspViolations);
  await tv.goto("/tv");
  const pairingCode = tv.getByTestId("pairing-code");
  await expect(pairingCode).toHaveText(/^[A-HJ-NP-Z2-9]{6}$/, { timeout: 30_000 });
  const tvCode = (await pairingCode.textContent()) ?? "";

  const host = await newPhone(browser, "Priya", cspViolations);
  const runId = crypto.randomUUID();
  await host.page.goto("/login?next=/host");
  await host.page.getByRole("button", { name: "New here? Create a host account" }).click();
  await host.page.getByLabel("Your name").fill("Priya");
  await host.page.getByLabel("Email").fill(`e2e-hu-${runId.slice(0, 8)}@gamenight.test`);
  await host.page.getByLabel("Password").fill(`e2e-${runId}`);
  await host.page.getByRole("button", { name: "Create host account" }).click();
  await expect(host.page).toHaveURL(/\/host$/);
  await host.page.getByLabel("Your nickname in the game").fill("Priya");
  await host.page.getByRole("button", { name: "Create room" }).click();
  await expect(host.page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
  await host.page.getByLabel("TV code").fill(tvCode);
  await host.page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tv).toHaveURL(/\/tv\/[A-Z0-9]{6}$/);
  const joinUrl = (await tv.getByTestId("join-qr").getAttribute("data-join-url")) ?? "";

  const phones: Phone[] = [host];
  for (const name of ["Asha", "Ben"]) {
    const guest = await newPhone(browser, name, cspViolations);
    await guest.page.goto(joinUrl);
    await guest.page.getByLabel("Your nickname").fill(name);
    await guest.page.getByRole("button", { name: "Join the room" }).click();
    await expect(guest.page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
    phones.push(guest);
  }

  // Interests: Asha picks two chips, Ben types one; the TV shows them.
  const interests = (page: Page) => page.getByRole("group", { name: "Heads Up interests" });
  await interests(phones[1].page).getByRole("button", { name: "Cricket" }).click();
  await expect(phones[1].page.getByTestId("my-interests")).toHaveText("Cricket");
  await interests(phones[1].page).getByRole("button", { name: "Food" }).click();
  await expect(phones[1].page.getByTestId("my-interests")).toHaveText("Cricket, Food");
  await phones[2].page.getByLabel("Your own interest").fill("Animals");
  await phones[2].page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(phones[2].page.getByTestId("my-interests")).toHaveText("Animals");
  await expect(tv.getByTestId("player-interests")).toHaveCount(2);

  // The host starts Heads Up: one turn each, 45 seconds.
  await host.page.getByRole("tab", { name: "Heads Up" }).click();
  await host.page.getByRole("button", { name: "45 seconds" }).click();
  await host.page.getByRole("button", { name: "Start Heads Up" }).click();
  await expect(tv.getByTestId("headsup-tv")).toBeVisible({ timeout: 30_000 });
  for (const phone of phones) await expect(phone.page.getByTestId("headsup-phone")).toBeVisible();

  const shownAt = new Map<string, number>();     // card -> when the TV first showed it
  const recapAt = new Map<number, number>();     // turn -> when its recap appeared on the TV
  const cardTurn = new Map<string, number>();    // card -> its turn
  const phoneTextsWhileLive: { card: string; text: string; who: string }[] = [];
  const tapsIn = new Map<number, number>();     // turn -> taps the test made (the guesser's 4, then the host ends it)
  let reloaded = false;
  let paused = false;

  const deadline = Date.now() + 240_000;
  while (!(await tv.getByTestId("final-scores").isVisible())) {
    expect(Date.now(), "the game should finish").toBeLessThan(deadline);
    const phase = await tv.getByTestId("headsup-tv").getAttribute("data-phase");
    const turn = Number(await tv.getByTestId("headsup-tv").getAttribute("data-turn"));

    if (phase === "ready") await hostSkip(host.page, "Start now");  // no need to wait out the countdown

    if (phase === "guessing") {
      const live = tv.getByTestId("tv-live");  // the TV states its live card here (the shown text animates)
      const card = ((await live.getAttribute("data-card").catch(() => "")) ?? "").trim();
      if (card) {
        if (!shownAt.has(card)) {
          shownAt.set(card, Date.now());
          cardTurn.set(card, turn);
        }
        // While it's live, no phone shows it: not the guesser, not anyone.
        for (const phone of phones) {
          const text = await phone.page.locator("body").innerText();
          phoneTextsWhileLive.push({ card, text, who: phone.name });
        }

        // Once: the TV reloads mid-turn and gets the card back (a TV, and only a TV, may ask for it).
        if (!reloaded && shownAt.size >= 2) {
          reloaded = true;
          await tv.reload();
          await expect(tv.getByTestId("tv-live")).toHaveAttribute("data-card", card, { timeout: 15_000 });
        }
        // Once: the host pauses mid-turn; the TV hides the card until they resume.
        if (!paused && shownAt.size >= 3) {
          paused = true;
          await host.page.getByRole("button", { name: "Host controls" }).click();
          await host.page.getByRole("button", { name: "Pause" }).click();
          await expect(tv.getByText("Paused by the host")).toBeVisible();
          await expect(tv.getByTestId("tv-live")).toHaveCount(0);
          await host.page.getByRole("button", { name: "Resume" }).click();
          await expect(tv.getByTestId("tv-live")).toHaveAttribute("data-card", card);
          await host.page.getByRole("button", { name: "Close host controls" }).click();
        }

        // The guesser taps: Got it, Got it, Pass, Got it, then the host ends the turn.
        const guesser = await (async () => {
          for (const phone of phones) {
            if ((await phone.page.getByTestId("headsup-phone").getAttribute("data-guesser")) === "true") return phone;
          }
          return null;
        })();
        expect(guesser, "someone is guessing").not.toBeNull();
        const taps = tapsIn.get(turn) ?? 0;
        if (guesser && taps < 4) {
          tapsIn.set(turn, taps + 1);
          await guesser.page.getByRole("button", { name: taps === 2 ? "Pass" : "Got it" }).click();
          await expect(tv.getByTestId("tv-live")).not.toHaveAttribute("data-card", card, { timeout: 10_000 });
        } else {
          await hostSkip(host.page, "End the turn");
        }
      }
    }

    if (phase === "recap" && !recapAt.has(turn)) {
      recapAt.set(turn, Date.now());
      await expect(tv.getByTestId("tv-recap-card").first()).toBeVisible();
    }
    await tv.waitForTimeout(200);
  }

  // Every turn happened (one each), with its cards recapped on the TV.
  expect(recapAt.size, "three turns, each with its recap").toBe(3);
  expect(shownAt.size).toBeGreaterThanOrEqual(9);

  // No phone showed a live card.
  for (const { card, text, who } of phoneTextsWhileLive) {
    expect(mentions(text, card), `${who}'s phone showed "${card}" while it was live`).toBe(false);
  }
  // No phone was sent a card before its turn's recap: in each phone's own message order, nothing mentions a card
  // before the message that makes its turn's cards public. (No clocks: the order is what the phone received.)
  for (const phone of phones) {
    for (const [card, turn] of cardTurn) {
      const recap = phone.frames.findIndex((f) => isRecap(f.text, turn));
      expect(recap, `${phone.name}'s phone got turn ${turn}'s recap`).toBeGreaterThanOrEqual(0);
      const early = phone.frames.slice(0, recap).find((f) => mentions(f.text, card));
      expect(early?.text.slice(0, 200), `${phone.name}'s phone was sent "${card}" before turn ${turn}'s recap`).toBeUndefined();
    }
  }

  // The end: the podium, and the same totals on the TV and every phone.
  await expect(tv.getByTestId("podium-place").first()).toBeVisible();
  for (const phone of phones) await expect(phone.page.getByTestId("final-scores")).toBeVisible({ timeout: 30_000 });
  const names = phones.map((p) => p.name);
  const tvBoard = await board(tv, names);
  expect(Object.keys(tvBoard).sort()).toEqual([...names].sort());
  for (const phone of phones) expect(await board(phone.page, names), `${phone.name}'s final scores`).toEqual(tvBoard);

  expect(reloaded && paused, "the TV reload and the pause both happened").toBe(true);
  expect(cspViolations, "the Heads Up screens run under the strict CSP").toEqual([]);

  await host.page.getByRole("button", { name: "Play again" }).click();
  await expect(host.page.getByRole("button", { name: "Start Undercover" })).toBeVisible();
});
