import { type Browser, type BrowserContext, devices, expect, type Locator, type Page, test } from "@playwright/test";

// Slice 3's "done when", on screens: a TV and five phones play a whole game of Undercover on the scripted
// game master (the same pipeline as production: dispatcher, Agent Server, narrator), and nothing secret
// shows where it shouldn't. Every phone plays by reading its own screen, as a person would.

type Phone = { name: string; context: BrowserContext; page: Page };

async function newPhone(browser: Browser, name: string, violations: string[]): Promise<Phone> {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await context.newPage();
  watchCsp(page, violations);
  return { name, context, page };
}

/** Clicks if it's there right now; the screen may move on between looking and tapping, which is fine. */
async function tapIfShown(target: Locator): Promise<boolean> {
  if (!(await target.isVisible())) return false;
  try {
    await target.click({ timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** Collects CSP violations the browser reports: the animated game screens must run under the strict CSP. */
function watchCsp(page: Page, violations: string[]) {
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(msg.text())) violations.push(msg.text());
  });
}

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}(e?s)?\\b`, "i").test(text);
}

test("a TV and five phones play a whole game, and nothing secret shows", async ({ browser }) => {
  test.setTimeout(300_000);

  // The TV pairs with the host's room, and four guests join from the QR address (as in the lobby test).
  const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvContext.newPage();
  const cspViolations: string[] = [];
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
  await host.page.getByLabel("Email").fill(`e2e-uc-${runId.slice(0, 8)}@gamenight.test`);
  await host.page.getByLabel("Password").fill(`e2e-${runId}`);
  await host.page.getByRole("button", { name: "Create host account" }).click();
  await expect(host.page).toHaveURL(/\/host$/);
  await host.page.getByLabel("Your nickname in the game").fill("Priya");
  await host.page.getByRole("button", { name: "Create room" }).click();
  await expect(host.page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
  await host.page.getByLabel("TV code").fill(tvCode);
  await host.page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(host.page.getByText("TV connected.")).toBeVisible();
  await expect(tv).toHaveURL(/\/tv\/[A-Z0-9]{6}$/);
  const joinUrl = (await tv.getByTestId("join-qr").getAttribute("data-join-url")) ?? "";

  // The AI host's voice: browsers block sound until someone taps, so the TV asks once. The host can turn it off
  // (the TV shows it's off) and on again.
  const narrator = tv.getByTestId("narrator");
  await expect(narrator).toHaveAttribute("data-state", "locked");
  await narrator.click();
  await expect(narrator).toHaveAttribute("data-state", /ready|speaking/);
  await expect(narrator).toContainText("AI voice");
  await host.page.getByTestId("voice-switch").click();
  await expect(narrator).toHaveAttribute("data-state", "off");
  await host.page.getByTestId("voice-switch").click();
  await expect(narrator).toHaveAttribute("data-state", /ready|speaking/);

  const phones: Phone[] = [host];
  for (const name of ["Asha", "Ben", "Chen", "Dara"]) {
    const guest = await newPhone(browser, name, cspViolations);
    await guest.page.goto(joinUrl);
    await guest.page.getByLabel("Your nickname").fill(name);
    await guest.page.getByRole("button", { name: "Join the room" }).click();
    await expect(guest.page).toHaveURL(/\/play\/[A-Z0-9]{6}$/);
    phones.push(guest);
  }

  // The host starts Undercover; every screen switches to the game.
  await host.page.getByRole("group", { name: "Theme for the secret words" }).getByRole("button", { name: "Food" }).click();
  await host.page.getByRole("button", { name: "Start Undercover" }).click();
  await expect(tv.getByTestId("tv-game")).toBeVisible({ timeout: 30_000 });
  for (const phone of phones) await expect(phone.page.getByTestId("phone-game")).toBeVisible();

  // The opening line is spoken: its clip arrives, downloads with the TV's login, and plays to the end.
  await expect.poll(async () => Number(await narrator.getAttribute("data-played")), { timeout: 30_000 }).toBeGreaterThan(0);

  // Each phone peeks at its card once (hold, read, let go): it must turn face down again at once.
  const cards = new Map<string, string>();
  const tvSeen: string[] = [];
  const phonesSeen: string[] = [];
  let paused = false;
  let wentOffline = false;
  let reloaded = false;

  const deadline = Date.now() + 240_000;
  while ((await tv.getByTestId("tv-game").getAttribute("data-phase")) !== "ended") {
    expect(Date.now(), "the game should finish").toBeLessThan(deadline);
    tvSeen.push(await tv.locator("body").innerText());
    const tvPhase = await tv.getByTestId("tv-game").getAttribute("data-phase");

    for (const phone of phones) {
      const { page, name } = phone;
      if (!(await page.getByTestId("phone-game").isVisible())) continue;
      phonesSeen.push(await page.locator("body").innerText());

      const card = page.getByTestId("card");
      // Held with Space on the focused card (the card's keyboard hold): a press at the card's on-screen position
      // could land beside it when a caption arriving shifts the page, which flaked in the slower cluster.
      if (!cards.has(name) && (await card.isVisible()) && tvPhase !== "setup") {
        await card.focus();
        await page.keyboard.down("Space");
        await expect(card).toHaveAttribute("data-showing", "true");
        await expect(page.getByTestId("card-face")).not.toHaveText("Dealing…");
        cards.set(name, ((await page.getByTestId("card-face").textContent()) ?? "").trim());
        await page.keyboard.up("Space");
        await expect(card).toHaveAttribute("data-showing", "false");
      }

      // The host pauses once during the clues: the TV says so, and the game holds until they resume.
      if (name === "Priya" && !paused && tvPhase === "clues" && (await page.getByTestId("your-turn").isHidden())) {
        paused = true;
        await page.getByRole("button", { name: "Host controls" }).click();
        await page.getByRole("button", { name: "Pause" }).click();
        await expect(tv.getByText("Paused by the host")).toBeVisible();
        await page.getByRole("button", { name: "Resume" }).click();
        await expect(tv.getByText("Paused by the host")).toBeHidden();
        await page.getByRole("button", { name: "Close host controls" }).click();
      }

      // The TV reloads mid-game once: the page is rendered on the server again, then catches up.
      if (!reloaded && wentOffline) {
        reloaded = true;
        await tv.reload();
        await expect(tv.getByTestId("tv-game")).toBeVisible({ timeout: 30_000 });
        await narrator.click(); // a reloaded page needs the tap again before it may play sound
      }

      await tapIfShown(page.getByRole("button", { name: "Done", exact: true }));
      if (await page.getByTestId("vote").isVisible()) {
        // Asha's phone drops off mid-vote and comes back: it must catch up by itself and still vote. (Checked here,
        // just before she votes: the vote can open within this pass, right after the last clue's Done.)
        if (name === "Asha" && !wentOffline) {
          wentOffline = true;
          await phone.context.setOffline(true);
          await page.waitForTimeout(3_000);
          await phone.context.setOffline(false);
          await expect(page.getByTestId("phone-game")).toHaveAttribute("data-phase", /vote|clues|guess|ended/, { timeout: 30_000 });
        }
        await tapIfShown(page.getByTestId("vote").getByRole("button").first());
        await tapIfShown(page.getByRole("button", { name: /^Vote for / }));
      }
      if (await page.getByTestId("guess").isVisible()) {
        await page.getByLabel("Your guess").fill("pizza");
        await tapIfShown(page.getByRole("button", { name: "Guess", exact: true }));
      }
      if (name === "Priya") await tapIfShown(page.getByRole("button", { name: "Agree" }));
    }
    await tv.waitForTimeout(300);
  }

  // The end: the TV reveals both words and every role, and every phone shows the same reveal.
  await expect(tv.getByTestId("final-reveal")).toBeVisible();
  const revealText = await tv.getByTestId("final-reveal").innerText({ timeout: 10_000 });
  await expect(tv.getByTestId("reveal-player")).toHaveCount(5);
  const words = [...revealText.matchAll(/(?:Civilians'|Undercover) word\s*\n\s*(.+)/g)].map((m) => m[1].trim());
  expect(words).toHaveLength(2);

  // Nothing before the end mentioned either word: not the TV, and not a phone with its card face down.
  for (const text of tvSeen) for (const word of words) expect(mentions(text, word), `the TV showed "${word}"`).toBe(false);
  for (const text of phonesSeen) for (const word of words) expect(mentions(text, word), `a phone showed "${word}"`).toBe(false);

  // Each phone was dealt the card its revealed role says: its own, and only its own.
  expect(cards.size).toBe(5);
  for (const [name, face] of cards) {
    const row = tv.getByTestId("reveal-player").filter({ hasText: name });
    const role = (await row.innerText()).split("\n").pop()?.trim();
    const expected = role === "Mr. White" ? "You're Mr. White" : role === "undercover" ? words[1] : words[0];
    expect(face, `${name}'s card`).toBe(expected);
  }
  expect({ paused, wentOffline, reloaded }, "the pause, the dropped phone and the TV reload all happened")
    .toEqual({ paused: true, wentOffline: true, reloaded: true });
  expect(cspViolations, "the game screens run under the strict CSP").toEqual([]);

  // Play again: the host goes back to the lobby, ready to start another game.
  await host.page.getByRole("button", { name: "Play again" }).click();
  await expect(host.page.getByRole("button", { name: "Start Undercover" })).toBeVisible();
});
